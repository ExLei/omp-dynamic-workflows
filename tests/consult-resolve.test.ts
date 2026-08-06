import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { hashConsult } from "../src/workflow.js";

/**
 * A script that reaches a consult() intervention point on its very first call —
 * consult() throws CONSULT_PENDING synchronously, so the run settles through
 * executeRun's catch tail without ever calling the agent.
 */
const CONSULT_SCRIPT =
  'export const meta = { name: "consult-resolve", description: "resolve state machine" };\n' +
  // to:"main"：纯 park 路径（apply 缺省归一 "auto" 后 to:"agent" 会触发自动审阅链；
  // 本文件以 resolve 状态机为对象，无 mock 审阅执行器的测试必须用 to:"main" 保持
  // 挂起等待语义——双审查关键 1 的测试对齐）。
  'consult("q", { to: "main" });\n' +
  "return 'unreachable';";

/**
 * Same consult point, followed by an agent() call that a blocking agent mock
 * holds open — lets a test observe the run deterministically mid-execution
 * (status "running", journal still on disk) instead of racing completion.
 */
const CONSULT_THEN_AGENT_SCRIPT =
  'export const meta = { name: "consult-then-agent", description: "consult then agent" };\n' +
  'consult("q", { to: "agent" });\n' +
  'return await agent("go", { label: "worker" });';

/** A valid script that completes without any consult — a review reply script. */
const REPLY_SCRIPT =
  'export const meta = { name: "reply", description: "review reply" };\n' +
  "return 42;";

/** Start `script` on `manager` and settle it to waiting_consult. */
async function parkConsultRun(manager: WorkflowManager, script = CONSULT_SCRIPT): Promise<string> {
  const { runId, promise } = manager.startInBackground(script);
  await promise.catch(() => {});
  expect(manager.getRun(runId)?.status).toBe("waiting_consult");
  return runId;
}

/**
 * A manager whose agent mock blocks until released — the run is observably
 * "running" with the agent in flight for as long as the test needs.
 */
function createBlockingAgentManager(cwd: string): {
  manager: WorkflowManager;
  agentStartedPromise: Promise<void>;
  agentRelease: () => void;
} {
  const { promise: agentStartedPromise, resolve: agentStarted } = Promise.withResolvers<void>();
  const { promise: agentReleasePromise, resolve: agentRelease } = Promise.withResolvers<void>();
  const manager = new WorkflowManager({
    cwd,
    agent: {
      run(_prompt: string, _options?: AgentRunOptions<never>) {
        agentStarted();
        return agentReleasePromise;
      },
    } as unknown as WorkflowManagerOptions["agent"],
  });
  return { manager, agentStartedPromise, agentRelease };
}

describe("resolveConsult", () => {
  test("reply with script: writes journal entry {index, runId, hash, result}, persists BEFORE resume, clears pending, resumes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-reply-script-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(0);

      const completed = once(manager, "complete");
      const ok = await manager.resolveConsult(runId, { script: CONSULT_THEN_AGENT_SCRIPT });
      expect(ok).toBe(true);

      // The resumed run replays the consult from the journal — resume()
      // rebuilds its journal exclusively from DISK, so reaching the agent
      // call (consult replay hit) is the proof the entry persisted BEFORE
      // resume; a memory-only entry would have re-pended the consult instead.
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      // The journal is still on disk (a running run keeps it).
      const persisted = manager.getPersistence().load(runId);
      const consultEntry = persisted?.journal?.find((e) => e.index === 0);
      expect(consultEntry).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q", { to: "agent" }),
        result: {
          applied: true,
          revisedScript: CONSULT_THEN_AGENT_SCRIPT,
          summary: "应用了用户提供的脚本",
        },
      });
      // pendingConsult cleared in memory and on disk.
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(persisted?.pendingConsult).toBeUndefined();

      // Release the agent: the run finishes.
      agentRelease();
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reply without script (to:main): journals { applied:false, summary:'维持原脚本' } and resumes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-reply-plain-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);

      const completed = once(manager, "complete");
      const ok = await manager.resolveConsult(runId);
      expect(ok).toBe(true);
      await agentStartedPromise;

      const persisted = manager.getPersistence().load(runId);
      expect(persisted?.journal?.find((e) => e.index === 0)?.result).toEqual({
        applied: false,
        summary: "维持原脚本",
      });
      expect(persisted?.pendingConsult).toBeUndefined();

      agentRelease();
      await completed;
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reply on a completed run is rejected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-reply-completed-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const { runId, promise } = manager.startInBackground(REPLY_SCRIPT);
      await promise;
      expect(manager.getRun(runId)?.status).toBe("completed");

      expect(await manager.resolveConsult(runId, { script: REPLY_SCRIPT })).toBe(false);
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("double reply: second one loses (status check fails)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-double-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);

      const completed = once(manager, "complete");
      expect(await manager.resolveConsult(runId)).toBe(true);
      await agentStartedPromise;
      // The first answer already flipped the run off waiting_consult
      // (paused → running), so the second is refused by the status gate.
      expect(await manager.resolveConsult(runId, { script: REPLY_SCRIPT })).toBe(false);
      expect(manager.getPersistence().load(runId)?.journal).toHaveLength(1);

      agentRelease();
      await completed;
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("disk-only waiting_consult: resolveConsult works after cold start (recoverStaleRuns leaves it)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-diskonly-"));
    try {
      // Park a run on waiting_consult in a first manager, then cold-start a
      // fresh manager over the same cwd: recoverStaleRuns only flips
      // running→paused, so the waiting_consult run stays parked on disk with
      // no in-memory copy in the new manager. 首 manager 注入阻塞 mock：脚本
      // consult(to:"agent") 会触发自动审阅链（apply 缺省归一 "auto"），mock 把链
      // 挂住、不派生真实审阅代理（双审查关键 1 测试对齐）。
      const first = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(first.manager, CONSULT_THEN_AGENT_SCRIPT);

      const diskOnly = createBlockingAgentManager(cwd);
      expect(diskOnly.manager.getRun(runId)).toBeUndefined();
      expect(diskOnly.manager.getPersistence().load(runId)?.status).toBe("waiting_consult");

      const completed = once(diskOnly.manager, "complete");
      const ok = await diskOnly.manager.resolveConsult(runId, { script: CONSULT_THEN_AGENT_SCRIPT });
      expect(ok).toBe(true);
      await diskOnly.agentStartedPromise;
      expect(diskOnly.manager.getRun(runId)?.status).toBe("running");

      const persisted = diskOnly.manager.getPersistence().load(runId);
      expect(persisted?.journal?.[0]).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q", { to: "agent" }),
        result: {
          applied: true,
          revisedScript: CONSULT_THEN_AGENT_SCRIPT,
          summary: "应用了用户提供的脚本",
        },
      });
      expect(persisted?.pendingConsult).toBeUndefined();

      diskOnly.agentRelease();
      await completed;
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("regression (最终审查必修 1): no-anchor pending reply against a settled:false journal tail resumes, never strands the run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-noanchor-settledfalse-"));
    try {
      // 带计数 agent mock：第 1 次调用挂住直到 intervene 的 abort（旧执行体干净
      // 收尾、不干扰新执行），第 2 次调用挂住直到测试放行（证明恢复后的执行真正
      // 跑到了 agent，而非仅状态翻转）。
      let invocation = 0;
      const { promise: agentStartedPromise, resolve: agentStarted } = Promise.withResolvers<void>();
      const { promise: releaseSecond, resolve: releaseSecondResolve } = Promise.withResolvers<string>();
      const manager = new WorkflowManager({
        cwd,
        agent: {
          run(_prompt: string, options?: AgentRunOptions<never>) {
            agentStarted();
            if (invocation++ === 0) {
              const { promise, reject } = Promise.withResolvers<never>();
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              return promise;
            }
            return releaseSecond;
          },
        } as unknown as WorkflowManagerOptions["agent"],
      });

      // 失败 consult（settled:false 尾条）。
      // to:"main" 变体：consult 之后接 agent——park 时不触发自动审阅链（to:"main"
      // 链不启动），mock 的调用计数确定（0=EDITED resume 的 agent，1=回复后 resume
      // 的 agent），无链干扰。
      const PARK_SCRIPT =
        'export const meta = { name: "consult-then-agent", description: "consult then agent" };\n' +
        'consult("q", { to: "main" });\n' +
        'return await agent("go", { label: "worker" });';
      const runId = await parkConsultRun(manager, PARK_SCRIPT);
      await manager.markConsultFailed(runId, "review failed");

      // 带编辑脚本 resume：agent 调用插到 consult 之前——index 0 对 settled:false
      // 尾条 hash-miss → 直播执行 agent → 运行中（journal 尾条仍是 settled:false，
      // 新执行尚未 journal 任何条目）。
      const EDITED =
        'export const meta = { name: "agent-then-consult", description: "agent first" };\n' +
        'await agent("go", { label: "worker" });\n' +
        'consult("q2", { to: "main" });\n' +
        "return 'unreachable';";
      expect(await manager.resume(runId, { script: EDITED })).toBe(true);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      // 运行中 intervene → 无锚点 pending（无 callIndex → resolveConsult 不写
      // journal entry、无法遮蔽 settled:false 尾条）。
      expect(manager.intervene(runId)).toBe(true);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.callIndex).toBeUndefined();
      // 让被 abort 的旧执行体收尾（catch 尾释放 run lease）——真实使用中 intervene
      // 与 reply 是两个独立请求，事件循环必然让出；这里显式让出，避免 resolveConsult
      // 内部 resume 在同一 tick 撞上仍未释放的旧 lease（acquireRunLease 同进程 EEXIST）。
      await new Promise((resolve) => setTimeout(resolve, 0));
      const tailBefore = manager.getPersistence().load(runId)?.journal?.at(-1);
      expect((tailBefore?.result as { settled?: boolean } | undefined)?.settled).toBe(false);

      // 无脚本 reply：BUG 前 resolveConsult 先清 pending/置 paused/persist，再调
      // 内部 resume()——被 settled:false 前置检查否决 → 返回 false 但状态已变更：
      // 回复被静默消费、运行搁浅在 paused 且无 pendingConsult（最终审查已独立
      // 复现）。修复后 resume 绕过该检查（安全依据见 resume/resolveConsult 注释），
      // index 0 对 settled:false 尾条仍 hash-miss → agent 直播 → 运行恢复。
      const rePended = once(manager, "consult-pending");
      const ok = await manager.resolveConsult(runId);
      expect(ok).toBe(true);
      expect(manager.getRun(runId)?.status).toBe("running");
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();

      // 放行 agent：执行真正前进——脚本里的 consult("q2") 是全新调用（callIndex 1
      // 无 journal 条目）→ 重新挂起（有锚点，用户可再答复），证明绕过检查没有
      // 静默跳过咨询点。机制说明（复检 B 次要 ① 订正）：重放对 index 0 的
      // settled:false 尾条是 hash-miss（直播调用是 agent()，与 consult 条目哈希
      // 不匹配），settled:false 重挂分支并未被触达——本断言证明的是「运行真正
      // 恢复且停在下一个咨询点」，不是该分支本身。
      releaseSecondResolve("done");
      await rePended;
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("regression (顺手修 3): empty-string journalPrefix fails loudly, never parks on a degenerate identity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-empty-prefix-"));
    try {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          run(_prompt: string, _options?: AgentRunOptions<never>) {
            // A CONSULT_PENDING whose journalPrefix is an empty string — the
            // old guard only checked typeof string, so "" passed and the run
            // parked on a degenerate identity (resolveConsult would journal
            // under runId "", replay never hits, the reply is silently
            // dropped). It must fail loudly like any other malformed payload.
            return Promise.reject(
              new WorkflowError("consult pending", WorkflowErrorCode.CONSULT_PENDING, {
                recoverable: false,
                payload: { journalPrefix: "", callIndex: 0, prompt: "q", opts: { to: "agent" } },
              }),
            );
          },
        } as unknown as WorkflowManagerOptions["agent"],
      });
      const errors: unknown[] = [];
      const consultPending: unknown[] = [];
      manager.on("error", (e) => errors.push(e));
      manager.on("consult-pending", (e) => consultPending.push(e));

      const SCRIPT =
        'export const meta = { name: "empty-prefix", description: "bad payload" };\n' +
        'return await agent("go", { label: "worker" });';
      const { runId, promise } = manager.startInBackground(SCRIPT);
      const rejected = await promise.catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(WorkflowError);

      // Loud failure: failed + error event, no waiting_consult park, nothing
      // persisted as a pending intervention.
      expect(manager.getRun(runId)?.status).toBe("failed");
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(manager.getPersistence().load(runId)?.status).toBe("failed");
      expect(manager.getPersistence().load(runId)?.pendingConsult).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(consultPending).toEqual([]);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("markConsultFailed", () => {
  test("markConsultFailed: journals settled:false, sets failed, persists, recordTerminalRun, emits error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-failed-"));
    try {
      // A manager that keeps only ONE terminal run in memory: after
      // markConsultFailed records the failed consult run as terminal, the
      // earlier completed run is evicted — the observable proof that
      // recordTerminalRun() actually ran for the failed run.
      const manager = new WorkflowManager({ cwd, maxTerminalRunsInMemory: 1 });
      const { runId: completedId, promise: completedPromise } = manager.startInBackground(REPLY_SCRIPT);
      await completedPromise;
      expect(manager.getRun(completedId)).toBeDefined();

      const runId = await parkConsultRun(manager);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      const errors: unknown[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.markConsultFailed(runId, "review chain produced no answer");

      expect(manager.getRun(runId)?.status).toBe("failed");
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      const persisted = manager.getPersistence().load(runId);
      expect(persisted?.status).toBe("failed");
      expect(persisted?.pendingConsult).toBeUndefined();
      expect(persisted?.journal?.[0]).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q", { to: "main" }),
        result: { applied: false, reason: "review chain produced no answer", settled: false },
      });

      // recordTerminalRun: the failed consult run pushed the queue past the
      // cap of 1, evicting the earlier completed run from memory.
      expect(manager.getRun(completedId)).toBeUndefined();

      // Emits an error event with a recoverable WORKFLOW_ABORTED.
      expect(errors).toHaveLength(1);
      const first = errors[0];
      if (!(first && typeof first === "object" && "error" in first)) throw new Error("expected error payload");
      const err = first.error;
      if (!(err instanceof WorkflowError)) throw new Error("expected WorkflowError");
      expect(err.message).toBe("review chain produced no answer");
      expect(err.code).toBe(WorkflowErrorCode.WORKFLOW_ABORTED);
      expect(err.recoverable).toBe(true);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("plain resume with settled:false entry is rejected by the manager pre-check", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-settled-false-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const runId = await parkConsultRun(manager);
      await manager.markConsultFailed(runId, "review failed");

      // Plain resume (no script) — refused: the failed consult was never
      // answered, so a plain resume must not silently skip past it.
      expect(await manager.resume(runId)).toBe(false);
      // A byte-identical script is equally a plain resume.
      expect(await manager.resume(runId, { script: CONSULT_SCRIPT })).toBe(false);

      // Resume with an EDITED script is the sanctioned path: the edit makes
      // the replay hash-miss at the consult's call index, re-pending the
      // consult live so the user answers the new prompt.
      const EDITED = CONSULT_SCRIPT.replace('consult("q",', 'consult("q2",');
      const rePending = once(manager, "consult-pending");
      expect(await manager.resume(runId, { script: EDITED })).toBe(true);
      await rePending;
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("settled:false shadowing: failed consult → edited-script resume → re-pend → no-script reply → run completes (resolved reply shadows the failed entry)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-settled-shadow-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);
      await manager.markConsultFailed(runId, "review failed");

      // Resume with an EDITED script: the edit makes the replay hash-miss at
      // the consult's call index (the settled:false entry is treated as a
      // miss too), re-pending the consult with the new prompt.
      const EDITED = CONSULT_THEN_AGENT_SCRIPT.replace('consult("q",', 'consult("q2",');
      const rePending = once(manager, "consult-pending");
      expect(await manager.resume(runId, { script: EDITED })).toBe(true);
      await rePending;
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");

      // No-script reply: the run continues with the edited script — the
      // re-pended consult replay-hits the NEW journaled entry at the same
      // call index, shadowing the failed predecessor (replay Map keys by
      // index, later write wins), and the run is NOT self-locked by the
      // stale settled:false entry (resume's guard checks only the last one).
      const completed = once(manager, "complete");
      const ok = await manager.resolveConsult(runId);
      expect(ok).toBe(true);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      // The journal's LAST consult entry (at the call index) is the resolved
      // reply, not the settled:false failure — the resolved re-pend shadows
      // its failed predecessor. (Asserted while the run is mid-flight: a
      // completed run drops its journal on disk, as every reply test does.)
      const journal = manager.getPersistence().load(runId)?.journal ?? [];
      const consultEntries = journal.filter((e) => e.index === 0);
      expect(consultEntries).toHaveLength(2);
      const lastConsult = consultEntries[consultEntries.length - 1];
      expect(lastConsult).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q2", { to: "agent" }),
        result: { applied: false, summary: "维持原脚本" },
      });
      expect(lastConsult?.result).not.toHaveProperty("settled");

      agentRelease();
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("intervene", () => {
  test("intervene on running: sets waiting_consult + persists, THEN aborts; abort catch tail does not overwrite", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-intervene-"));
    try {
      const { promise: agentStartedPromise, resolve: agentStarted } = Promise.withResolvers<void>();
      const manager = new WorkflowManager({
        cwd,
        agent: {
          run(_prompt: string, options?: AgentRunOptions<never>) {
            agentStarted();
            // Block until the manager aborts the run's controller.
            const { promise, reject } = Promise.withResolvers<never>();
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            return promise;
          },
        } as unknown as WorkflowManagerOptions["agent"],
      });

      const RUNNING_SCRIPT =
        'export const meta = { name: "intervene", description: "intervene while running" };\n' +
        'return await agent("go", { label: "worker" });';
      const { runId, promise } = manager.startInBackground(RUNNING_SCRIPT);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      expect(manager.intervene(runId)).toBe(true);
      // Status + pending consult flipped and PERSISTED before the abort is
      // fired (intervene aborts only after persistRun).
      const pendingShape = { prompt: "用户主动介入", opts: { to: "main" as const }, generation: 1 };
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult).toEqual(pendingShape);
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
      expect(manager.getPersistence().load(runId)?.pendingConsult).toEqual(pendingShape);

      // The abort settles the execution; the catch tail's abort branch only
      // rewrites "running", so waiting_consult is preserved.
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult).toEqual(pendingShape);
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("post-intervene no-script reply: delivery override does not corrupt the consult hash identity (replay hits, run completes)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-intervene-reply-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);

      // Re-target delivery to "main" WITHOUT rewriting the pending opts — the
      // journal hash is built from the script-original opts (to:"agent") and
      // replay recomputes the identical hash from the script's own consult()
      // call. Regression for finding 1: rewriting opts.to to "main" made the
      // journaled hash mismatch, silently dropping the answer and re-pending
      // the consult forever (this test hangs before the fix).
      expect(manager.intervene(runId)).toBe(true);
      expect(manager.getRun(runId)?.pendingConsult?.to).toBe("main");
      expect(manager.getRun(runId)?.pendingConsult?.opts.to).toBe("agent");
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);

      // No-script reply (维持原脚本继续): the ORIGINAL script resumes, whose
      // consult("q", { to: "agent" }) must hash-hit the journaled entry and
      // reach the blocking agent — the answer was consumed, not re-pended.
      const completed = once(manager, "complete");
      const ok = await manager.resolveConsult(runId);
      expect(ok).toBe(true);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      const persisted = manager.getPersistence().load(runId);
      expect(persisted?.journal?.find((e) => e.index === 0)).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q", { to: "agent" }),
        result: { applied: false, summary: "维持原脚本" },
      });
      expect(persisted?.pendingConsult).toBeUndefined();

      agentRelease();
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("generation gating", () => {
  test("generation: review chain captured gen 0, intervene bumps to 1, chain apply is discarded", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-generation-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const runId = await parkConsultRun(manager, CONSULT_THEN_AGENT_SCRIPT);
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(0);

      // The user intervenes while the run is waiting on the in-flight review
      // chain: delivery is re-targeted to main via the `to` override and the
      // generation bumps 0 → 1, invalidating the chain's captured generation.
      // The pending opts are NOT rewritten — they keep the script-original
      // to:"agent" identity that resolveConsult's journal hash is built from.
      expect(manager.intervene(runId)).toBe(true);
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);
      expect(manager.getRun(runId)?.pendingConsult?.to).toBe("main");
      expect(manager.getRun(runId)?.pendingConsult?.opts.to).toBe("agent");

      // The stale chain's apply is discarded: false, no state change, no
      // journal write.
      const stale = await manager.applyReviewChain(runId, { generation: 0, script: REPLY_SCRIPT, summary: "stale" });
      expect(stale).toBe(false);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);
      expect(manager.getPersistence().load(runId)?.journal ?? []).toHaveLength(0);
      expect(manager.getPersistence().load(runId)?.pendingConsult?.summary).toBeUndefined();

      // The chain retrying at the CURRENT generation succeeds and the run
      // resumes (the summary lands on the pending consult). The resumed
      // script must preserve the consult's HASH identity (to:"agent" — the
      // original call) for the replay to hit and reach the blocking agent:
      // intervene changes delivery, never the hash identity (a script that
      // altered the consult call would re-pend by design).
      const completed = once(manager, "complete");
      const fresh = await manager.applyReviewChain(runId, {
        generation: 1,
        script: CONSULT_THEN_AGENT_SCRIPT,
        summary: "fresh",
      });
      expect(fresh).toBe(true);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      const persisted = manager.getPersistence().load(runId);
      expect(persisted?.journal?.find((e) => e.index === 0)).toEqual({
        index: 0,
        runId,
        hash: hashConsult("q", { to: "agent" }),
        // 双审查重要 2：链应用 → outcome 如实报 applied:true + 链摘要 + 已应用脚本
        // （不再报 applied:false/维持原脚本——旧注释「auto 应用 outcome 是维持原
        // 脚本」记录的就是该误导值）。
        result: { applied: true, summary: "fresh", revisedScript: CONSULT_THEN_AGENT_SCRIPT },
      });
      expect(persisted?.pendingConsult).toBeUndefined();

      agentRelease();
      await completed;
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("generation: disk-only stale chain apply racing a concurrent intervene is discarded with no residual", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-stale-apply-"));
    try {
      // Manager A parks the run (gen 0, waiting_consult) in memory AND on
      // disk. Manager B (fresh, same cwd) has no in-memory run — the
      // disk-only applyReviewChain path.
      const a = new WorkflowManager({ cwd });
      const runId = await parkConsultRun(a);
      expect(a.getPersistence().load(runId)?.pendingConsult?.generation).toBe(0);

      const b = new WorkflowManager({ cwd });
      expect(b.getRun(runId)).toBeUndefined();
      expect(b.getPersistence().load(runId)?.status).toBe("waiting_consult");

      // Simulate the cross-process window: process C intervenes (re-target to
      // main, generation 0 → 1) AFTER B's applyReviewChain fast-fail check
      // but BEFORE B's lease-held reload inside resolveConsult. The spy fires
      // on the second load (resolveConsult's method-top snapshot), so the
      // injected intervene lands between the chain's fast-fail check and the
      // single lease-held "reload → re-check → write" critical section — the
      // instant the OLD two-phase code would have written the stale snapshot
      // back and rolled the peer's generation to 0.
      //
      // (Honest lock semantics: the lease is advisory — save() does not check
      // it, and an in-memory run holder writes without it. The injected peer
      // write is exactly such an unlocked write; a peer's unlocked save
      // landing between B's lease-held reload and save is a documented
      // residual µs-level window, not a closed serialization guarantee.)
      const persistence = b.getPersistence();
      const realLoad = persistence.load;
      const realSave = persistence.save;
      let loads = 0;
      persistence.load = (id: string) => {
        loads += 1;
        if (loads === 2) {
          const current = realLoad(id);
          if (current?.pendingConsult) {
            realSave({
              ...current,
              pendingConsult: {
                ...current.pendingConsult,
                to: "main",
                generation: current.pendingConsult.generation + 1,
              },
              updatedAt: new Date().toISOString(),
            });
          }
        }
        return realLoad(id);
      };
      loads = 0;

      // The stale chain (captured gen 0) must be rejected WITHOUT touching
      // state: the peer's generation stays 1, `to` stays "main", and no stale
      // summary (or journal entry) is left behind for a later resolution.
      const stale = await b.applyReviewChain(runId, { generation: 0, script: REPLY_SCRIPT, summary: "stale" });
      expect(stale).toBe(false);
      const disk = b.getPersistence().load(runId);
      expect(disk?.pendingConsult?.generation).toBe(1);
      expect(disk?.pendingConsult?.to).toBe("main");
      expect(disk?.pendingConsult?.summary).toBeUndefined();
      expect(disk?.status).toBe("waiting_consult");
      expect(disk?.journal ?? []).toHaveLength(0);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("user reply is NOT generation-gated (intervene -> reply works)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-reply-nogen-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const runId = await parkConsultRun(manager);
      expect(manager.intervene(runId)).toBe(true);
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);

      // A user reply carries no generation — it succeeds regardless of the
      // generation the run is currently on.
      const completed = once(manager, "complete");
      expect(await manager.resolveConsult(runId, { script: REPLY_SCRIPT })).toBe(true);
      await completed;
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(manager.getPersistence().load(runId)?.pendingConsult).toBeUndefined();
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
