import { afterEach, describe, expect, test, vi } from "bun:test";
import { isAcpOrHeadlessSession, renderProgressFrame, throttleFrames } from "../src/acp-bridge.js";
import { createWorkflowSnapshot, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "../src/display.js";

const meta = { name: "codebase-audit", description: "d", phases: [{ title: "Fan out" }, { title: "Synthesize" }] };

describe("acp-bridge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("session detection: no-UI ctx is treated as ACP/headless", () => {
    expect(isAcpOrHeadlessSession({ hasUI: false } as never)).toBe(true);
    expect(isAcpOrHeadlessSession({ hasUI: true } as never)).toBe(false);
    expect(isAcpOrHeadlessSession({} as never)).toBe(true); // 缺省视为无 UI
  });

  test("progress frame renders phase, agent counts, and next phase from real snapshot fields", () => {
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(meta));
    // 只注入快照真实字段：currentPhase + tokenUsage.total（workflow-manager 的
    // onPhase/onTokenUsage 写入），不注入 phaseIndex/tokenTotal 之类的幻影字段。
    snap.currentPhase = "Fan out";
    snap.runId = "r1";
    snap.tokenUsage = { input: 8000, output: 4400, total: 12400 };
    snap.agents = [
      { id: 1, label: "fanout:0:1", phase: "Fan out", prompt: "p", status: "done" },
      { id: 2, label: "fanout:0:2", phase: "Fan out", prompt: "p", status: "running" },
    ];
    snap.doneCount = 1;
    snap.runningCount = 1;
    snap.agentCount = 2;
    const frame = renderProgressFrame(snap);
    expect(frame).toContain("run r1");
    expect(frame).toContain("Phase 1/2: Fan out");
    expect(frame).toContain("1/2 agents");
    expect(frame).toContain("next: Synthesize");
    expect(frame).toContain("12.4k");
  });

  test("progress frame counts errored and skipped agents", () => {
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(meta));
    snap.currentPhase = "Synthesize";
    snap.agents = [
      { id: 1, label: "fanout:0:1", phase: "Fan out", prompt: "p", status: "error" },
      { id: 2, label: "fanout:0:2", phase: "Fan out", prompt: "p", status: "skipped" },
      { id: 3, label: "fanout:0:3", phase: "Fan out", prompt: "p", status: "done" },
    ];
    snap.doneCount = 1;
    snap.errorCount = 1;
    snap.agentCount = 3;
    const frame = renderProgressFrame(snap);
    expect(frame).toContain("1/3 agents");
    expect(frame).toContain("· 1 errors");
    expect(frame).toContain("· 1 skipped");
  });

  test("progress frame without currentPhase/tokenUsage omits next and Tokens", () => {
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(meta));
    const frame = renderProgressFrame(snap);
    expect(frame).toContain("run -"); // runId 未填时的占位
    expect(frame).not.toContain("next:");
    expect(frame).not.toContain("Tokens:");
  });

  test("frame throttle: at most one emit per interval, cross-window merge + trailing flush", () => {
    // 用 fake timers 驱动窗口，避免真实墙钟等待（bun 的 fake timers 同时 mock Date.now）。
    vi.useFakeTimers();
    let emits = 0;
    const throttled = throttleFrames(() => { emits += 1; }, 50);
    throttled(); throttled(); throttled();
    expect(emits).toBe(1); // 窗口内多次调用合并为一帧
    vi.advanceTimersByTime(50); // 窗口结束，尾帧补发一次
    expect(emits).toBe(2);
    vi.advanceTimersByTime(100);
    expect(emits).toBe(2); // 无新调用不再补发

    // 第二个窗口同样合并 + trailing 补发（跨窗口行为不退化）
    throttled(); throttled();
    expect(emits).toBe(3); // 新窗口首个调用立即发
    vi.advanceTimersByTime(50); // 第二个窗口尾帧补发
    expect(emits).toBe(4);
    vi.advanceTimersByTime(100);
    expect(emits).toBe(4);
  });

  test("frame throttle: cancel() drops a pending trailing emit", () => {
    vi.useFakeTimers();
    let emits = 0;
    const throttled = throttleFrames(() => { emits += 1; }, 50);
    throttled(); // 立即发
    throttled(); // pending 尾帧
    throttled.cancel();
    vi.advanceTimersByTime(100);
    expect(emits).toBe(1); // pending 被取消，不越界补发
  });
});
