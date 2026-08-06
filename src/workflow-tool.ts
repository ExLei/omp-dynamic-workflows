import { isAcpOrHeadlessSession, renderProgressFrame, throttleFrames } from "./acp-bridge.js";
import { defineTool, type ToolDefinition } from "./omp-api.js";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "./omp-typebox.js";
import { BUILTIN_WORKFLOW_NAMES, resolveWorkflowInvocation } from "./builtin-workflows.js";
import {
  createWorkflowSnapshot,
  fmtCost,
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { parseWorkflowScript, type WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/** The single always-on gate that authorizes workflow use without forcing it. */
export const WORKFLOW_GATE_GUIDELINE =
  "`workflow` 工具用于多代理编排 — 它把可拆分的工作扇出给子代理，适合这类任务：仓库级检查、独立并行的研究/检查、多视角审查，或扇出/扇入式综合。仅当用户显式选择使用工作流时才调用它 — 通过工作流触发词、`/workflows run` 命令，或用户自己的话（如「跑个工作流」「扇出处理」「并行审一遍」）。对其他任何任务 — 即使明显能受益 — 也不要调用；你可以把工作流作为选项简要提供给用户（并给出大致成本）。";

// Built lazily: `Type` is backed by the TypeBox shim injected on ExtensionAPI,
// which does not exist until the extension factory has installed the host
// runtime. Memoized so the tool definition and its type stay identity-stable.
function buildWorkflowToolSchema() {
  return Type.Object({
    script: Type.Optional(
      Type.String({
        description: [
          "原始 JavaScript 工作流脚本，不带 Markdown 围栏。除非提供了 `name`，否则此项必需。",
          "第一条语句必须是 export const meta = { name: 'short_snake_case', description: '非空描述' }。仅当工作流有命名阶段时才添加 phases: [{ title: 'Phase' }]，且只声明它实际会用到的阶段。有多个阶段时，在每个阶段的工作前调用 phase('Exact Title')，或在代理选项中设置 `phase`。",
          "用 `await workflow(savedName, childArgs)` 内联运行已保存的工作流；嵌套限制为一层，并共享父运行的并发、代理与 token 限额。",
          "可选的质量辅助函数包括 verify()、judgePanel()、loopUntilDry() 与 completenessCheck()。",
          "可选的控制辅助函数包括 retry() 与 gate()；budget 暴露 total、spent() 与 remaining()，phase('Name', { budget: N }) 可为阶段设置 token 限额。",
          "可选的 `agentType` 选项选择具名的用户或项目定义，可绑定工具、模型与角色指令；仅当上下文中提供了其名称与用途时才使用。其绑定的模型覆盖 `tier`；显式的 `model` 同时覆盖两者。",
          "只使用纯 JavaScript；imports、require()、文件系统模块、Date.now()、Math.random() 与 new Date() 均不可用。",
          "使用 phase('Name')、agent(prompt, opts)、parallel(arrayOfFunctions)、pipeline(items, ...stages)、log(message)、args、cwd、process.cwd() 与 budget。工作流必须至少调用一次 agent()。",
          "parallel() 需要函数而非 promise，并按输入顺序返回结果：await parallel(items.map(item => () => agent(...)))。",
          "pipeline(items, ...stages) 对每个条目依次运行各阶段，而条目之间并发推进；每个阶段接收 (previousValue, originalItem, index)。",
        ].join(" "),
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "按名称运行已保存或内置的工作流（而不是传 `script`）；其参数放在 `args` 中。 " +
          `内置工作流：${BUILTIN_WORKFLOW_NAMES.join(", ")} — 每个内置工作流的参数见 workflow-patterns 技能。 ` +
          "同名时已保存的工作流优先。不能与 resumeFromRunId 组合使用。",
      }),
    ),
    args: Type.Optional(
      // Must be an explicitly typed object schema, not Type.Any(). Type.Any()
      // compiles to a schema with no "type" keyword at all (just
      // `{ description }`), and at least one MCP/tool-calling bridge observed
      // in the wild does not treat a typeless property as "accept any JSON
      // value" — it coerces/flattens it before the handler ever sees it, so
      // `args.scope` (etc.) arrives as `undefined` and every built-in pattern
      // that requires an args field fails validation regardless of what the
      // caller actually sent. Every built-in pattern's `args` is a JSON object
      // at the top level, so declaring `type: "object"` is lossless and fixes
      // the coercion.
      //
      // Not Type.Unsafe({ type: "object" }): on omp >= 17.2.9 the host TypeBox
      // shim returns a bare object from Type.Unsafe that lacks the `.or`
      // method, so wrapping it in Type.Optional(...) crashes at load time with
      // "X3(n).or is not a function" (17.2.4's Zod-backed shim tolerated it).
      // Type.Object({}) emits `{ type: "object", properties: {} }` — JSON
      // Schema allows undeclared properties by default, so it accepts any JSON
      // object, and the emitted schema stays small.
      Type.Object(
        {},
        { description: "可选的 JSON 值，作为全局 `args` 暴露给工作流脚本。" },
      ),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "在后台运行工作流。默认跟随 syncMode：缺省 auto 下，无 UI 会话（ACP/headless）默认同步、TUI 会话默认后台；always 强制同步、never 强制后台。显式 `background` 参数始终优先。后台模式下工具立即返回 run ID，本轮对话结束、用户不被阻塞，工作流完成时结果再投递回对话。仅当你需要在本轮对话内联拿到结果时才设为 false（该调用会阻塞直到工作流完成）。",
      }),
    ),
    maxAgents: Type.Optional(
      Type.Number({
        description:
          "本次运行允许的最大代理数。默认 1000；这是安全上限而非目标。动态或探索性扇出请设更低的上限，大规模扇出保留给用户明确的意图。",
      }),
    ),
    concurrency: Type.Optional(
      Type.Number({
        description:
          "本次运行的最大并发代理数。被钳制到运行时上限。当提供商/传输稳定性重要时使用。",
      }),
    ),
    agentRetries: Type.Optional(
      Type.Number({
        description:
          "可恢复的代理失败（如超时、连接失败或空输出）的重试次数。默认 0，除非另行配置。",
      }),
    ),
    agentTimeoutMs: Type.Optional(
      Type.Number({
        description:
          "每个代理的超时时间（毫秒）。省略时使用配置的 `defaultAgentTimeoutMs`；没有配置则无硬超时。仅当用户要求限制时间时设置。",
      }),
    ),
    tokenBudget: Type.Optional(
      Type.Number({
        description:
          "可选的、由用户请求的软性支出上限，不是规划目标。除非用户明确给出上限或要求你选一个，否则不要设置 `tokenBudget`；绝不根据任务规模推断或虚构一个。省略时使用配置的 `defaultTokenBudget`；没有配置则运行不受限。达到上限会阻塞之后的 `agent()` 调用；并发的在途工作可能超支。",
      }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        description: [
          "用编辑过的 `script` 恢复先前的一次运行（该 ID），而不是启动新运行。",
          "未改动的 agent() 调用从该运行的缓存重放；从第一个改动或新增的调用起重新执行。",
          "调用按位置匹配：保持前面好的调用原样不变、顺序不动。始终在后台运行。",
        ].join(" "),
      }),
    ),
  });
}

type WorkflowToolSchema = ReturnType<typeof buildWorkflowToolSchema>;
let workflowToolSchemaCache: WorkflowToolSchema | undefined;

function workflowToolSchema(): WorkflowToolSchema {
  return (workflowToolSchemaCache ??= buildWorkflowToolSchema());
}

export type WorkflowToolInput = {
  script?: string;
  name?: string;
  args?: Record<string, unknown>;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
  resumeFromRunId?: string;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * 同步/后台执行开关，覆盖 settings.syncMode（options 优先，对齐
   * resolveWorkflowToolDefaults 模式）："always" 强制同步、"never" 强制后台、
   * "auto"（缺省）维持 isAcpOrHeadlessSession 现状判定。
   */
  syncMode?: "auto" | "always" | "never";
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<WorkflowToolSchema, any> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "运行一个以 JavaScript 编写的动态工作流：通过 agent() 把任务委派给子代理，可组合 parallel()/pipeline() 编排。",
    promptSnippet:
      "适合把可拆分的独立任务或分阶段任务委派给子代理时，用 JavaScript 工作流编排 agent()、parallel()、pipeline() 调用",
    get promptGuidelines() {
      return [WORKFLOW_GATE_GUIDELINE];
    },
    parameters: workflowToolSchema(),
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // `name` resolves through the same registry the built-in slash commands
      // and saved-workflow commands use (see builtin-workflows.ts /
      // workflow-saved.ts): a project/user saved workflow of that name wins on
      // a collision, else one of the 5 curated built-in patterns. This lets the
      // model reach a curated pattern by name instead of having to author an
      // equivalent script from scratch (and, for patterns that need it, the
      // right exec context — e.g. deep-research's web tools — travels with it).
      let invocationTools: ToolDefinition[] | undefined;
      let invocationToolset: string | undefined;
      let script: string;
      if (params.name) {
        if (params.resumeFromRunId) {
          throw new Error(
            "workflow: `name` cannot be combined with `resumeFromRunId` — resume with an edited `script` instead.",
          );
        }
        const resolved = resolveWorkflowInvocation(params.name, params.args, { storage, cwd });
        if (!resolved) {
          throw new Error(
            `workflow: no saved or built-in workflow named "${params.name}". Built-in names: ${BUILTIN_WORKFLOW_NAMES.join(", ")}.`,
          );
        }
        script = normalizeWorkflowScript(resolved.script);
        invocationTools = resolved.tools;
        invocationToolset = resolved.toolset;
      } else {
        if (!params.script) throw new Error("workflow requires either `script` or `name`");
        script = normalizeWorkflowScript(params.script);
      }
      const parsed = parseWorkflowScript(script);

      // Iteration / cached-prefix reuse: resume a prior run with THIS (edited)
      // script instead of creating a brand-new run. Unchanged agent() calls
      // replay from the prior run's journal; the first edited/new call and
      // everything after it re-run live. Always background (the resumed run is
      // detached and its result is delivered back into the conversation).
      if (params.resumeFromRunId) {
        const runId = params.resumeFromRunId;
        const resumed = await manager.resume(runId, { script, args: params.args });
        if (!resumed) {
          throw new Error(resumeFailureText(manager, runId));
        }
        return {
          content: [{ type: "text", text: resumedText(parsed.meta.name, runId) }],
          details: { runId, background: true, resumedFrom: runId },
        };
      }

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // ACP/headless 会话（无 TUI）默认同步执行：进度经 onUpdate 流式推送（ACP
      // tool_call_update），后台跑完无处回报。TUI 会话保持后台默认——立即返回、
      // 结束时把结果投递回对话（见 installResultDelivery）。显式 background 参数优先。
      //
      // syncMode 设置兜底（规格决策记录第 2 节预留项，V1 实测触发）：ACP 会话实测
      // ctx.hasUI===true，isAcpOrHeadlessSession 的 auto 判定在 ACP 下不触发同步——
      // "always" 强制同步（backgroundDefault false）、"never" 强制后台（true）、
      // 缺省 "auto" 维持现状。options.syncMode 优先于 settings（对齐
      // resolveWorkflowToolDefaults 的 options 优先模式），execute 内读 settings
      // 保证运行期改设置即时生效。
      const acpSession = isAcpOrHeadlessSession(uiCtx);
      const settings = loadWorkflowSettings({ cwd });
      const syncMode = options.syncMode ?? settings.syncMode;
      const backgroundDefault =
        syncMode === "always" ? false : syncMode === "never" ? true : (acpSession ? false : true);

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? backgroundDefault) {
        const { runId } = manager.startInBackground(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          tools: invocationTools,
          toolset: invocationToolset,
        });
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
          details: { runId, background: true },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      // 同步分支不复用 createToolUpdateWorkflowDisplay：其 emit 固定用 renderWorkflowText，
      // 无法输出 ACP 进度帧。这里自管帧输出——onUpdate 推 renderProgressFrame 文本 +
      // details 快照，onProgress 里 recompute 后经 throttleFrames 节流（1s 一帧）。
      // 节流只应用于 ACP/headless 会话（无 TUI，1s 一帧防消息风暴）；TUI 会话的同步
      // 分支（显式 background:false）保持每事件 onUpdate，不降频。结束（含中止）路径
      // 先 cancel() 清掉 pending 尾帧定时器，再无条件发终帧。
      const emitFrame = () => {
        onUpdate?.({
          content: [{ type: "text", text: renderProgressFrame(snapshot) }],
          details: snapshot,
        });
      };
      const throttled = throttleFrames(emitFrame, 1000);
      const emitProgress = () => {
        if (acpSession) throttled();
        else emitFrame();
      };

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          tools: invocationTools,
          toolset: invocationToolset,
          confirm,
          externalSignal: signal,
          onProgress(live) {
            snapshot = recomputeWorkflowSnapshot(live);
            emitProgress();
          },
        });
      } catch (error) {
        // 错误退出路径（含非中止）先 cancel 节流定时器：否则残留 trailing 定时器会在
        // 工具返回错误后约 1s 越界补发一帧陈旧进度帧。
        throttled.cancel();
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          throttled.cancel();
          emitFrame();
          throw new Error("Workflow was aborted");
        }
        // consult() 暂停不是失败：同步路径把它转成按 to 分流的可读报错文案
        // （裁定 8；runId 取自 payload.journalPrefix 的 `${runId}:` 前缀）。
        // 缺 journalPrefix 的畸形 payload 不冒充 runId（旧代码会报「运行 - 已暂停」
        // 而实际 run 已 failed）——直接 rethrow 原错误，失败大声化，与 manager 侧
        // isConsultPendingPayload 的语义一致：同步路径同样不 park 畸形 consult。
        if (error instanceof WorkflowError && error.code === WorkflowErrorCode.CONSULT_PENDING) {
          const payload = error.payload as { journalPrefix?: string; opts?: { to?: "agent" | "main" } } | undefined;
          if (!payload?.journalPrefix) throw error;
          const runId = payload.journalPrefix.replace(/:$/, "");
          throw new Error(consultPendingSyncText(runId, payload?.opts?.to));
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throttled.cancel(); // 该 throw 在 try 外，runSync 可能已发过 onProgress，同样先 cancel 防越界补帧
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot.runId = result.runId; // 终帧带真实 runId（帧头 run xxx，此前为 "-"）
      snapshot = recomputeWorkflowSnapshot(snapshot);
      throttled.cancel();
      emitFrame(); // 结束时无条件发最终帧

      // Format token usage (include cost when the provider reports it)
      const tokenSegment = fmtTokenSegment(tokenFigures(result.tokenUsage), fmtFull);
      const tokenInfo = tokenSegment
        ? `\n\nToken usage: ${tokenSegment}${result.tokenUsage?.cost ? ` (${fmtCost(result.tokenUsage.cost)})` : ""}`
        : "";

      const formattedResult =
        result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

      return {
        content: [
          {
            type: "text",
            text: `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${formattedResult}\n\n${reviseHint(result.runId)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
        },
      };
    },
    renderCall(_args, _options, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): { agentTimeoutMs: number | null; concurrency?: number; agentRetries: number } {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    reviseHint(runId),
  ].join("\n");
}

/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export function reviseHint(runId: string | undefined): string {
  if (!runId) return "";
  return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}

/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export function resumedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" resumed from run ${runId} with your edited script.`,
    "Unchanged agent() calls replay from that run's journal (cache); the first",
    "edited or newly inserted agent() call — and everything after it — re-runs live.",
    "It runs in the background; the result is delivered back here when it finishes,",
    "and the conversation continues automatically. The user can wait or keep working.",
    `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

/**
 * 同步路径的 consult() 暂停文案，按 payload.opts.to 分流（任务 6 裁定 8）：
 * "agent"（缺省）告知自动审阅链已在后台执行、结果以 follow-up 投递；"main" 指引
 * 主代理用 workflow_control 的 reply 动作回复。同步路径不额外投递咨询消息——
 * 错误即信号（避免双重信号），consult-pending 投递监听天然只对 background run 生效。
 */
export function consultPendingSyncText(runId: string, to: "agent" | "main" | undefined): string {
  return to === "main"
    ? `运行 ${runId} 已暂停等待主代理答复，请用 workflow_control 的 reply 动作回复（runId=${runId}），或用 /workflows status ${runId} 查看`
    : `运行 ${runId} 已暂停等待咨询答复，自动审阅链已在后台执行，结果将以 follow-up 投递；也可用 /workflows status ${runId} 查看或经 Web 控制台介入`;
}

/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export function resumeFailureText(manager: WorkflowManager, runId: string): string {
  const active = manager.getRun(runId);
  if (active?.status === "running") {
    return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
  }
  const persisted = manager.getPersistence().load(runId);
  if (!persisted) {
    return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
  }
  if (persisted.status === "completed") {
    return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
  }
  if (persisted.status === "aborted" || active?.status === "aborted") {
    return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
  }
  if (!persisted.script) {
    return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
  }
  return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object")
    throw new Error("workflow requires an object argument with a `script` string or a `name`");
  const value = args as Record<string, unknown>;
  // `name` resolves a saved/built-in workflow at execute() time, so `script` is
  // optional here — but if `script` is present at all it must still be a
  // string (same requirement as the script-only path below), so a caller
  // passing a malformed `script` alongside `name` gets a clear error instead
  // of it being silently dropped.
  if (typeof value.name === "string" && value.name.trim()) {
    if (value.script !== undefined && typeof value.script !== "string") {
      throw new Error("workflow's `script` must be a string when provided alongside `name`");
    }
    return {
      ...value,
      name: value.name.trim(),
      script: typeof value.script === "string" ? normalizeWorkflowScript(value.script) : undefined,
    } as WorkflowToolInput;
  }
  if (typeof value.script !== "string") throw new Error("workflow requires either `script` or `name` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
