/**
 * 任务 6：投递出口与同步路径（deliverWorkflowMessage + phaseNotify + 报错文案）。
 *
 * 覆盖（按任务简报 6 条 + 控制者裁定）：
 *  ① consult-pending (to:main) 投递 customType=workflow.consult，正文含 runId、
 *     prompt 摘要（前 200 字）与 reply 指引，且先补投当前 phase 行（顺序保证）；
 *  ② phaseNotify 行 triggerTurn:false 且不唤醒（mock pi 断言 triggerTurn 参数）；
 *  ③ web 控制台启动的 run 的 consult 投递不 triggerTurn（isSilentOrigin 注入）；
 *  ④ confirm 模式：consult-review-ready 投递建议摘要 + 落盘路径 + 采纳指引
 *     （事件尚未落地，用 manager.emit 手动触发）；
 *  ⑤ 同步路径报错文案按 payload.opts.to 分流（文案构造函数 + 经真实
 *     createWorkflowTool().execute 的 CONSULT_PENDING 分支）；
 *  ⑥ settings：phaseNotify off 抑制 phase 行（normalize 缺省即省略 + 投递侧抑制，
 *     consult 消息不受影响）；
 *  ⑦ 双审查发现 2：consult-pending 带 opts 分流——to:agent 非 confirm 不投递
 *     （审阅链自治，防任务 4 落地后误唤醒主代理），to:main / apply:confirm 照常；
 *  ⑧ 双审查发现 2：consult-limit 预接线（任务 4 将发射，先 wire 好）——投递
 *     「自动审阅超限」+ wakesTurn；
 *  ⑨ 双审查发现 3：complete 补投当前 phase 行（spec §7 强制行为）——先补投
 *     进度行（triggerTurn:false）再投结果；
 *  ⑩ 双审查发现 6：phase 行真实数据——done/total 与 token 后缀（fresh+cacheRead，
 *     与 renderRunBody 同取法）。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { compactTokens, aggregateAgentUsage } from "../src/display.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { consultPendingSyncText, createWorkflowTool } from "../src/workflow-tool.js";
import { normalizeSettings, type WorkflowSettings } from "../src/workflow-settings.js";

/** 长 prompt：> 200 字，验证摘要截断到前 200 字。 */
const LONG_PROMPT = "请审核这段关键业务逻辑的并发安全与失败回滚设计，给出可执行的修订意见。".repeat(10);

/** 先进入命名阶段再触发 consult(to:main)：验证「先补投 phase 行、再发咨询消息」。 */
const CONSULT_MAIN_SCRIPT =
  'export const meta = { name: "consult-deliver", description: "delivery probe", phases: [{ title: "alpha" }] };\n' +
  'phase("alpha");\n' +
  `consult("${LONG_PROMPT}", { to: "main" });\n` +
  "return 'unreachable';";

/** 无阶段声明、直接 consult(to:agent) 的脚本（consult 消息唯一）。 */
const CONSULT_AGENT_SCRIPT =
  'export const meta = { name: "consult-agent", description: "delivery probe" };\n' +
  'consult("请审核以下方案。", { to: "agent" });\n' +
  "return 'unreachable';";

/** 常驻运行（agent 永不自行结束）——用于手动 emit phase 事件的投递断言。 */
const BLOCKING_SCRIPT =
  'export const meta = { name: "phase_probe", description: "p" };\n' +
  'return await agent("go", { label: "w" });\n';

interface Sent {
  customType?: string;
  content: string;
  triggerTurn?: boolean;
}

/** Minimal pi：捕获 sendMessage 的消息与 triggerTurn。 */
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

/**
 * 全新 manager + 先装投递再启动 consult 脚本，settle 到 waiting_consult。
 * 投递必须早于启动：consult-pending 事件在 settle 时同步发出，晚装会漏接。
 */
async function startConsultRun(
  cwd: string,
  script: string,
  sent: Sent[],
  opts: { isSilentOrigin?: (runId: string) => boolean; loadSettings?: () => WorkflowSettings } = {},
): Promise<{ manager: WorkflowManager; runId: string }> {
  const manager = new WorkflowManager({ cwd });
  installResultDelivery(capturePi(sent) as never, manager, opts);
  const { runId, promise } = manager.startInBackground(script);
  await promise.catch(() => {});
  expect(manager.getRun(runId)?.status).toBe("waiting_consult");
  return { manager, runId };
}

/** 常驻 agent：run 保持 running，永不自行结束。 */
function blockingManager(cwd: string, started: { resolve?: () => void }): WorkflowManager {
  return new WorkflowManager({
    cwd,
    agent: {
      run(_prompt: string, options?: AgentRunOptions<never>) {
        started.resolve?.();
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Subagent was aborted")), { once: true });
        });
      },
    } as unknown as WorkflowManagerOptions["agent"],
  });
}

function cleanup(cwd: string): void {
  rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

describe("consult delivery", () => {
  test("① consult-pending (to:main) 先补投 phase 行，再投 customType=workflow.consult 的咨询消息（runId + prompt 摘要 + reply 指引）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-deliver-"));
    try {
      const sent: Sent[] = [];
      const { runId } = await startConsultRun(cwd, CONSULT_MAIN_SCRIPT, sent);

      expect(sent).toHaveLength(2);
      // 顺序保证（裁定 5）：consult-pending 分支先补投当前 phase 行、再发咨询消息。
      expect(sent[0]!.content).toContain(`阶段「alpha」`);
      expect(sent[0]!.triggerTurn).toBe(false);
      expect(sent[1]!.customType).toBe("workflow.consult");
      expect(sent[1]!.content).toContain(runId);
      expect(sent[1]!.content).toContain(LONG_PROMPT.slice(0, 200));
      expect(sent[1]!.content).not.toContain(LONG_PROMPT);
      expect(sent[1]!.content).toContain(`请用 workflow_control 的 reply 动作回复（runId=${runId}）`);
      expect(sent[1]!.triggerTurn).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });

  test("② phaseNotify 行以 triggerTurn:false 投递，不唤醒（mock pi 断言 triggerTurn 参数）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-phase-notify-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});

      // 每个 phase 开始时投递上一 phase 的进度行：首个 phase 无上一行，第二个才补投。
      manager.emit("phase", { runId, title: "phase-a" });
      manager.emit("phase", { runId, title: "phase-b" });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.content).toContain(`阶段「phase-a」`);
      expect(sent[0]!.content).toContain("0/0");
      // 进度行一律不唤醒（裁定 3：phaseNotify 行 → false）。
      expect(sent[0]!.triggerTurn).toBe(false);
      expect(sent.every((m) => m.triggerTurn === false)).toBe(true);

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("③ web 控制台启动的 run：consult 消息照常投递但不 triggerTurn（isSilentOrigin 注入）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-silent-"));
    try {
      const sent: Sent[] = [];
      // to:agent 非 confirm 的咨询不投递（见 ⑦），此处用 to:main 验证投递 + 静默。
      const { runId } = await startConsultRun(cwd, CONSULT_MAIN_SCRIPT, sent, { isSilentOrigin: () => true });

      expect(sent).toHaveLength(2);
      expect(sent[0]!.triggerTurn).toBe(false); // phase 行
      expect(sent[1]!.customType).toBe("workflow.consult");
      expect(sent[1]!.content).toContain(runId);
      // 裁定 3：consult-pending（to:main/confirm）→ wakesTurn(runId)，web 启动不唤醒。
      expect(sent[1]!.triggerTurn).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  test("④ confirm 模式：consult-review-ready 投递建议摘要 + 落盘路径 + 「reply 无 script 即采纳」", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-review-"));
    try {
      const sent: Sent[] = [];
      // to:agent 非 confirm 不投递（见 ⑦），confirm 场景用 to:main 起 run 验证。
      const { manager, runId } = await startConsultRun(cwd, CONSULT_MAIN_SCRIPT, sent);
      expect(sent).toHaveLength(2); // phase 行 + 咨询消息
      expect(sent[1]!.customType).toBe("workflow.consult");

      // 任务 4 尚未实现该事件——监听先 wire 好，用 manager.emit 手动触发。
      const summary = "建议改用并行 fan-out 并补全失败回滚";
      const revisedPath = join(tmpdir(), "omp-consult-rev-", `${runId}.rev.js`);
      manager.emit("consult-review-ready", { runId, summary, revisedPath });

      expect(sent).toHaveLength(3);
      expect(sent[2]!.content).toContain(summary);
      expect(sent[2]!.content).toContain(revisedPath);
      expect(sent[2]!.content).toContain(`reply 动作回复（runId=${runId}`);
      expect(sent[2]!.content).toContain("不附 script");
      expect(sent[2]!.triggerTurn).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });

  test("⑤ 同步路径：consult 报错文案按 to 分流（agent 提及自动审阅链，main 提及 reply 动作）", async () => {
    // 文案构造函数（简报允许直接测）。
    expect(consultPendingSyncText("run-1", "agent")).toContain("运行 run-1 已暂停等待咨询答复");
    expect(consultPendingSyncText("run-1", "agent")).toContain("自动审阅链已在后台执行");
    expect(consultPendingSyncText("run-1", "agent")).toContain("结果将以 follow-up 投递");
    expect(consultPendingSyncText("run-1", undefined)).toBe(consultPendingSyncText("run-1", "agent"));
    expect(consultPendingSyncText("run-1", "main")).toContain("运行 run-1 已暂停等待主代理答复");
    expect(consultPendingSyncText("run-1", "main")).toContain("请用 workflow_control 的 reply 动作回复（runId=run-1）");
    expect(consultPendingSyncText("run-1", "main")).toContain("/workflows status run-1");

    // 集成：经真实 createWorkflowTool().execute 的同步分支 + CONSULT_PENDING 识别。
    for (const to of ["agent", "main"] as const) {
      const cwd = mkdtempSync(join(tmpdir(), "omp-consult-sync-"));
      try {
        const manager = {
          startInBackground: async () => ({ runId: "bg-1" }),
          resume: async () => null,
          runSync: async () => {
            throw new WorkflowError("consult pending: script paused for review", WorkflowErrorCode.CONSULT_PENDING, {
              recoverable: false,
              payload: { journalPrefix: "sync-run-1:", callIndex: 0, prompt: "p", opts: { to } },
            });
          },
        };
        const tool = createWorkflowTool({
          cwd,
          manager: manager as never,
          storage: { load: () => undefined },
        } as never);
        const expected = consultPendingSyncText("sync-run-1", to);
        await expect(
          tool.execute("call-1", { script: CONSULT_AGENT_SCRIPT } as never, undefined, undefined, {
            hasUI: false,
          } as never),
        ).rejects.toThrow(expected);
      } finally {
        cleanup(cwd);
      }
    }
  });

  test("⑥ settings：phaseNotify off 抑制 phase 行（consult 消息不受影响）", async () => {
    // normalize 侧「缺省即省略」不变量：仅显式合法值输出键。
    expect(normalizeSettings({ phaseNotify: "off" })).toEqual({ phaseNotify: "off" });
    expect(normalizeSettings({ phaseNotify: "phase" })).toEqual({ phaseNotify: "phase" });
    expect(normalizeSettings({ phaseNotify: "bogus" })).toEqual({});
    expect(normalizeSettings({})).toEqual({});

    // 投递侧：off 时 phase 事件不产生任何投递。
    const cwd = mkdtempSync(join(tmpdir(), "omp-phase-off-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {
        loadSettings: () => normalizeSettings({ phaseNotify: "off" }),
      });

      manager.emit("phase", { runId, title: "phase-a" });
      manager.emit("phase", { runId, title: "phase-b" });
      expect(sent).toHaveLength(0);

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }

    // off 只抑制进度行：waiting_consult 时 consult 消息仍照常投递。
    const cwd2 = mkdtempSync(join(tmpdir(), "omp-consult-off-"));
    try {
      const sent: Sent[] = [];
      const { runId } = await startConsultRun(cwd2, CONSULT_MAIN_SCRIPT, sent, {
        loadSettings: () => normalizeSettings({ phaseNotify: "off" }),
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.customType).toBe("workflow.consult");
      expect(sent[0]!.content).not.toContain("阶段「");
      expect(sent[0]!.content).toContain(runId);
    } finally {
      cleanup(cwd2);
    }
  });

  test("⑦ 双审查发现 2：consult-pending 带 opts 分流——to:agent 非 confirm 不投递（审阅链自治），to:main / apply:confirm 照常投递", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-routing-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});

      // to:agent + 非 confirm（缺省 apply="auto"）：审阅链在 manager 内部自治，
      // 结果经 complete/error 事件投递——这里零投递、零唤醒。
      manager.emit("consult-pending", { runId, prompt: "自动审阅", opts: { to: "agent" } });
      expect(sent).toHaveLength(0);
      manager.emit("consult-pending", { runId, prompt: "自动审阅", opts: { to: "agent", apply: "auto" } });
      expect(sent).toHaveLength(0);

      // to:agent + apply:confirm：仍需主代理确认 → 标准咨询消息 + wakesTurn。
      manager.emit("consult-pending", { runId, prompt: "请确认修订", opts: { to: "agent", apply: "confirm" } });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.customType).toBe("workflow.consult");
      expect(sent[0]!.content).toContain(runId);
      expect(sent[0]!.triggerTurn).toBe(true);

      // to:main：标准咨询消息 + wakesTurn。
      manager.emit("consult-pending", { runId, prompt: "人工答复", opts: { to: "main" } });
      expect(sent).toHaveLength(2);
      expect(sent[1]!.customType).toBe("workflow.consult");
      expect(sent[1]!.content).toContain(runId);
      expect(sent[1]!.triggerTurn).toBe(true);

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("⑧ 双审查发现 2：consult-limit 预接线——投递「自动审阅超限」+ wakesTurn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-limit-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});

      // 任务 4 将发射该事件——监听先 wire 好，用 manager.emit 手动触发。
      manager.emit("consult-limit", { runId });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.content).toContain(runId);
      expect(sent[0]!.content).toContain("自动审阅超限");
      expect(sent[0]!.content).toContain("等待人工答复");
      expect(sent[0]!.triggerTurn).toBe(true);

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("⑨ 双审查发现 3：complete 补投当前 phase 行（spec §7 强制行为）——先进度行（triggerTurn:false）再投结果", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-complete-flush-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});

      manager.emit("phase", { runId, title: "alpha" });
      expect(sent).toHaveLength(0); // 首个 phase 无上一行，不补投

      // 常驻运行完成：complete 监听先补投当前 phase 行、再投结果（spec §7）。
      manager.emit("complete", { runId });

      expect(sent).toHaveLength(2);
      expect(sent[0]!.content).toContain(`阶段「alpha」`);
      expect(sent[0]!.triggerTurn).toBe(false);
      expect(sent[1]!.customType).toBe("workflow-result");
      expect(sent[1]!.content).toContain("finished");
      expect(sent[1]!.triggerTurn).toBe(true);

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });

  test("⑩ 双审查发现 6：phase 行真实数据——done/total 与 token 后缀（fresh+cacheRead，与 renderRunBody 同取法）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-phase-data-"));
    const started: { resolve?: () => void } = {};
    const began = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const manager = blockingManager(cwd, started);
    try {
      const { runId, promise } = manager.startInBackground(BLOCKING_SCRIPT);
      await began;
      const run = manager.getRun(runId)!;
      // 一 done 一 error，带真实 tokenUsage（fresh+cacheRead 取法同 renderRunBody 的
      // aggregateAgentUsage）。常驻 mock agent 永不落定，emit 前改写快照不会被覆盖。
      run.snapshot.agents = [
        {
          id: 1,
          label: "a1",
          phase: "alpha",
          prompt: "p1",
          status: "done",
          tokenUsage: { input: 100, output: 200, cacheRead: 50, cacheWrite: 0, total: 350, cost: 0 },
        },
        {
          id: 2,
          label: "a2",
          phase: "alpha",
          prompt: "p2",
          status: "error",
          tokens: 500,
          tokenUsage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, total: 100, cost: 0 },
        },
      ];
      const sent: Sent[] = [];
      installResultDelivery(capturePi(sent) as never, manager, {});

      manager.emit("phase", { runId, title: "alpha" });
      manager.emit("phase", { runId, title: "beta" }); // 补投上一 phase（alpha）行

      expect(sent).toHaveLength(1);
      expect(sent[0]!.content).toContain(`阶段「alpha」完成：1/2 agents`);
      // token 后缀 = compactTokens(fresh + cacheRead)，期望值由同款 aggregateAgentUsage
      // 从同一输入计算，验证投递行与 renderRunBody 取法一致（fresh=800, cacheRead=50）。
      const { fresh, cacheRead } = aggregateAgentUsage(run.snapshot.agents);
      expect(sent[0]!.content).toContain(`，累计 ${compactTokens(fresh + cacheRead)} tok`);
      expect(compactTokens(fresh + cacheRead)).toBe("850");

      manager.stop(runId);
      await promise.catch(() => {});
    } finally {
      cleanup(cwd);
    }
  });
});
