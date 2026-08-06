import { describe, expect, test } from "bun:test";
import { runWorkflow, hashConsult } from "../src/workflow.js";
import { WorkflowErrorCode } from "../src/errors.js";

const consultScript = `
export const meta = { name: "c", description: "consult vm" };
phase("P1");
await agent("first", { label: "a1" });
const outcome = consult("should we continue?", { to: "agent" });
return outcome.summary;
`;

/**
 * Live-run the consult script once and capture the agent (callIndex 0) journal
 * entry from onAgentJournal — consult's own hash cannot be captured that way
 * (live consult throws before journaling), so it is computed via hashConsult.
 */
async function captureAgentEntry(): Promise<{ index: number; runId?: string; hash: string }> {
  let captured: { index: number; runId?: string; hash: string } | null = null;
  await runWorkflow(consultScript, {
    runId: "r1",
    agent: { run: async () => "done" },
    onAgentJournal: (entry) => {
      if (entry.index === 0) captured = { index: entry.index, runId: entry.runId, hash: entry.hash };
    },
  }).catch(() => {});
  if (!captured) throw new Error("agent (callIndex 0) journal entry was not captured");
  return captured;
}

const consultHash = hashConsult("should we continue?", { to: "agent" });

describe("consult VM contract", () => {
  test("live execution throws CONSULT_PENDING and interrupts the script", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    expect(calls).toEqual(["first"]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(outcome.payload).toMatchObject({
      prompt: "should we continue?",
      callIndex: 1,
      journalPrefix: "r1:",
      opts: { to: "agent" },
    });
  });

  test("replay returns the journaled outcome (live throws, replay returns)", async () => {
    const entry = await captureAgentEntry();
    const replay = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        ["r1:1", { index: 1, runId: "r1", hash: consultHash, result: { applied: true, summary: "ok" } }],
      ]),
      agent: { run: async () => "done" },
    });
    // The script consumes the replayed outcome (outcome.summary) — a replay
    // that returns undefined or the wrong object would fail this assertion.
    expect(replay.result).toBe("ok");
  });

  test("a settled:false entry is treated as a miss and rethrows CONSULT_PENDING", async () => {
    const entry = await captureAgentEntry();
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        [
          "r1:1",
          { index: 1, runId: "r1", hash: consultHash, result: { applied: false, reason: "x", settled: false } },
        ],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 replayed (nothing ran live); the settled:false consult re-pended.
    expect(calls).toEqual([]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("a hash-mismatched entry is a miss and rethrows CONSULT_PENDING", async () => {
    const entry = await captureAgentEntry();
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        ["r1:1", { index: 1, runId: "r1", hash: "bogus-hash", result: { applied: true, summary: "ok" } }],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 replayed (hash matches); index 1 hash mismatch → the replayed
    // outcome is NOT returned — the consult re-pends instead.
    expect(calls).toEqual([]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("a missing index-0 entry forces firstMiss=0 so replay always misses", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:1", { index: 1, runId: "r1", hash: consultHash, result: { applied: true, summary: "ok" } }],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 has no entry → firstMiss becomes 0 → index 1's matching entry is
    // still a miss (callIndex 1 < firstMiss 0 is false) → consult re-pends
    // even though its own entry is present and hash-matches.
    expect(calls).toEqual(["first"]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("settled:false re-pend consumes exactly one agent slot (maxAgents=3)", async () => {
    const entry = await captureAgentEntry();
    const slotScript = `
export const meta = { name: "c", description: "consult vm" };
phase("P1");
await agent("first", { label: "a1" });
let pending = null;
try {
  consult("should we continue?", { to: "agent" });
} catch (e) {
  pending = e.code;
}
await agent("second", { label: "a2" });
return pending;
`;
    const run = await runWorkflow(slotScript, {
      runId: "r1",
      maxAgents: 3,
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        [
          "r1:1",
          { index: 1, runId: "r1", hash: consultHash, result: { applied: false, reason: "x", settled: false } },
        ],
      ]),
      agent: { run: async () => "done" },
    });
    // 3 slots total: index-0 replay + settled:false consult (1 slot) + index-2
    // agent. The double-increment bug consumes 2 slots at the consult, so the
    // following agent() throws AGENT_LIMIT_EXCEEDED instead of completing.
    expect(run.result).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(run.agentCount).toBe(3);
  });

  test("consult inside parallel escapes as CONSULT_PENDING and aborts the in-flight sibling", async () => {
    // 规格 §9: parallel 内 consult——中断在飞兄弟（recoverable:false 路径）。
    // parallel() 对非可恢复错误 rethrow（参照 workflow.ts 的 parallel 实现：
    // recoverable 错误吞成 null，非 recoverable 抛给上层），因此 CONSULT_PENDING
    // 必须逃逸整个 parallel，而不是作为 null 悄悄进入 results 数组让脚本"静默完成"。
    const parallelScript = `
export const meta = { name: "pc", description: "parallel consult" };
phase("P1");
const results = await parallel([
  () => agent("slow", { label: "slow" }),
  () => consult("should we continue?", { to: "agent" }),
]);
return results;
`;
    let siblingRan = false;
    let siblingAborted = false;
    const outcome = await runWorkflow(parallelScript, {
      runId: "r-par",
      agent: {
        run: async (_prompt: string, opts?: { signal?: AbortSignal }) => {
          // thunk[0] 先同步启动（map 顺序），此时 thunk[1] 的 consult 同步抛出。
          siblingRan = true;
          // 挂起直到 run-fatal abort 触发（sibling 的 AbortSignal 由
          // runFatalController 经 onRunFatal 转发）。若实现退化到不中止兄弟，
          // runWorkflow 的 drain 会卡住直到 bun 的 per-test timeout 判失败——
          // 失败信号完全由信号驱动，不依赖真实墙钟。
          await new Promise<void>((resolve) => {
            const signal = opts?.signal;
            if (signal?.aborted) {
              siblingAborted = true;
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                siblingAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return "aborted-sibling";
        },
      },
    }).catch((e) => e);
    // 兄弟确实在飞，且 CONSULT_PENDING 逃逸了 parallel（非吞 null 静默完成）。
    expect(siblingRan).toBe(true);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(outcome.payload).toMatchObject({
      prompt: "should we continue?",
      // 兄弟 agent 先占 callSeq 0，consult 是本次运行的第 2 个调用。
      callIndex: 1,
      journalPrefix: "r-par:",
    });
    // 顶层逃逸 sealed runFatalController → 在飞兄弟被中止：运行失败而非静默完成。
    expect(siblingAborted).toBe(true);
  });

  test("consult inside a nested workflow() journals to the child frame namespace", async () => {
    // 规格 §9: 嵌套 workflow() 内 consult——journal 写入子帧命名空间。
    // 子帧 runId 为 `${runId}-nested${++nestedCallSeq}`，因此 payload.journalPrefix
    // 必须是子帧前缀（r-nest-nested1:），而不是父帧的 r-nest:；重放时答复也要落
    // 在子帧键上才能命中。
    const childScript = `
export const meta = { name: "child", description: "child with consult" };
phase("C1");
const outcome = consult("nested question?", { to: "agent" });
return outcome.summary;
`;
    const parentScript = `
export const meta = { name: "p", description: "nested consult parent" };
phase("P1");
const childResult = await workflow("child");
return childResult;
`;
    const saved: Record<string, string> = { child: childScript };
    const nestedHash = hashConsult("nested question?", { to: "agent" });

    // Live：子帧 consult 抛出，payload 携带子帧命名空间。
    const outcome = await runWorkflow(parentScript, {
      runId: "r-nest",
      loadSavedWorkflow: (name: string) => saved[name],
    }).catch((e) => e);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(outcome.payload).toMatchObject({
      prompt: "nested question?",
      callIndex: 0,
      journalPrefix: "r-nest-nested1:",
      opts: { to: "agent" },
    });

    // Replay：答复写在子帧键 r-nest-nested1:0 下，嵌套 consult 重放命中。
    const replay = await runWorkflow(parentScript, {
      runId: "r-nest",
      loadSavedWorkflow: (name: string) => saved[name],
      resumeJournal: new Map([
        [
          "r-nest-nested1:0",
          { index: 0, runId: "r-nest-nested1", hash: nestedHash, result: { applied: true, summary: "ok" } },
        ],
      ]),
    });
    expect(replay.result).toBe("ok");
  });
});
