/**
 * 任务 4：自动审阅链（审阅子代理派生 + 文件落盘 + 预算 + 上限）。
 *
 * 覆盖（按任务简报 6 条 + 控制者裁定 + 双审查修复）：
 *  ① 链派生审阅者、读修订文件、parse 校验、applyReviewChain 应用、从 firstMiss
 *     续跑（consult 前调用 journal 重放不重跑）；consultAutoApplied === 1；
 *     outcome 如实报 applied:true + 链摘要（重要 2）；成功路径 tmp 清理（重要 3）；
 *  ② 非法修订脚本：带 parse 反馈重试一次后 markConsultFailed（含恢复指引文案）；
 *  ③ 前缀修改（consult 调用本身被改）→ 重放 miss → 重新挂起 re-pend；
 *     consultAutoApplied 失败也递增（两轮各 +1 → 2）；递增在临界区内同步落地（重要 1）；
 *  ④ autoApplied > 5：回落 waiting_consult + 发射 consult-limit（链不触发）；
 *     端到端投递「自动审阅超限」+ triggerTurn（重要 3 加固）；
 *  ⑤ 代际失配（intervene 改投）：在飞链结果被丢弃（无 journal 写、tmp 清理）；
 *  ⑥ 审阅链 token 花费计入运行预算（onUsage 累加进快照 tokenTotal；超预算按
 *     失败路径处理）；
 *  ⑦ confirm 模式：revisedScript/summary/revisedPath 落 pendingConsult +
 *     consult-review-ready（tmp 保留到 pending 消亡——reply 采纳后清理，次要 2）；
 *  ⑧ 审阅 agent 不写文件 → ENOENT 重试（缺文件原因分流反馈，次要 3）+ 二次写入应用；
 *  ⑨ confirm 链失败不 kill run（次要 1）：重试耗尽后保持 waiting_consult，
 *     用户仍可 reply。
 */

import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import { installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { hashConsult } from "../src/workflow.js";

interface Sent {
  customType?: string;
  content: string;
  triggerTurn?: boolean;
}

/** Minimal pi：捕获 sendMessage 的消息与 triggerTurn（投递断言用）。 */
function capturePi(
  sent: Sent[],
): {
  sendMessage(message: { customType?: string; content: string }, options?: { triggerTurn?: boolean }): void;
} {
  return {
    sendMessage(message: { customType?: string; content: string }, options?: { triggerTurn?: boolean }) {
      sent.push({ customType: message.customType, content: message.content, triggerTurn: options?.triggerTurn });
    },
  };
}

/** 先调 agent（live 执行），再 consult(to:agent, apply:auto) —— 验证重放续跑。 */
const CONSULT_THEN_AGENT_SCRIPT =
  'export const meta = { name: "auto-review-apply", description: "chain applies and resumes" };\n' +
  'const pre = await agent("pre", { label: "pre" });\n' +
  'const outcome = consult("please review this", { to: "agent", apply: "auto" });\n' +
  'return pre + "|" + (await agent("post", { label: "post" })) + "|" + outcome.summary;';

/** 链应用的修订版：consult 调用保持原样（hash 命中），但删掉了 post agent、改返回值。 */
const REVISED_SCRIPT =
  'export const meta = { name: "auto-review-apply", description: "chain applies and resumes" };\n' +
  'const pre = await agent("pre", { label: "pre" });\n' +
  'const outcome = consult("please review this", { to: "agent", apply: "auto" });\n' +
  'return "revised:" + pre + "|" + outcome.summary;';

/** 直接 consult(to:agent, apply:auto) 后不可达 —— 链失败/超限场景。 */
const CONSULT_ONLY_SCRIPT =
  'export const meta = { name: "auto-review-only", description: "chain-only consult" };\n' +
  'consult("review me", { to: "agent", apply: "auto" });\n' +
  "return 'unreachable';";

/** 先阻塞 agent 再 consult —— 用于预置 consultAutoApplied 后再触发 consult。 */
const BLOCK_THEN_CONSULT_SCRIPT =
  'export const meta = { name: "auto-review-limit", description: "cap fallback" };\n' +
  'await agent("go", { label: "go" });\n' +
  'consult("please review", { to: "agent", apply: "auto" });\n' +
  "return 'unreachable';";

/** consult(to:agent, apply:confirm)：链产出建议但不应用（裁定 4）。 */
const CONSULT_CONFIRM_SCRIPT =
  'export const meta = { name: "auto-review-confirm", description: "confirm mode" };\n' +
  'consult("confirm this", { to: "agent", apply: "confirm" });\n' +
  "return 'unreachable';";

/** confirm 模式的建议修订版：consult 调用保持原样（采纳后重放命中）。 */
const CONFIRM_REVISED_SCRIPT =
  'export const meta = { name: "auto-review-confirm", description: "confirm mode" };\n' +
  'consult("confirm this", { to: "agent", apply: "confirm" });\n' +
  "return 'adopted';";

/** 非法脚本：parseWorkflowScript 必抛。 */
const INVALID_SCRIPT = "export const meta = { name: \"broken\" };\nthis is not valid javascript {{{";

/** 每次审阅调用的行为（脚本内 agent() 调用一律走 mock 的普通回复分支）。 */
interface ReviewBehavior {
  /** 写入 tmpPath 的内容（缺省 = 不写文件 → 链读文件失败）。 */
  script?: string;
  /** run() 返回的文本（缺省 ""）。 */
  reply?: string;
  /** 审阅报告 usage（经 onUsage 回调）。 */
  usage?: AgentUsage;
  /** 阻塞直到外部 resolve（用于观测中间状态）；先写文件再阻塞。 */
  hold?: Promise<void>;
  /** 抛异常模拟审阅子代理调用失败（provider 错误）——走链的异常收尾路径。 */
  throwError?: Error;
}

interface ReviewMock {
  /** 审阅调用记录（prompt 全文，含 parse 反馈断言）。 */
  reviewCalls: string[];
  /** 脚本内 agent() 调用记录。 */
  scriptAgentCalls: string[];
}

/** 构造注入 mock 审阅执行器的 manager；审阅调用按 prompt 中的「写入文件 <path>」识别。 */
function createReviewManager(
  cwd: string,
  behavior: ReviewBehavior[],
  opts: Partial<WorkflowManagerOptions> = {},
): { manager: WorkflowManager; mock: ReviewMock } {
  const mock: ReviewMock = { reviewCalls: [], scriptAgentCalls: [] };
  const manager = new WorkflowManager({
    cwd,
    agent: {
      async run(prompt: string, options?: AgentRunOptions<never>) {
        const isReview = prompt.includes("写入文件 ");
        if (!isReview) {
          mock.scriptAgentCalls.push(prompt);
          return `reply-to:${prompt}`;
        }
        const callIndex = mock.reviewCalls.length;
        mock.reviewCalls.push(prompt);
        const b = behavior[Math.min(callIndex, behavior.length - 1)];
        // 模拟审阅子代理的 write 工具：先把修订脚本落盘到 prompt 指定的路径，
        // 再（可选）阻塞——在飞期间文件已存在，便于观测/干预。
        const tmpMatch = prompt.match(/写入文件 ([^\s（]+)/);
        if (b?.script !== undefined && tmpMatch) writeFileSync(tmpMatch[1]!, b.script);
        if (b?.hold) await b.hold;
        if (b?.usage) options?.onUsage?.(b.usage);
        if (b?.throwError) throw b.throwError;
        return b?.reply ?? "";
      },
    } as unknown as WorkflowManagerOptions["agent"],
    ...opts,
  });
  return { manager, mock };
}

/** 启动脚本并 settle 到 waiting_consult（链已在 catch 尾 fire-and-forget 触发）。 */
async function parkConsultRun(manager: WorkflowManager, script: string): Promise<string> {
  const { runId, promise } = manager.startInBackground(script);
  await promise.catch(() => {});
  expect(manager.getRun(runId)?.status).toBe("waiting_consult");
  return runId;
}

/**
 * 轮询等待条件成立（用于观测 fire-and-forget 链的副作用——链丢弃结果时没有事件
 * 可 await，只能轮询 tmp 文件/状态；条件一满足即返回，不引入固定睡眠）。
 */
async function waitFor(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`waitFor 超时：${label}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

function cleanup(cwd: string): void {
  rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

describe("auto review chain (to:agent apply:auto)", () => {
  test("① derives reviewer, reads revised file, validates, applies, resumes from firstMiss; consultAutoApplied === 1", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-apply-"));
    try {
      const { manager, mock } = createReviewManager(cwd, [
        { script: REVISED_SCRIPT, reply: JSON.stringify({ ok: true, summary: "已修订：去掉 post" }) },
      ]);
      const completed = once(manager, "complete");
      const { runId } = manager.startInBackground(CONSULT_THEN_AGENT_SCRIPT);
      const [{ runId: completedRunId, result }] = (await completed) as [
        { runId: string; result: { result: unknown } },
      ];
      expect(completedRunId).toBe(runId);

      // 运行完成（consult 重放命中，未 re-pend）；结果来自链应用的修订脚本。
      expect(manager.getRun(runId)?.status).toBe("completed");
      expect(String(result.result)).toContain("revised:");
      // 双审查重要 2：auto 应用后 outcome 如实报 applied:true + 链摘要（不再报
      // 维持原脚本）——脚本里 outcome.summary 即链摘要。
      expect(String(result.result)).toContain("已修订：去掉 post");

      // 派生审阅者恰好一次；pre agent 只 live 跑过一次（重放不重跑）；post 被修订版删掉。
      expect(mock.reviewCalls).toHaveLength(1);
      expect(mock.scriptAgentCalls.filter((p) => p.includes("pre"))).toHaveLength(1);
      expect(mock.scriptAgentCalls.filter((p) => p.includes("post"))).toHaveLength(0);

      // consultAutoApplied === 1（内存 + 落盘；重要 1：递增在 resolveConsult 临界
      // 区内与 persistRun 同一次 save——无需轮询，直接断言）。
      expect(manager.getRun(runId)?.consultAutoApplied).toBe(1);
      expect(manager.getPersistence().load(runId)?.consultAutoApplied).toBe(1);

      // 重要 3（测试加固）：成功路径 tmp 清理（⑤ 只覆盖丢弃路径）。
      const tmpMatch = mock.reviewCalls[0]!.match(/写入文件 ([^\s（]+)/);
      expect(tmpMatch).not.toBeNull();
      expect(existsSync(tmpMatch![1]!)).toBe(false);

      // journal：consult 条目按原 hash 落盘（重放命中的依据；完成态磁盘 journal
      // 被 writeRunToDisk 丢弃，读内存 managed 的 journal——条目在 resolveConsult
      // 应用时已追加）。
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal.find((e) => e.index === 1)).toEqual({
        index: 1,
        runId,
        hash: hashConsult("please review this", { to: "agent", apply: "auto" }),
        result: { applied: true, summary: "已修订：去掉 post", revisedScript: REVISED_SCRIPT },
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("② invalid revised script: retries once with parse feedback, then markConsultFailed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-invalid-"));
    try {
      const { manager, mock } = createReviewManager(cwd, [
        { script: INVALID_SCRIPT, reply: JSON.stringify({ ok: true, summary: "s1" }) },
        { script: INVALID_SCRIPT, reply: JSON.stringify({ ok: true, summary: "s2" }) },
      ]);
      const errorEvent = once(manager, "error");
      const { promise } = manager.startInBackground(CONSULT_ONLY_SCRIPT);
      const [{ runId, error }] = (await errorEvent) as [{ runId: string; error: { message: string } }];
      await promise.catch(() => {});

      // 重试一次：共两次审阅调用，第二次 prompt 带上次 parse 错误反馈。
      expect(mock.reviewCalls).toHaveLength(2);
      expect(mock.reviewCalls[1]!).toContain("上一次审阅产出的脚本未通过解析");
      expect(mock.reviewCalls[1]!).toContain(mock.reviewCalls[0]!.slice(0, 50)); // 反馈追加在完整 prompt 之后

      // markConsultFailed 文案含恢复指引（裁定 7）。
      expect(error.message).toContain("审阅子代理未能产出可解析的修改后脚本");
      expect(error.message).toContain("请用 /workflows resume 带脚本恢复（咨询将重新挂起，届时可答复）");
      expect(manager.getRun(runId)?.status).toBe("failed");

      // 失败也递增 consultAutoApplied === 1；journal 落 settled:false 条目。
      expect(manager.getPersistence().load(runId)?.consultAutoApplied).toBe(1);
      const journal = manager.getPersistence().load(runId)?.journal ?? [];
      expect(journal[journal.length - 1]).toEqual({
        index: 0,
        runId,
        hash: hashConsult("review me", { to: "agent", apply: "auto" }),
        result: { applied: false, reason: error.message, settled: false },
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("③ prefix change causes re-pend; consultAutoApplied increments on failure too", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-repend-"));
    try {
      // 第 1 轮：修订版改了 consult 调用（review me → q2）→ 重放 miss → 重新挂起。
      // 第 2 轮：产出非法脚本 → 链失败 markConsultFailed（第 2 轮也 +1）。
      // 第 2 轮 mock hold 住：re-pend 后的中间状态可确定性观测（run 停在
      // waiting_consult，不被第 2 轮立刻终结）。
      const { promise: hold2, resolve: release2 } = Promise.withResolvers<void>();
      const { manager } = createReviewManager(cwd, [
        {
          script:
            'export const meta = { name: "auto-review-repend", description: "re-pend" };\n' +
            'consult("q2", { to: "agent", apply: "auto" });\n' +
            "return 'unreachable';",
          reply: JSON.stringify({ ok: true, summary: "改了咨询内容" }),
        },
        { script: INVALID_SCRIPT, reply: JSON.stringify({ ok: true, summary: "s2" }), hold: hold2 },
      ]);
      // 首次挂起后不断言状态（链第 1 轮可能已应用并 resume，状态竞态）——
      // 以第 2 次 consult-pending（re-pend）作为确定性信号。
      const { runId, promise } = manager.startInBackground(CONSULT_ONLY_SCRIPT);
      await promise.catch(() => {});
      const repended = once(manager, "consult-pending");
      const [{ runId: rependedRunId }] = (await repended) as [{ runId: string }];
      expect(rependedRunId).toBe(runId);
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
      // 第 1 轮链应用成功：+1 已在 resolveConsult 临界区内与 persistRun 同一次
      // save 落地（重要 1）——re-pend 时必然可见，直接断言。
      expect(manager.getRun(runId)?.consultAutoApplied).toBe(1);

      // 释放第 2 轮：非法脚本 → 链失败 → run failed，autoApplied === 2。
      const errorEvent = once(manager, "error");
      release2();
      const [{ error }] = (await errorEvent) as [{ error: { message: string } }];
      expect(error.message).toContain("审阅子代理未能产出可解析的修改后脚本");
      expect(manager.getRun(runId)?.status).toBe("failed");
      // 第 2 轮失败链的 +1 在 markConsultFailed 临界区内、error 事件发射前已随
      // persistRun 落地（重要 1）——直接断言。
      expect(manager.getPersistence().load(runId)?.consultAutoApplied).toBe(2);

      // journal 两条：q1 已解决（重放命中依据）+ q2 未解决（settled:false，最后一条）。
      const journal = manager.getPersistence().load(runId)?.journal ?? [];
      expect(journal[0]).toEqual({
        index: 0,
        runId,
        hash: hashConsult("review me", { to: "agent", apply: "auto" }),
        // 双审查重要 2：链应用 → applied:true + 链摘要 + 已应用脚本。
        result: {
          applied: true,
          summary: "改了咨询内容",
          revisedScript:
            'export const meta = { name: "auto-review-repend", description: "re-pend" };\n' +
            'consult("q2", { to: "agent", apply: "auto" });\n' +
            "return 'unreachable';",
        },
      });
      expect(journal[journal.length - 1]!.hash).toBe(hashConsult("q2", { to: "agent", apply: "auto" }));
      expect(journal[journal.length - 1]!.result).toEqual({
        applied: false,
        reason: error.message,
        settled: false,
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("④ autoApplied > 5: falls back to waiting_consult + emits consult-limit, chain not started; 投递「自动审阅超限」+ triggerTurn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-limit-"));
    try {
      const { promise: releasePromise, resolve: releaseAgent } = Promise.withResolvers<void>();
      const { promise: beganPromise, resolve: began } = Promise.withResolvers<void>();
      let reviewCalled = 0;
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string) {
            if (!prompt.includes("写入文件 ")) {
              began();
              await releasePromise;
              return "go-done";
            }
            reviewCalled++;
            return "";
          },
        } as unknown as WorkflowManagerOptions["agent"],
      });
      // 重要 3（测试加固）：安装 result delivery + mock pi——断言超限消息的
      // 端到端投递与 triggerTurn（接线见 consult-delivery ⑧，这里走真实事件流）。
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});
      const { runId, promise } = manager.startInBackground(BLOCK_THEN_CONSULT_SCRIPT);
      await beganPromise;

      // 阻塞期间预置 consultAutoApplied = 6（> 5）——下一次 consult 触发上限回落。
      const seeded = manager.getPersistence().load(runId)!;
      manager.getPersistence().save({ ...seeded, consultAutoApplied: 6 });

      const limitEvent = once(manager, "consult-limit");
      releaseAgent();
      const [{ runId: limitedRunId }] = (await limitEvent) as [{ runId: string }];
      await promise.catch(() => {});
      expect(limitedRunId).toBe(runId);

      // 回落 waiting_consult；审阅链未被派生（零审阅调用）。
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(reviewCalled).toBe(0);

      // 端到端：consult-limit → 投递「自动审阅超限」+ 唤醒主代理。
      expect(sent).toHaveLength(1);
      expect(sent[0]!.content).toContain(runId);
      expect(sent[0]!.content).toContain("自动审阅超限");
      expect(sent[0]!.content).toContain("等待人工答复");
      expect(sent[0]!.triggerTurn).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });

  test("⑤ generation mismatch: in-flight chain result is discarded (no journal write, tmp cleaned)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-stale-"));
    try {
      const { promise: holdPromise, resolve: holdRelease } = Promise.withResolvers<void>();
      const { manager, mock } = createReviewManager(cwd, [
        { script: REVISED_SCRIPT, reply: JSON.stringify({ ok: true, summary: "stale" }), hold: holdPromise },
      ]);
      const runId = await parkConsultRun(manager, CONSULT_ONLY_SCRIPT);
      // 关键 3：tmp 文件名带 nonce——从审阅 prompt 里取实际路径，不再猜测。
      const tmpMatch = mock.reviewCalls[0]!.match(/写入文件 ([^\s（]+)/);
      expect(tmpMatch).not.toBeNull();
      const tmpPath = tmpMatch![1]!;
      await waitFor(() => existsSync(tmpPath), "审阅者落盘修订脚本");

      // 审阅在飞时 intervene()：改投 "main" + 代际 0 → 1 —— 在飞链结果必须作废。
      expect(manager.intervene(runId)).toBe(true);
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);
      expect(manager.getRun(runId)?.pendingConsult?.to).toBe("main");

      holdRelease();
      await waitFor(() => !existsSync(tmpPath), "失配结果丢弃后 tmp 清理");

      // 无 journal 写入、run 保持 waiting_consult（intervene 的 pending 未被触碰）。
      expect(manager.getPersistence().load(runId)?.journal ?? []).toEqual([]);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(1);
    } finally {
      cleanup(cwd);
    }
  });

  test("⑥ review chain token spend counts into the run budget (and over-budget fails the chain)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-budget-"));
    const tightCwd = mkdtempSync(join(tmpdir(), "omp-review-budget-tight-"));
    try {
      // 预算充足：审阅 usage 累加进快照 tokenTotal 并随 persistRun 落盘。
      const usage: AgentUsage = { input: 400, output: 600, cost: 0.01, cacheRead: 0, cacheWrite: 0, total: 1000 };
      const { manager } = createReviewManager(
        cwd,
        [{ script: CONSULT_ONLY_SCRIPT, reply: JSON.stringify({ ok: true, summary: "ok" }), usage }],
        { defaultTokenBudget: 5000 },
      );
      const completed = once(manager, "complete");
      const { runId } = manager.startInBackground(CONSULT_ONLY_SCRIPT);
      await completed;

      expect(manager.getRun(runId)?.status).toBe("completed");
      expect(manager.getRun(runId)?.snapshot.tokenUsage?.total).toBe(1000);
      expect(manager.getPersistence().load(runId)?.tokenUsage?.total).toBe(1000);

      // 超预算（审阅 1000 > 500）：链按失败路径处理 → markConsultFailed。
      const { manager: tightManager } = createReviewManager(
        tightCwd,
        [{ script: CONSULT_ONLY_SCRIPT, reply: JSON.stringify({ ok: true, summary: "ok" }), usage }],
        { defaultTokenBudget: 500 },
      );
      const errorEvent = once(tightManager, "error");
      const { runId: tightRunId, promise: tightPromise } = tightManager.startInBackground(CONSULT_ONLY_SCRIPT);
      const [{ error }] = (await errorEvent) as [{ error: { message: string } }];
      await tightPromise.catch(() => {});
      expect(error.message).toContain("自动审阅链 token 花费超出运行预算（500）");
      expect(error.message).toContain("请用 /workflows resume 带脚本恢复");
      expect(tightManager.getPersistence().load(tightRunId)?.consultAutoApplied).toBe(1);
    } finally {
      cleanup(cwd);
      cleanup(tightCwd);
    }
  });

  test("⑦ confirm 模式（裁定 4）：链产出建议不应用——revisedScript/summary/revisedPath 落 pendingConsult + 发射 consult-review-ready（tmp 保留到 pending 消亡，autoApplied 不递增）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-confirm-"));
    try {
      const { manager } = createReviewManager(cwd, [
        { script: CONFIRM_REVISED_SCRIPT, reply: JSON.stringify({ ok: true, summary: "建议：并行化" }) },
      ]);
      const reviewReady = once(manager, "consult-review-ready");
      const { runId, promise } = manager.startInBackground(CONSULT_CONFIRM_SCRIPT);
      const [{ runId: readyRunId, summary, revisedPath }] = (await reviewReady) as [
        { runId: string; summary?: string; revisedPath?: string },
      ];
      await promise.catch(() => {});

      expect(readyRunId).toBe(runId);
      expect(summary).toBe("建议：并行化");

      // 未应用：run 仍停在 waiting_consult；pendingConsult 持有建议（采纳时
      // resolveConsult 的 confirm 分支消费 revisedScript）+ 建议文件路径（次要 2）。
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.revisedScript).toBe(CONFIRM_REVISED_SCRIPT);
      expect(manager.getRun(runId)?.pendingConsult?.summary).toBe("建议：并行化");
      expect(manager.getRun(runId)?.pendingConsult?.revisedPath).toBe(revisedPath);
      // 建议落盘路径真实存在且 tmp 保留（关键 3：nonce 文件名，含 runId 与代际）。
      expect(revisedPath).toContain(`consult-${runId}-0-1-`);
      expect(revisedPath!.startsWith(tmpdir())).toBe(true);
      expect(existsSync(revisedPath!)).toBe(true);
      // confirm 既非成功应用也非失败：consultAutoApplied 不递增。
      expect(manager.getPersistence().load(runId)?.consultAutoApplied).toBeUndefined();

      // 次要 2：用户采纳（reply 无 script）→ pending 消亡 → 建议文件被清理。
      const completed = once(manager, "complete");
      expect(await manager.resolveConsult(runId)).toBe(true);
      await completed;
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(existsSync(revisedPath!)).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  test("⑧ 重要 3：审阅 agent 不写文件 → ENOENT 重试（带「缺文件」反馈）→ 第二次写入后应用", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-enoent-"));
    try {
      const { manager, mock } = createReviewManager(cwd, [
        { reply: JSON.stringify({ ok: true, summary: "s1" }) }, // 第一次：不写文件 → ENOENT
        { script: REVISED_SCRIPT, reply: JSON.stringify({ ok: true, summary: "s2" }) },
      ]);
      const completed = once(manager, "complete");
      const { runId } = manager.startInBackground(CONSULT_THEN_AGENT_SCRIPT);
      await completed;

      // 两次审阅调用；第二次 prompt 带「缺文件」原因分流文案（次要 3）。
      expect(mock.reviewCalls).toHaveLength(2);
      expect(mock.reviewCalls[1]!).toContain("上一次审阅没有把修改后的完整脚本写入指定文件");

      // 第二次写入生效：run 完成，结果来自修订脚本。
      expect(manager.getRun(runId)?.status).toBe("completed");
      expect(manager.getRun(runId)?.consultAutoApplied).toBe(1);
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal.find((e) => e.index === 1)?.result).toEqual({
        applied: true,
        summary: "s2",
        revisedScript: REVISED_SCRIPT,
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("⑨ 次要 1：confirm 链失败不 kill run——重试耗尽后保持 waiting_consult（无 error 事件、无 settled:false、不递增），用户仍可 reply", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-confirm-fail-"));
    try {
      const { manager, mock } = createReviewManager(cwd, [
        { reply: JSON.stringify({ ok: false, reason: "无法修订" }) },
        { reply: JSON.stringify({ ok: false, reason: "无法修订" }) },
      ]);
      const errors: unknown[] = [];
      manager.on("error", (e) => errors.push(e));
      const { runId, promise } = manager.startInBackground(CONSULT_CONFIRM_SCRIPT);
      await promise.catch(() => {});

      // 等链把两次审阅尝试跑完（fire-and-forget，无事件可 await——以审阅调用
      // 计数为信号）。
      await waitFor(() => mock.reviewCalls.length === 2, "confirm 链两次审阅尝试");

      // 不 markConsultFailed：run 保持 waiting_consult、无 error 事件、无
      // settled:false journal、consultAutoApplied 不递增——用户仍可 reply。
      expect(errors).toEqual([]);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getPersistence().load(runId)?.journal ?? []).toEqual([]);
      expect(manager.getPersistence().load(runId)?.consultAutoApplied).toBeUndefined();

      // 用户 reply 仍可正常收口（标准咨询消息已在 park 时投递）。
      const completed = once(manager, "complete");
      expect(await manager.resolveConsult(runId)).toBe(true);
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
    } finally {
      cleanup(cwd);
    }
  });

  test("⑩ 关键 2：fresh park 回收代际数字（同为 0）——在飞旧链靠 pendingConsult 对象身份丢弃，不误应用到新咨询", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-identity-"));
    try {
      // 脚本两个咨询点：q1 由用户 reply 收口，恢复后命中 q2 重新挂起——fresh
      // park 的 generation 仍旧 0，纯代际比较会放行旧链（正是关键 2 的回收缺陷）。
      const TWO_CONSULT_SCRIPT =
        'export const meta = { name: "auto-review-identity", description: "identity staleness" };\n' +
        'consult("q1", { to: "agent", apply: "auto" });\n' +
        'consult("q2", { to: "agent", apply: "auto" });\n' +
        "return 'unreachable';";
      const TWO_CONSULT_REVISED =
        'export const meta = { name: "auto-review-identity", description: "identity staleness" };\n' +
        'consult("q1", { to: "agent", apply: "auto" });\n' +
        'consult("q2", { to: "agent", apply: "auto" });\n' +
        "return 'revised-ok';";
      const { promise: holdA, resolve: releaseA } = Promise.withResolvers<void>();
      const { promise: holdB, resolve: releaseB } = Promise.withResolvers<void>();
      const { manager, mock } = createReviewManager(cwd, [
        { script: TWO_CONSULT_REVISED, reply: JSON.stringify({ ok: true, summary: "stale-A" }), hold: holdA },
        { script: TWO_CONSULT_REVISED, reply: JSON.stringify({ ok: true, summary: "fresh-B" }), hold: holdB },
      ]);
      const { runId, promise } = manager.startInBackground(TWO_CONSULT_SCRIPT);
      await promise.catch(() => {});

      // 链 A（针对 q1）在飞并已落盘。
      await waitFor(() => mock.reviewCalls.length === 1, "链 A 审阅在飞");
      const tmpA = mock.reviewCalls[0]!.match(/写入文件 ([^\s（]+)/)![1]!;

      // 用户 reply 收口 q1（无 summary → 不递增）→ 恢复脚本 → q2 重新挂起。
      const repended = once(manager, "consult-pending");
      expect(await manager.resolveConsult(runId)).toBe(true);
      const [{ runId: rependedRunId }] = (await repended) as [{ runId: string }];
      expect(rependedRunId).toBe(runId);
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
      // 代际数字被 fresh park 回收为 0——与链 A 捕获时相同，generation 无法区分。
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(0);

      // 链 B（针对 q2）启动在飞；释放链 A——其对象身份已失配，必须静默丢弃。
      await waitFor(() => mock.reviewCalls.length === 2, "链 B 审阅在飞");
      releaseA();
      // 链 A 的 tmp 被清理；q2 的 pending 未被 A 触碰（无 revisedScript/summary）、
      // journal 无 q2 条目。
      await waitFor(() => !existsSync(tmpA), "链 A 陈旧结果丢弃后 tmp 清理");
      expect(manager.getRun(runId)?.pendingConsult?.revisedScript).toBeUndefined();
      expect(manager.getRun(runId)?.pendingConsult?.summary).toBeUndefined();
      expect(manager.getRun(runId)?.journal ?? []).toHaveLength(1); // 只有 q1 的用户 reply 条目

      // 链 B 正常应用 q2：唯一递增 + applied:true + fresh-B 摘要。
      const completed = once(manager, "complete");
      releaseB();
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
      expect(manager.getRun(runId)?.consultAutoApplied).toBe(1);
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal[journal.length - 1]!.result).toEqual({
        applied: true,
        summary: "fresh-B",
        revisedScript: TWO_CONSULT_REVISED,
      });
    } finally {
      cleanup(cwd);
    }
  });

  test("⑪ 复检 B 关键 2 残留：异常耗尽路径同样校验对象身份——陈旧链耗尽后不 markConsultFailed（fresh 咨询不被误杀）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-review-exhaust-stale-"));
    try {
      // 与 ⑩ 同构：q1 由用户 reply 收口，恢复后命中 q2 重新挂起（代际数字回收为 0，
      // 纯 generation 无法区分）。区别：链 A 两次尝试全部抛异常（provider 错误）→
      // catch 直接 continue → 循环耗尽走异常收尾路径。修复前该路径无 stale() 校验，
      // markConsultFailed 的 status 守卫（waiting_consult 且 pending 存在）会通过并
      // 误杀 fresh q2；修复后静默丢弃。
      const TWO_CONSULT_SCRIPT =
        'export const meta = { name: "auto-review-exhaust", description: "exhaustion identity" };\n' +
        'consult("q1", { to: "agent", apply: "auto" });\n' +
        'consult("q2", { to: "agent", apply: "auto" });\n' +
        "return 'unreachable';";
      const TWO_CONSULT_REVISED =
        'export const meta = { name: "auto-review-exhaust", description: "exhaustion identity" };\n' +
        'consult("q1", { to: "agent", apply: "auto" });\n' +
        'consult("q2", { to: "agent", apply: "auto" });\n' +
        "return 'revised-ok';";
      const { promise: holdA, resolve: releaseA } = Promise.withResolvers<void>();
      const { promise: holdB, resolve: releaseB } = Promise.withResolvers<void>();
      const errors: unknown[] = [];
      // 行为按累计 reviewCalls 索引：调用顺序确定（A1 → B1 → A2 → B2，每步由上一
      // 步触发），故各链各尝试的行为可精确指派。链 A（q1）两次尝试全部抛异常 →
      // 异常收尾耗尽；链 B（q2）尝试 1 抛异常、尝试 2 成功应用。
      const { manager, mock } = createReviewManager(cwd, [
        // 链 A 尝试 1：先 hold（在飞）再抛异常。
        { hold: holdA, throwError: new Error("provider boom") },
        // 链 B 尝试 1：hold（在飞，阻塞其自身耗尽）再抛异常——保证 q2 在链 A
        // 耗尽时仍是活咨询，观测窗口不被链 B 抢先收口。
        { hold: holdB, throwError: new Error("provider boom") },
        // 链 A 尝试 2：直接抛异常 → 循环耗尽，走异常收尾路径。
        { throwError: new Error("provider boom") },
        // 链 B 尝试 2：写修订脚本 + 成功回复 → 应用 q2。
        { script: TWO_CONSULT_REVISED, reply: JSON.stringify({ ok: true, summary: "fresh-B" }) },
      ]);
      manager.on("error", (e) => errors.push(e));
      const { runId, promise } = manager.startInBackground(TWO_CONSULT_SCRIPT);
      await promise.catch(() => {});

      // 链 A（针对 q1）在飞（hold 中）。
      await waitFor(() => mock.reviewCalls.length === 1, "链 A 尝试 1 在飞");

      // 用户 reply 收口 q1 → 恢复 → q2 fresh re-park（代际数字回收为 0）。
      const repended = once(manager, "consult-pending");
      expect(await manager.resolveConsult(runId)).toBe(true);
      const [{ runId: rependedRunId }] = (await repended) as [{ runId: string }];
      expect(rependedRunId).toBe(runId);
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
      expect(manager.getRun(runId)?.pendingConsult?.generation).toBe(0);

      // 链 B（针对 q2）启动在飞；释放链 A——异常收尾，对象身份已失配。
      await waitFor(() => mock.reviewCalls.length === 2, "链 B 审阅在飞");
      releaseA();
      // reviewCalls === 3 即链 A 尝试 2 已被记录、循环耗尽；其后同步续体
      // （rmSync → stale() → return）在微任务中先于下一轮计时器轮询冲刷完毕。
      // 修复前此处会 markConsultFailed：run 判 failed、settled:false journal、
      // error 事件、consultAutoApplied 误 +1——以下断言全红。
      await waitFor(() => mock.reviewCalls.length === 3, "链 A 两次尝试耗尽");
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult?.prompt).toBe("q2");
      expect(manager.getRun(runId)?.pendingConsult?.revisedScript).toBeUndefined();
      expect(manager.getRun(runId)?.journal ?? []).toHaveLength(1); // 只有 q1 的用户 reply 条目
      expect(manager.getRun(runId)?.consultAutoApplied).toBeUndefined(); // 未被误 +1（与 ⑨ 同约定）
      expect(errors).toEqual([]);

      // 链 B 正常应用 q2：唯一递增 + applied:true + fresh-B 摘要（未被陈旧链 A 误杀）。
      const completed = once(manager, "complete");
      releaseB();
      await completed;
      expect(manager.getRun(runId)?.status).toBe("completed");
      expect(manager.getRun(runId)?.consultAutoApplied).toBe(1);
      const journal = manager.getRun(runId)?.journal ?? [];
      expect(journal[journal.length - 1]!.result).toEqual({
        applied: true,
        summary: "fresh-B",
        revisedScript: TWO_CONSULT_REVISED,
      });
    } finally {
      cleanup(cwd);
    }
  });
});
