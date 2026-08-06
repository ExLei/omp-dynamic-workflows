import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

/**
 * A script that reaches a consult() intervention point on its very first call —
 * consult() throws CONSULT_PENDING synchronously, so the run settles through
 * executeRun's catch tail without ever calling the agent. to:"main"：纯 park
 * 路径（不触发自动审阅链）。
 */
const CONSULT_SCRIPT =
  'export const meta = { name: "consult-control", description: "control tool state machine" };\n' +
  'consult("q", { to: "main" });\n' +
  "return 'unreachable';";

/** A valid script that completes without any consult — a review reply script. */
const REPLY_SCRIPT =
  'export const meta = { name: "reply", description: "review reply" };\n' +
  "return 42;";

/** A script that blocks on a held agent call — observably "running" mid-flight. */
const AGENT_SCRIPT =
  'export const meta = { name: "agent-run", description: "holds an agent" };\n' +
  'return await agent("go", { label: "worker" });';

/**
 * Same consult point as CONSULT_SCRIPT (to:"main" — no auto-review chain),
 * followed by an agent() call a blocking agent mock holds open — lets a test
 * observe the run deterministically mid-execution (status "running", journal
 * still on disk) instead of racing completion.
 */
const CONSULT_THEN_AGENT_SCRIPT =
  'export const meta = { name: "consult-then-agent", description: "consult then agent" };\n' +
  'consult("q", { to: "main" });\n' +
  'return await agent("go", { label: "worker" });';

/** consult(to:agent, apply:confirm)：审阅链只产出建议，等待用户采纳（重要 2）。 */
const CONSULT_CONFIRM_SCRIPT =
  'export const meta = { name: "control-confirm", description: "confirm mode" };\n' +
  'consult("confirm this", { to: "agent", apply: "confirm" });\n' +
  "return 'unreachable';";

/** confirm 模式的建议修订版：consult 调用保持原样（采纳后重放命中）。 */
const CONFIRM_REVISED_SCRIPT =
  'export const meta = { name: "control-confirm", description: "confirm mode" };\n' +
  'consult("confirm this", { to: "agent", apply: "confirm" });\n' +
  "return 'adopted';";

/**
 * to:"main" + apply:"confirm" 的咨询：链触发分流（裁定 1）对 to:"main" 不启动审阅
 * 链——park 即投递 triggerTurn、无 revisedScript，主代理可抢在 consult-review-ready
 * 前 reply（角落 3 路径 a 的确定性复现：confirm 建议未就绪）。
 */
const CONSULT_CONFIRM_NO_CHAIN_SCRIPT =
  'export const meta = { name: "control-confirm-noready", description: "confirm without suggestion" };\n' +
  'consult("confirm this", { to: "main", apply: "confirm" });\n' +
  "return 'unreachable';";

/** to 缺省 + apply:"confirm"：ConsultOptions.to 可选——(undefined ?? undefined) !==
 * "agent"，park 即投递（复检重要 2 形状 b）；confirm 链只产出建议、run 保持 parked。 */
const CONSULT_NO_TO_SCRIPT =
  'export const meta = { name: "control-no-to", description: "consult without to" };\n' +
  'consult("confirm this", { apply: "confirm" });\n' +
  "return 'unreachable';";

/** to:"agent" + apply:"auto"：纯 agent 形状——原投递被投递层抑制（非 confirm），
 * 改投时才真正补发射（复检重要 2「恰一次」形状）。 */
const CONSULT_AGENT_AUTO_SCRIPT =
  'export const meta = { name: "control-agent-auto", description: "agent auto consult" };\n' +
  'consult("confirm this", { to: "agent", apply: "auto" });\n' +
  "return 'unreachable';";

/** Start `script` on `manager` and settle it to waiting_consult. */
async function parkConsultRun(manager: WorkflowManager, script = CONSULT_SCRIPT): Promise<string> {
  const { runId, promise } = manager.startInBackground(script);
  await promise.catch(() => {});
  expect(manager.getRun(runId)?.status).toBe("waiting_consult");
  return runId;
}

/**
 * A manager whose review agent writes a confirm-mode suggestion file and
 * returns ok — lets a test land a confirm suggestion deterministically
 * (consult-review-ready), then exercise the user's adoption reply.
 */
function createConfirmReviewManager(cwd: string): { manager: WorkflowManager } {
  const manager = new WorkflowManager({
    cwd,
    agent: {
      async run(prompt: string) {
        // 模拟审阅子代理的 write 工具：把建议修订脚本落盘到 prompt 指定的路径。
        const tmpMatch = prompt.match(/写入文件 ([^\s（]+)/);
        if (tmpMatch) writeFileSync(tmpMatch[1]!, CONFIRM_REVISED_SCRIPT);
        return JSON.stringify({ ok: true, summary: "建议：改为直接返回" });
      },
    } as unknown as WorkflowManagerOptions["agent"],
  });
  return { manager };
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

function cleanup(cwd: string): void {
  rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

describe("workflow_control reply/intervene", () => {
  test("① reply accepts script key; normalizeInput passes reply {runId, script}", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-reply-script-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      const runId = await parkConsultRun(manager);

      // The script key must survive normalizeInput (allowedKeys) and reach the
      // reply dispatch — a reply that replaces the parked script with
      // REPLY_SCRIPT resumes to completion instead of re-pending the consult.
      const result = await tool.execute(
        "call-1",
        { action: "reply", runId, script: REPLY_SCRIPT },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.details?.action).toBe("reply");
      expect(result.details?.result).toBe("applied");
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      cleanup(cwd);
    }
  });

  test("② reply without script (to:main) resolves via resolveConsult; journal 维持原脚本", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-reply-plain-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const tool = createWorkflowControlTool({ manager });
      const { runId, promise } = manager.startInBackground(CONSULT_THEN_AGENT_SCRIPT);
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      const result = await tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never);
      // Tool layer: the no-script reply succeeded and the run left waiting_consult
      // (a completed run's journal is pruned on disk by design, so observe the
      // outcome while the resumed run is still mid-flight).
      expect(result.details?.action).toBe("reply");
      expect(result.details?.result).toBe("resumed");
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");
      // The journaled outcome carries the manager-layer 维持原脚本 semantics
      // (consult-resolve.test.ts covers it in depth; asserted here end to end).
      expect(manager.getPersistence().load(runId)?.journal?.find((e) => e.index === 0)?.result).toEqual({
        applied: false,
        summary: "维持原脚本",
      });

      agentRelease();
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("③ reply on a completed run returns an error with allowedActions=[status]", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-reply-completed-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const { runId, promise } = manager.startInBackground(REPLY_SCRIPT);
      await promise;
      expect(manager.getRun(runId)?.status).toBe("completed");

      const tool = createWorkflowControlTool({ manager });
      const result = await tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never);
      // completed 的 allowedActions 不含 reply/intervene —— 断言错误文案与列表。
      expect(result.details?.result).toBe("error");
      expect(result.details?.error).toContain("cannot reply run with status completed");
      expect(result.details?.allowedActions).toEqual(["status"]);
    } finally {
      cleanup(cwd);
    }
  });

  test("④ reply with an invalid script keeps waiting_consult and returns a parse error (retryable)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-reply-invalid-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      const runId = await parkConsultRun(manager);

      const result = await tool.execute(
        "call-1",
        { action: "reply", runId, script: "return 42;" },
        undefined,
        undefined,
        {} as never,
      );
      // The script-validation throw is converted to a control error, not a
      // bare throw — and the run stays parked so the reply is retryable.
      expect(result.details?.result).toBe("error");
      expect(result.details?.error).toContain("must be the first statement in the script");
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
      expect(result.details?.allowedActions).toEqual(["status", "stop", "reply", "intervene"]);

      // Retry with a valid script succeeds — same run, same pending consult.
      const retry = await tool.execute(
        "call-1",
        { action: "reply", runId, script: REPLY_SCRIPT },
        undefined,
        undefined,
        {} as never,
      );
      expect(retry.details?.result).toBe("applied");
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      cleanup(cwd);
    }
  });

  test("⑤ intervene on a running run parks it on waiting_consult (to:main delivery target)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-intervene-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const tool = createWorkflowControlTool({ manager });
      // 重要 1：intervene 必须在 persist 后发射 consult-pending（to:"main" 投递
      // 覆盖）——监听器先装，断言事件载荷（prompt/opts/to）。
      const pendingEvents: unknown[] = [];
      manager.on("consult-pending", (e) => pendingEvents.push(e));
      const { runId, promise } = manager.startInBackground(AGENT_SCRIPT);
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");

      const result = await tool.execute("call-1", { action: "intervene", runId }, undefined, undefined, {} as never);
      expect(result.details?.action).toBe("intervene");
      expect(result.details?.result).toBe("intervened");
      // Tool-layer state change: running → waiting_consult, persisted, with
      // the intervention pending consult re-targeted to "main" for delivery.
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
      // A fresh intervene on a running run parks a new pending consult whose
      // opts already target "main" (delivery reads to ?? opts.to — the `to`
      // override field only appears when re-targeting an existing consult).
      expect(manager.getRun(runId)?.pendingConsult).toMatchObject({
        prompt: "用户主动介入",
        opts: { to: "main" },
        generation: 1,
      });
      expect(manager.getRun(runId)?.pendingConsult?.to).toBeUndefined();
      // 重要 1：intervene 自发射 consult-pending（带 to:"main"）——此前唯一发射
      // 点在 catch 尾、intervene 的 abort 路径被 `!aborted` 排除，投递层收不到
      // 任何消息/唤醒，intervene→reply 回路静默死端。载荷含 prompt/opts/to。
      expect(pendingEvents).toEqual([{ runId, prompt: "用户主动介入", opts: { to: "main" }, to: "main" }]);

      // Hygiene: release the held agent so the run settles.
      agentRelease();
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("⑥ cross-session: reply resolves a run owned by another sessionId via listAllRuns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-cross-session-"));
    try {
      const manager = new WorkflowManager({ cwd, sessionId: "session-A" });
      const tool = createWorkflowControlTool({ manager });
      const runId = await parkConsultRun(manager);
      expect(manager.getPersistence().load(runId)?.sessionId).toBe("session-A");

      // The tool's session now filters to B — listRuns() can no longer see the
      // run, so a session-filtered findRun would answer "run not found".
      manager.setSessionId("session-B");
      expect(manager.listRuns().map((r) => r.runId)).not.toContain(runId);

      // reply still succeeds: findRun resolves the candidate via listAllRuns
      // (spec §4 cross-session addressing — B may answer A's run).
      const result = await tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never);
      expect(result.details?.result).toBe("resumed");
      // 回归 1（复检 A）：跨会话 run 经 listRuns() 会话过滤必找不到，无 crossSession
      // 时 currentSummary 回落分发时捕获的操作前快照（waiting_consult）——与磁盘
      // 事实（completed）同文本矛盾；修复后响应回读操作后状态，status 与事实一致。
      expect(result.details?.run).toMatchObject({ status: "completed" });
      expect(manager.getPersistence().load(runId)?.status).toBe("completed");
    } finally {
      cleanup(cwd);
    }
  });

  test("⑦ allowedActions(waiting_consult) = [status, stop, reply, intervene]", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-actions-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      const runId = await parkConsultRun(manager);

      // pause is not an allowed transition for waiting_consult; the error
      // response carries the allowed set for the current status.
      const result = await tool.execute("call-1", { action: "pause", runId }, undefined, undefined, {} as never);
      expect(result.details?.result).toBe("error");
      expect(result.details?.allowedActions).toEqual(["status", "stop", "reply", "intervene"]);
    } finally {
      cleanup(cwd);
    }
  });

  test("⑧ normalizeInput rejects unknown actions/keys with the updated message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-normalize-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });

      // Unknown action — the updated error enumerates the full action set.
      expect(() => tool.execute("call-1", { action: "bogus" } as never, undefined, undefined, {} as never)).toThrow(
        "workflow_control requires action: list|status|pause|resume|stop|reply|intervene",
      );
      // reply accepts exactly action/runId/script; a stray key is rejected.
      expect(() =>
        tool.execute("call-1", { action: "reply", runId: "r", extra: 1 } as never, undefined, undefined, {} as never),
      ).toThrow('workflow_control action "reply" does not accept extra');
      // Other non-list actions keep the old key set — intervene takes no script.
      expect(() =>
        tool.execute("call-1", { action: "intervene", runId: "r", script: "x" } as never, undefined, undefined, {} as never),
      ).toThrow('workflow_control action "intervene" does not accept script');
      // reply still requires runId.
      expect(() => tool.execute("call-1", { action: "reply" } as never, undefined, undefined, {} as never)).toThrow(
        'workflow_control action "reply" requires runId',
      );
    } finally {
      cleanup(cwd);
    }
  });

  test("⑨ confirm 采纳：reply 不附 script 时按 outcome 报 applied（重要 2）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-confirm-"));
    try {
      const { manager } = createConfirmReviewManager(cwd);
      const tool = createWorkflowControlTool({ manager });
      const reviewReady = once(manager, "consult-review-ready");
      const { runId, promise } = manager.startInBackground(CONSULT_CONFIRM_SCRIPT);
      const [{ runId: readyRunId }] = (await reviewReady) as [{ runId: string }];
      expect(readyRunId).toBe(runId);
      await promise.catch(() => {});
      // confirm 模式：审阅链只产出建议——revisedScript/summary 落 pendingConsult，
      // run 停在 waiting_consult 等用户采纳。
      expect(manager.getRun(runId)?.pendingConsult).toMatchObject({
        opts: { to: "agent", apply: "confirm" },
        revisedScript: CONFIRM_REVISED_SCRIPT,
        summary: "建议：改为直接返回",
      });
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // 省略 script 的 reply = 采纳审阅建议：resolveConsult 落盘 applied:true，
      // 工具标签必须同步报 applied（重要 2——此前按 script 参数存在性误报 resumed，
      // 与落盘 outcome 矛盾）；文案中文说明采纳了审阅建议。
      const completed = once(manager, "complete");
      const result = await tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never);
      expect(result.details?.action).toBe("reply");
      expect(result.details?.result).toBe("applied");
      const firstBlock = result.content?.[0];
      expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("采纳了审阅建议");
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
      // 落盘 outcome 与工具标签一致：applied:true + 采纳的修订脚本 + 链摘要。
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal.find((e) => e.index === 0)?.result).toEqual({
        applied: true,
        revisedScript: CONFIRM_REVISED_SCRIPT,
        summary: "建议：改为直接返回",
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("⑩ waiting_consult 改投：intervene 覆盖投递 to:\"main\" + 代际 +1；在飞审阅链因代际失配被丢弃", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-retarget-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      const runId = await parkConsultRun(manager);
      // CONSULT_SCRIPT（to:"main"）park：gen 0，无投递覆盖字段。
      expect(manager.getRun(runId)?.pendingConsult).toMatchObject({ generation: 0, opts: { to: "main" } });
      expect(manager.getRun(runId)?.pendingConsult?.to).toBeUndefined();

      // 改投：pendingConsult.to 覆盖为 "main" + 代际 0 → 1；opts 保持原样
      // （它们是 resolveConsult journal 与 replay 的 hash 身份，绝不重写）。
      const pendingEvents: unknown[] = [];
      manager.on("consult-pending", (e) => pendingEvents.push(e));
      const result = await tool.execute("call-1", { action: "intervene", runId }, undefined, undefined, {} as never);
      expect(result.details?.result).toBe("intervened");
      expect(manager.getRun(runId)?.pendingConsult).toMatchObject({
        prompt: "q",
        opts: { to: "main" },
        to: "main",
        generation: 1,
      });
      // 角落 2（复检 A）：投递层无去重——to:"main" 咨询 park 时已投递过一次，改投
      // 分支对已投递咨询不得重复发射（投递闭环语义保留在改投 to:"agent" 咨询的
      // 路径上，见 ⑬）。改投仍写 to:"main" 覆盖字段 + 代际 +1（陈旧链失效语义）。
      expect(pendingEvents).toEqual([]);

      // 在飞审阅链捕获的是旧代际 0：applyReviewChain 快速失败丢弃（零状态触碰）。
      expect(
        await manager.applyReviewChain(runId, { generation: 0, script: REPLY_SCRIPT, summary: "stale" }),
      ).toBe(false);
      expect(manager.getPersistence().load(runId)?.journal ?? []).toEqual([]);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);
      expect(manager.getRun(runId)?.pendingConsult?.to).toBe("main");
    } finally {
      cleanup(cwd);
    }
  });

  test("⑪ 双通道 reply 并发：两个 resolveConsult 同时调用，先到者成功、后到者被拒", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-dual-reply-"));
    try {
      const { manager, agentStartedPromise, agentRelease } = createBlockingAgentManager(cwd);
      const tool = createWorkflowControlTool({ manager });
      const { runId, promise } = manager.startInBackground(CONSULT_THEN_AGENT_SCRIPT);
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // 不带脚本与带脚本的 reply 同时发出——manager 临界区原子：先到者成功
      // （无脚本 reply 维持原脚本继续 → 命中阻塞 agent，可观测 mid-flight），
      // 后到者因状态已离开 waiting_consult 被拒。
      const [plain, withScript] = await Promise.all([
        tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never),
        tool.execute("call-2", { action: "reply", runId, script: REPLY_SCRIPT }, undefined, undefined, {} as never),
      ]);
      expect(plain.details?.result).toBe("resumed");
      expect(withScript.details?.result).toBe("error");
      // 次要 2：竞态下拒绝文案按当前状态报错——绝不报陈旧的 waiting_consult
      // （后到者重读 run 时状态已变化，工具不得拿传参时的旧快照误导）。
      expect(withScript.details?.error).not.toContain("waiting_consult");
      await agentStartedPromise;
      expect(manager.getRun(runId)?.status).toBe("running");
      // 只有一次 journal 落地（磁盘侧确认唯一胜者）。
      expect(manager.getPersistence().load(runId)?.journal ?? []).toHaveLength(1);

      agentRelease();
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("⑫ 角落 3：confirm 建议未就绪时 reply 回落「维持原脚本」——标签与 journal 一致", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-confirm-noready-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      // to:"main" + apply:"confirm"：链不启动（裁定 1），park 即投递 triggerTurn，
      // 主代理可抢在 consult-review-ready 前 reply——pendingConsult 无 revisedScript。
      const { runId, promise } = manager.startInBackground(CONSULT_CONFIRM_NO_CHAIN_SCRIPT);
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult).toMatchObject({
        opts: { to: "main", apply: "confirm" },
      });
      expect(manager.getRun(runId)?.pendingConsult?.revisedScript).toBeUndefined();

      const completed = once(manager, "complete");
      const result = await tool.execute("call-1", { action: "reply", runId }, undefined, undefined, {} as never);
      // 建议未就绪 ≠ 采纳：工具标签回落 resumed + 维持原脚本继续（confirmAdoption
      // 需要 revisedScript 已就绪）。
      expect(result.details?.result).toBe("resumed");
      const firstBlock = result.content?.[0];
      expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("维持原脚本继续");
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
      // journal 与标签一致：不得落 {applied:true, revisedScript:undefined}。
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal.find((e) => e.index === 0)?.result).toEqual({ applied: false, summary: "维持原脚本" });
    } finally {
      cleanup(cwd);
    }
  });

  test("⑬ 角落 3 补丁：confirm 建议未就绪 + 带脚本 reply——journal 如实 applied:true（复检重要 1）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-confirm-noready-script-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const tool = createWorkflowControlTool({ manager });
      // to:"main" + apply:"confirm"：链不启动（裁定 1），pendingConsult 无 revisedScript。
      const { runId, promise } = manager.startInBackground(CONSULT_CONFIRM_NO_CHAIN_SCRIPT);
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.revisedScript).toBeUndefined();

      const completed = once(manager, "complete");
      const result = await tool.execute(
        "call-1",
        { action: "reply", runId, script: REPLY_SCRIPT },
        undefined,
        undefined,
        {} as never,
      );
      // 带脚本 reply：工具如实报 applied + 「应用了脚本」（confirm 兜底此前忽略
      // script 参数误报 resumed/维持原脚本——标签与 journal、journal 与事实双矛盾）。
      expect(result.details?.result).toBe("applied");
      const firstBlock = result.content?.[0];
      expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("应用了脚本");
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
      // journal 与工具标签一致：{applied:true, revisedScript: 用户脚本}，不得落
      // {applied:false, 维持原脚本}（9ec2779 引入的回归形态）。
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal.find((e) => e.index === 0)?.result).toEqual({
        applied: true,
        revisedScript: REPLY_SCRIPT,
        summary: "应用了用户提供的脚本",
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("⑭ 角落 2 改投去重守卫：仅原投递确被抑制（纯 agent）时补发射，已投递形状零重复", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-control-retarget-agent-"));
    try {
      const { manager } = createConfirmReviewManager(cwd);
      const tool = createWorkflowControlTool({ manager });
      // 复检重要 2：监听器在 park 之前注册——park 期发射也必须被计数（旧 ⑬ 在
      // await reviewReady 之后才注册，park 期发射发生在监听之前，「恰一次」断言
      // 失明；且旧 504 行「原投递被抑制」注释对 confirm 咨询不成立——confirm 豁免
      // 投递层抑制，park 即已送达）。
      const pendingEvents: Array<{ runId: string; prompt?: string; opts?: unknown; to?: unknown }> = [];
      manager.on("consult-pending", (e) => pendingEvents.push(e as never));
      const eventsFor = (runId: string) => pendingEvents.filter((e) => e.runId === runId);

      // 形状 (a)：to:"agent" + apply:"confirm"——confirm 豁免抑制（task-panel 抑制
      // 条件要求 apply !== "confirm"），park 即已投递：改投必须零重复发射。
      const { runId: a, promise: pa } = manager.startInBackground(CONSULT_CONFIRM_SCRIPT);
      await pa.catch(() => {});
      expect(manager.getRun(a)?.status).toBe("waiting_consult");
      expect(manager.getRun(a)?.pendingConsult).toMatchObject({
        opts: { to: "agent", apply: "confirm" },
        generation: 0,
      });
      expect(manager.getRun(a)?.pendingConsult?.to).toBeUndefined();
      expect(eventsFor(a)).toEqual([{ runId: a, prompt: "confirm this", opts: { to: "agent", apply: "confirm" } }]);
      expect(
        (await tool.execute("call-1", { action: "intervene", runId: a }, undefined, undefined, {} as never)).details
          ?.result,
      ).toBe("intervened");
      // 改投：opts 原样（hash 身份）、to 覆盖 "main"、代际 +1；改投后零重复发射——
      // 仍只有 park 那一条（无 to:"main" 覆盖 payload），主代理不会收到第二条。
      expect(manager.getRun(a)?.pendingConsult).toMatchObject({
        opts: { to: "agent", apply: "confirm" },
        to: "main",
        generation: 1,
      });
      expect(eventsFor(a)).toEqual([{ runId: a, prompt: "confirm this", opts: { to: "agent", apply: "confirm" } }]);

      // 形状 (b)：to 缺省（ConsultOptions.to 可选）——(undefined ?? undefined) !==
      // "agent"，park 即已投递：改投同样零重复发射。
      const { runId: b, promise: pb } = manager.startInBackground(CONSULT_NO_TO_SCRIPT);
      await pb.catch(() => {});
      expect(manager.getRun(b)?.status).toBe("waiting_consult");
      expect(eventsFor(b)).toEqual([{ runId: b, prompt: "confirm this", opts: { apply: "confirm" } }]);
      expect(
        (await tool.execute("call-1", { action: "intervene", runId: b }, undefined, undefined, {} as never)).details
          ?.result,
      ).toBe("intervened");
      expect(eventsFor(b)).toEqual([{ runId: b, prompt: "confirm this", opts: { apply: "confirm" } }]);

      // 纯 agent 形状：to:"agent" + 非 confirm（apply:"auto"）——原投递被投递层抑制
      // （链自治，不唤醒主代理），改投时才真正补发射一次（带 to:"main" 覆盖
      // payload）：park 那条（无 to 键）+ 改投那条 = 主代理恰好收到一条。
      const { manager: agentManager, agentRelease } = createBlockingAgentManager(cwd);
      const agentTool = createWorkflowControlTool({ manager: agentManager });
      const eventsC: Array<{ runId: string; prompt?: string; opts?: unknown; to?: unknown }> = [];
      agentManager.on("consult-pending", (e) => eventsC.push(e as never));
      const { runId: c, promise: pc } = agentManager.startInBackground(CONSULT_AGENT_AUTO_SCRIPT);
      await pc.catch(() => {});
      expect(agentManager.getRun(c)?.status).toBe("waiting_consult");
      expect(agentManager.getRun(c)?.pendingConsult).toMatchObject({ opts: { to: "agent", apply: "auto" } });
      expect(
        (await agentTool.execute("call-1", { action: "intervene", runId: c }, undefined, undefined, {} as never))
          .details?.result,
      ).toBe("intervened");
      expect(agentManager.getRun(c)?.pendingConsult).toMatchObject({
        opts: { to: "agent", apply: "auto" },
        to: "main",
        generation: 1,
      });
      expect(eventsC).toEqual([
        { runId: c, prompt: "confirm this", opts: { to: "agent", apply: "auto" } },
        { runId: c, prompt: "confirm this", opts: { to: "agent", apply: "auto" }, to: "main" },
      ]);
      agentRelease();
    } finally {
      cleanup(cwd);
    }
  });
});
