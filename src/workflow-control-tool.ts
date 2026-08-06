import { defineTool, type ToolDefinition } from "./omp-api.js";
import { type Static, Type } from "./omp-typebox.js";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

// A tool's top-level parameter schema must be a JSON Schema object (`type:
// "object"`). A discriminated Type.Union of two objects serializes to a
// top-level `anyOf` with no `type`, which strict providers (e.g. DeepSeek)
// reject with "schema must be type object, got type: null". So the schema is a
// single object: `action` is the full set of verbs and `runId` is optional at
// the schema level. The per-action requirement (runId is mandatory for every
// action except `list`, and `list` takes no runId) is enforced at runtime in
// normalizeInput() and guarded again in execute().
//
// Built lazily: `Type` is backed by the TypeBox shim injected on ExtensionAPI,
// which does not exist until the extension factory has installed the host
// runtime. Memoized so the tool definition and its type stay identity-stable.
function buildWorkflowControlSchema() {
  return Type.Object(
    {
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("status"),
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("stop"),
          Type.Literal("reply"),
          Type.Literal("intervene"),
        ],
        {
          description:
            "list = 所有运行（无需 runId）；status/pause/resume/stop/reply/intervene 作用于单个运行并需要 runId。reply 答复 waiting_consult 咨询并可附 script；intervene 主动介入挂起运行。",
        },
      ),
      runId: Type.Optional(
        Type.String({
          minLength: 1,
          description: "规范的工作流运行 ID。status、pause、resume、stop、reply、intervene 需要；list 省略。",
        }),
      ),
      script: Type.Optional(
        Type.String({
          description: "reply 的可选替换脚本：提供则按新脚本恢复运行（应用了脚本），省略则维持原脚本继续。仅 reply 接受。",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

type WorkflowControlSchema = ReturnType<typeof buildWorkflowControlSchema>;
let workflowControlSchemaCache: WorkflowControlSchema | undefined;

function workflowControlSchema(): WorkflowControlSchema {
  return (workflowControlSchemaCache ??= buildWorkflowControlSchema());
}

export type WorkflowControlInput = Static<WorkflowControlSchema>;

export interface WorkflowControlToolOptions {
  manager: WorkflowManager;
}

export interface WorkflowControlRunDetails {
  runId: string;
  workflowName: string;
  status: RunStatus;
  phase: string | null;
  counts: {
    total: number;
    done: number;
    running: number;
    queued: number;
    error: number;
    skipped: number;
  };
  activeLabels: string[];
  tokenTotal: number;
}

type ControlResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function createWorkflowControlTool(
  options: WorkflowControlToolOptions,
): ToolDefinition<WorkflowControlSchema, Record<string, unknown>> {
  const manager = options.manager;
  return defineTool({
    name: "workflow_control",
    label: "Workflow Control",
    description:
      "列出并查看工作流运行，或暂停、恢复、停止、答复咨询（reply）、主动介入（intervene）它们，无需用户执行斜杠命令。",
    promptSnippet: "直接按规范 run ID 查看和管理工作流运行。",
    promptGuidelines: [
      "用 workflow_control 管理工作流生命周期；当此工具能完成操作时，不要让用户输入 /workflows。",
      "用 stop 终止或退出运行。关闭导航器不会停止运行。",
    ],
    parameters: workflowControlSchema(),
    prepareArguments: normalizeInput,
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const runs = manager.listRuns();
        const summaries = runs.map((run) => summarizeRun(run, manager.getSnapshot(run.runId)));
        return result(
          summaries.length
            ? `action=list result=ok runs=${summaries.length}\n${summaries.map(formatRun).join("\n")}`
            : "action=list result=ok runs=0",
          { action: "list", result: "ok", runs: summaries },
        );
      }

      // runId is optional in the schema (see workflowControlSchema) but required
      // for every non-list action; normalizeInput already enforces this, and this
      // guard both narrows the type and returns a structured error if a model
      // somehow calls a run action without one.
      if (!params.runId) return controlError(params.action, "", "runId is required for this action", ["list"]);
      // 重要 3：仅 reply/intervene 跨会话寻址（规格 §4 点名）；其余动作保持
      // 当前 session 过滤——status/pause/resume/stop 不得操作 list 列不出的运行。
      const run = findRun(
        manager,
        params.runId,
        params.action === "reply" || params.action === "intervene" ? { crossSession: true } : undefined,
      );
      if (!run) return controlError(params.action, params.runId, "run not found", ["list"]);

      try {
        switch (params.action) {
          case "status": {
            const summary = summarizeRun(run, manager.getSnapshot(run.runId));
            return result(`action=status result=ok ${formatRun(summary)}`, {
              action: "status",
              result: "ok",
              run: summary,
            });
          }
          case "pause":
            if (!manager.pause(run.runId)) return invalidTransition("pause", run);
            return actionSuccess("pause", "paused", currentSummary(manager, run));
          case "resume":
            if (!(await manager.resume(run.runId))) return invalidTransition("resume", run);
            return actionSuccess("resume", "resumed", currentSummary(manager, run));
          case "stop":
            if (!manager.stop(run.runId)) return invalidTransition("stop", run);
            return actionSuccess("stop", "stopped", currentSummary(manager, run));
          case "reply": {
            // resolveConsult validates the script (a malformed one THROWS) AFTER
            // the waiting_consult state gate, so the run is still parked when it
            // does — the catch below converts the throw to a control error and
            // the run stays waiting_consult (allowedActions unchanged), i.e. the
            // reply is retryable.
            //
            // 重要 2（任务 5 复检）：结果标签按真实 outcome 判定，而非 script 参数
            // 存在性——省略 script 有三种语义（to:main 维持、confirm 采纳、auto
            // 回落维持），confirm 场景 resolveConsult 实际落盘 applied:true（采纳
            // 审阅链的 revisedScript），工具不得误报 resumed。在调用 resolveConsult
            // 之前读 pendingConsult（run 已由 findRun 跨会话寻址解析）。
            const pending = run.pendingConsult;
            // 角落 3（复检 B）：confirm 建议未就绪（审阅链尚未 consult-review-ready /
            // 链失败）时 pending.revisedScript 缺失——省略 script 的 reply 不构成
            // 「采纳」，回落「维持原脚本继续」（resumed），与 buildConsultOutcome 的
            // journal 兜底（applied:false + 维持原脚本）保持一致。
            const confirmAdoption =
              pending?.opts.apply === "confirm" && params.script === undefined && pending?.revisedScript !== undefined;
            const resolved = await manager.resolveConsult(
              run.runId,
              params.script !== undefined ? { script: params.script } : undefined,
            );
            if (!resolved) {
              // 次要 2：传参时捕获的 run 快照在竞态下可能已陈旧（另一通道/进程先
              // 答复、run 已离开 waiting_consult）——跨会话重读当前状态：若已变化
              // 则报通用文案（附当前状态的 allowedActions），绝不报陈旧的
              // 「cannot reply run with status waiting_consult」误导。
              const freshRun = findRun(manager, run.runId, { crossSession: true }) ?? run;
              if (freshRun.status !== run.status) {
                return controlError("reply", run.runId, "回复未生效（运行状态已变化）", allowedActions(freshRun.status));
              }
              return invalidTransition("reply", run);
            }
            const applied = params.script !== undefined || confirmAdoption;
            const note = params.script !== undefined ? "应用了脚本" : confirmAdoption ? "采纳了审阅建议" : "维持原脚本继续";
            return actionSuccess("reply", applied ? "applied" : "resumed", currentSummary(manager, run), note);
          }
          case "intervene":
            if (!manager.intervene(run.runId)) return invalidTransition("intervene", run);
            return actionSuccess("intervene", "intervened", currentSummary(manager, run));
        }
      } catch (err) {
        // A transient persistence I/O error (or any unexpected throw from the
        // manager) shouldn't surface as a raw stack trace to the model — report
        // it via the tool's normal structured error shape instead.
        const message = err instanceof Error ? err.message : String(err);
        return controlError(params.action, run.runId, message, allowedActions(run.status));
      }
    },
  });
}

function normalizeInput(value: unknown): WorkflowControlInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_control requires an object argument");
  }
  const input = value as Record<string, unknown>;
  const actions = new Set(["list", "status", "pause", "resume", "stop", "reply", "intervene"]);
  if (typeof input.action !== "string" || !actions.has(input.action)) {
    throw new Error("workflow_control requires action: list|status|pause|resume|stop|reply|intervene");
  }

  // reply is the only run action that takes an optional script (the consult
  // answer's replacement script); every other non-list action stays action+runId.
  const allowedKeys =
    input.action === "list" ? new Set(["action"]) : input.action === "reply" ? new Set(["action", "runId", "script"]) : new Set(["action", "runId"]);
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);

  if (input.action !== "list" && (typeof input.runId !== "string" || !input.runId.trim())) {
    throw new Error(`workflow_control action "${input.action}" requires runId`);
  }
  return input as WorkflowControlInput;
}

function result(text: string, details: Record<string, unknown>): ControlResult {
  return { content: [{ type: "text", text }], details };
}

function findRun(
  manager: WorkflowManager,
  runId: string,
  opts?: { crossSession?: boolean },
): PersistedRunState | undefined {
  // 重要 3（任务 5 复检）：会话隔离按动作分流。Cross-session addressing
  // (spec §4) 仅限 reply/intervene —— 它们必须到达咨询投递落在另一会话的运行，
  // listRuns() 按当前 sessionId 过滤、listAllRuns() 看全部持久化运行；其余动作
  // （status/pause/resume/stop）保持 session 过滤，避免「list 列不出却可操作」
  // 的隔离放宽不一致。
  const source = opts?.crossSession ? manager.listAllRuns() : manager.listRuns();
  return source.find((candidate) => candidate.runId === runId);
}

function currentSummary(manager: WorkflowManager, fallback: PersistedRunState): WorkflowControlRunDetails {
  // 回归 1（任务 5 复检）：透传 crossSession——reply/intervene 的分发路径本就跨会话
  // 寻址，成功/失败响应都必须回读操作后的当前状态，而非分发时捕获的会话过滤快照
  // （跨会话 run 经 listRuns() 必找不到，?? fallback 会回落成操作前状态——reply 成功
  // 后仍在报 waiting_consult）。listAllRuns 是全量超集，会话内动作（pause/resume/
  // stop）的分发已通过会话过滤把关，这里同样成立。
  const current = findRun(manager, fallback.runId, { crossSession: true }) ?? fallback;
  return summarizeRun(current, manager.getSnapshot(current.runId));
}

function actionSuccess(
  action: string,
  actionResult: string,
  run: WorkflowControlRunDetails,
  note?: string,
): ControlResult {
  // `note` 是中文语义说明（如 reply 的「应用了脚本 / 采纳了审阅建议 / 维持原脚本
  // 继续」）——机器可读的 result 字段保持不变，文案追加在 result 之后。
  return result(`action=${action} result=${actionResult}${note ? ` ${note}` : ""} ${formatRun(run)}`, {
    action,
    result: actionResult,
    run,
  });
}

function invalidTransition(action: string, run: PersistedRunState): ControlResult {
  return controlError(action, run.runId, `cannot ${action} run with status ${run.status}`, allowedActions(run.status));
}

function controlError(action: string, runId: string, message: string, allowed: string[]): ControlResult {
  return result(
    `action=${action} result=error runId=${runId} error=${message} allowed=${allowed.join(",") || "none"}`,
    { action, result: "error", runId, error: message, allowedActions: allowed },
  );
}

function allowedActions(status: RunStatus): string[] {
  switch (status) {
    case "running":
      return ["status", "pause", "stop"];
    case "paused":
      return ["status", "resume", "stop"];
    case "failed":
    case "pending":
      return ["status", "resume"];
    case "waiting_consult":
      return ["status", "stop", "reply", "intervene"];
    case "completed":
    case "aborted":
      return ["status"];
  }
}

function summarizeRun(run: PersistedRunState, live?: WorkflowSnapshot | null): WorkflowControlRunDetails {
  const agents = live?.agents ?? run.agents;
  const counts = countAgents(agents);
  const liveUsage = tokenFigures(live?.tokenUsage);
  const persistedUsage = tokenFigures(run.tokenUsage);
  const agentUsage = aggregateAgentUsage(agents);
  return {
    runId: run.runId,
    workflowName: live?.name ?? run.workflowName,
    status: run.status,
    phase: live?.currentPhase ?? run.currentPhase ?? null,
    counts,
    activeLabels: agents.filter((agent) => agent.status === "running").map((agent) => agent.label),
    tokenTotal: Math.max(
      liveUsage.fresh + liveUsage.cacheRead,
      persistedUsage.fresh + persistedUsage.cacheRead,
      agentUsage.fresh + agentUsage.cacheRead,
    ),
  };
}

function countAgents(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): WorkflowControlRunDetails["counts"] {
  return {
    total: agents.length,
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    queued: agents.filter((agent) => agent.status === "queued").length,
    error: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function formatRun(run: WorkflowControlRunDetails): string {
  const active = run.activeLabels.join(",") || "-";
  return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
