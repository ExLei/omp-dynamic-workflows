/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry, ToolDefinition } from "./omp-api.js";
import { WorkflowAgent, type AgentUsage } from "./agent.js";
import { preview, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { isProviderUsageLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type PendingConsult,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type ConsultOptions,
  type ConsultOutcome,
  hashConsult,
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
} from "./workflow.js";

/**
 * True when a CONSULT_PENDING payload carries the full waiting_consult
 * identity. consult()'s contract guarantees a complete payload; a
 * CONSULT_PENDING raised by any other path has no such guarantee, and parking
 * on a degenerate identity (empty journalPrefix) would make task 3's
 * hashConsult recompute from nothing — the user's reply would never match the
 * call it answers. Malformed payloads therefore fail loudly (failed + error
 * event) instead of silently degrading into a waiting_consult run.
 */
function isConsultPendingPayload(
  payload: unknown,
): payload is { journalPrefix: string; callIndex: number; prompt: string; opts: ConsultOptions } {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.journalPrefix === "string" &&
    // 顺手修 3（最终审查收口）：空字符串必须拒绝——守卫只查 typeof string 时，
    // "" 通过守卫、运行 park 在退化身份上（resolveConsult 会按 runId "" 写
    // journal、重放永不命中、答复静默丢弃）。
    p.journalPrefix !== "" &&
    typeof p.callIndex === "number" &&
    typeof p.prompt === "string" &&
    typeof p.opts === "object" &&
    p.opts !== null
  );
}

/** 审阅子代理返回的 JSON 形状（宽松：只读 ok/summary/reason 三个可选字段）。 */
interface ReviewReply {
  ok?: unknown;
  summary?: unknown;
  reason?: unknown;
}

/** 类型守卫：审阅子代理的 JSON 返回是对象即可按 ReviewReply 读取（字段逐一 typeof 校验）。 */
function isReviewReply(value: unknown): value is ReviewReply {
  return typeof value === "object" && value !== null;
}

/**
 * Manager-side extension of PendingConsult (双审查次要 2)：confirm 链把建议文件
 * 路径记在 pending 上（revisedPath），随 writeRunToDisk 原样落盘（PersistedRunState
 * 的 PendingConsult 形状不含该键，多余键运行时保留、类型上宽容）——resolveConsult
 * / stop() / markConsultFailed / deleteRun 在 pending 消亡时 rmSync(force:true)。
 */
type ManagerPendingConsult = PendingConsult & { revisedPath?: string };

/** 一次审阅失败的原因分类（双审查次要 3：重试反馈按原因分流）。 */
type ReviewFailureKind = "reject" | "nofile" | "parse" | "error";

/**
 * The journaled outcome a resolved consult() call returns (ConsultOutcome),
 * built from the pending consult at resolution time. A "confirm"-apply consult
 * adopts the review's revised script; an auto-apply consult whose chain
 * APPLIED a revision (resolveConsult received the chain's `summary` marker)
 * reports applied:true with the applied revised script; a reply carrying a
 * user script (to:"main" consults — whose chain never starts — and auto-apply
 * in-flight/failed/over-limit fallbacks) also reports applied:true with that
 * script, since the tool labels it "应用了脚本" and the run resumes with it;
 * only a bare reply with neither a chain summary nor a script continues with
 * the original script — "维持原脚本继续" (spec §4). resolveConsult merges
 * the review chain's summary into the pending consult when it builds this
 * outcome; the revisedScript is what a confirm flow stored on the pending
 * consult (absent for user replies, which carry their edit as resolveConsult's
 * script instead).
 */
function buildConsultOutcome(pending: PendingConsult, script?: string): ConsultOutcome {
  if (pending.opts.apply === "confirm") {
    // 角落 3（复检 B）：confirm 建议未就绪（链尚未 consult-review-ready / 链失败）
    // 时 pending.revisedScript 缺失——不得 journal 落 {applied:true,
    // revisedScript:undefined}（标签与事实、journal 与事实双矛盾）。
    //
    // 复检重要 1（双审查独立确认）：confirm 兜底不得忽略 script 参数——建议未就绪
    // 时带脚本 reply（工具已报 applied/「应用了脚本」，run 以用户脚本恢复）必须如实
    // 落 {applied:true, revisedScript: script}；9ec2779 把 dd7c724 的
    // {applied:true, revisedScript:undefined} 改成无条件维持原脚本的形态即此回归
    // （标签与 journal、journal 与事实双矛盾）。镜像非 confirm 分支的
    // `script ?? pending.revisedScript` 优先级：script 提供 → 用户脚本；
    // 仅 revisedScript 就绪 → 采纳建议；两者皆缺 → 维持原脚本。
    if (script !== undefined) {
      return { applied: true, revisedScript: script, summary: "应用了用户提供的脚本" };
    }
    return pending.revisedScript !== undefined
      ? { applied: true, revisedScript: pending.revisedScript, summary: pending.summary ?? "" }
      : { applied: false, summary: "维持原脚本" };
  }
  // 链已应用（resolveConsult 收到 summary 标记）：修订脚本真实生效——outcome 如实
  // 报 applied:true 并携带链摘要与已应用脚本（双审查重要 2：auto 应用后不得再报
  // applied:false/维持原脚本，ConsultOutcome.applied 自身 doc 说「Whether the
  // review's revised script was applied」）。summary 分支保持在 script 之前：
  // applyReviewChain 同时携带修订脚本与链摘要，链应用路径必须保留链摘要（既有契约）。
  if (pending.summary !== undefined) {
    return { applied: true, summary: pending.summary, revisedScript: script ?? pending.revisedScript };
  }
  // 带脚本 reply（无链摘要——to:"main" 咨询永不启动审阅链，auto 链在飞/失败/超限
  // 回落时同理）：resolveConsult 以用户脚本恢复，工具已报 applied/「应用了脚本」，
  // journal 必须如实落 {applied:true, revisedScript: script}——镜像 confirm 分支
  // 语义，修复此前无条件落 applied:false/维持原脚本（标签 vs journal、journal vs
  // 事实双矛盾；且与 confirm 分支 script → applied:true 直接冲突）。
  if (script !== undefined) {
    return { applied: true, revisedScript: script, summary: "应用了用户提供的脚本" };
  }
  return { applied: false, summary: "维持原脚本" };
}

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  /**
   * The pending consult() intervention point this run is parked on (status
   * "waiting_consult"). Written once by executeRun's catch tail when a
   * CONSULT_PENDING error surfaces (generation 0; fields taken from the
   * error's payload). intervene() re-targets it to "main" (generation+1);
   * resolveConsult merges the review chain's summary into it when journaling
   * the outcome, then clears it before resuming. Persisted
   * with the run so a waiting_consult run survives a cold restart. Shape
   * shared with PersistedRunState via run-persistence's PendingConsult.
   *
   * Manager-side extension `revisedPath`: set by a confirm-mode review chain
   * to the suggestion file it wrote (the file is referenced only by the
   * consult-review-ready payload). Carried verbatim through the generic
   * writeRunToDisk save path, so the on-disk copy knows the file too;
   * resolveConsult/stop()/markConsultFailed/deleteRun rmSync it (force:true)
   * when the pending consult goes away.
   */
  pendingConsult?: ManagerPendingConsult;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /**
   * Auto-resume eligibility for this run (see ExecOptions.autoResume). Set once
   * at creation and carried through resume() so it survives pause/resume cycles.
   * Undefined means eligible (default-on); false opts out.
   */
  autoResume?: boolean;
  /**
   * How many times this run's consult outcome has been applied automatically
   * (apply: "auto" — no user confirmation). Run-level counter, incremented by
   * the auto-review chain on each completed cycle (successful apply or
   * markConsultFailed) and carried on the managed run so the generic
   * writeRunToDisk path persists it — a resumed execution's next consult
   * trigger re-reads it (via persistence) to enforce the cap. Mirrors
   * PersistedRunState.consultAutoApplied.
   */
  consultAutoApplied?: number;
  /**
   * The run's resolved hard token budget (per-run value, else the manager
   * default), fixed at run start and carried through resume() — a resumed run
   * must keep the budget it started with, not re-resolve against the current
   * default (an explicit `null` opt-out would otherwise regain a budget).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag for this run (see WorkflowManagerOptions.toolsets).
   * ToolDefinitions are functions and can't be persisted, so the tag is what
   * survives on disk — resume() re-resolves it so e.g. a resumed
   * `/deep-research` run keeps its web tools instead of silently degrading to
   * the default coding tools.
   */
  toolset?: string;
  /**
   * Real per-agent start/end timestamps, captured at onAgentStart/onAgentEnd
   * (never fabricated), keyed by the agent's snapshot id. A running agent has
   * an entry with no endedAt; persistRun() reads from here instead of stamping
   * every agent with the run's startedAt / "now".
   */
  agentTimestamps: Map<number, { startedAt: string; endedAt?: string }>;
  /**
   * Live snapshot-agent lookup keyed by the agent CALL's unique id (see
   * WorkflowRunOptions.onAgentStart/onAgentEnd/onAgentHistory's `id` field in
   * workflow.ts — unique per call, never per label). onAgentEnd/onAgentHistory
   * must resolve the snapshot entry to update through this map, never by
   * scanning managed.snapshot.agents for a label match: two concurrent agents
   * routinely share a label (e.g. parallel()'s default `"${phase} agent N"`
   * labeling, or an author-supplied label reused across a fan-out), and a
   * label+status scan would update whichever same-label entry it happens to
   * find first — misattributing one agent's end/history event to a different,
   * still-running sibling.
   */
  agentsById: Map<string, WorkflowAgentSnapshot>;
  /**
   * The run's cap on total agents (per-run value, else left undefined so
   * runWorkflow applies its own MAX_AGENTS_PER_RUN default), fixed at run
   * start/resume and carried through resume() — mirrors ManagedRun.tokenBudget
   * exactly: a resumed run must keep the cap it started with, not silently
   * regain the (much larger) default because ExecOptions.maxAgents isn't
   * threaded through resume()'s executeRun() call.
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout (per-run value, else the manager
   * default at the time), fixed at run start/resume — same rationale as
   * tokenBudget/maxAgents: resume() must not re-resolve against the manager's
   * CURRENT defaultAgentTimeoutMs.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved concurrency (per-run value, else the manager's
   * concurrency at the time), fixed at run start/resume for the same reason
   * as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count (per-run value, else the manager
   * default at the time), fixed at run start/resume for the same reason as
   * tokenBudget.
   */
  agentRetries?: number;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /**
   * Replay these journaled agent/checkpoint results for the unchanged prefix
   * (resume), keyed by `${runId}:${index}` — see
   * WorkflowRunOptions.resumeJournal in workflow.ts.
   */
  resumeJournal?: Map<string, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /**
   * Tool set for this run's subagents, replacing the default coding tools —
   * e.g. built-in `/deep-research` appends web tools. Omit for the default.
   * Not persistable (functions): pair with `toolset` so a resumed run can
   * re-resolve the same tools.
   */
  tools?: ToolDefinition[];
  /**
   * Named toolset tag, resolved via WorkflowManagerOptions.toolsets. Persisted
   * with the run and re-resolved on resume(). When both `tools` and `toolset`
   * are given, `tools` wins for this execution and `toolset` is what resumes use.
   */
  toolset?: string;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /**
   * Whether this run is eligible for auto-resume when it pauses on a provider
   * usage limit. Default-on: omit or pass true to stay eligible, pass false to
   * opt out. Persisted on the run so a cold-start UsageLimitScheduler respects
   * it too. See usage-limit-scheduler.ts.
   */
  autoResume?: boolean;
  /**
   * Seed for the execution's cumulative token counters — passed through to
   * runWorkflow's WorkflowRunOptions.initialTokenUsage. Only resume() sets
   * this (from the persisted run's tokenUsage-at-pause), so the resumed
   * execution's fresh SharedRuntime starts counting from the already-spent
   * total instead of zero (see A2 in workflow-manager's resume()).
   */
  initialTokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /**
   * The host Pi session's model registry. When provided, workflow subagents
   * resolve models against the same registry as the main session, including
   * extension-registered providers such as ollama-cloud.
   */
  modelRegistry?: ModelRegistry;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Default hard token budget when a run does not pass tokenBudget. null/omitted means no budget. */
  defaultTokenBudget?: number | null;
  /**
   * Named toolsets resolvable by ExecOptions.toolset — e.g.
   * `{ "web-research": () => [...createCodingTools(cwd), ...createWebTools()] }`.
   * Called lazily per execution (including on resume). An unknown tag resolves
   * to the default coding tools.
   */
  toolsets?: Record<string, () => ToolDefinition[]>;
  /**
   * Extra tool NAMES to deny in every subagent session, on top of the always-on
   * `workflow`/`workflow_control` defaults (see DEFAULT_EXCLUDED_SUBAGENT_TOOLS).
   * Host wiring passes settings.excludeSubagentTools here so users can also block
   * other recursive-orchestration tools (#107).
   */
  excludeSubagentTools?: string[];
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory. Default false (in-memory, discarded).
   */
  persistAgentSessions?: boolean;
  /**
   * 子代理会话全量同步主代理扩展工具/技能（对应 settings.syncHostTools，默认 true）。
   * 透传给 runWorkflow → WorkflowAgent，见 WorkflowAgentOptions.syncHostTools。
   */
  syncHostTools?: boolean;
  /** 子代理会话启用 IRC（对应 settings.enableIrc，默认 false）。 */
  enableIrc?: boolean;
  /**
   * How many terminal (completed/failed/aborted) runs to retain full
   * in-memory state for before the oldest is evicted from `runs` (see the
   * class-level doc comment on that field). Defaults to
   * DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY; exposed mainly for tests that want
   * to observe eviction without creating dozens of runs.
   */
  maxTerminalRunsInMemory?: number;
}

/** Options that a fresh extension generation may safely refresh on a live
 * manager handed across `/reload`. Execution identity (`cwd`, persistence,
 * injected agent, and in-memory runs) is intentionally excluded. */
export type WorkflowManagerReloadOptions = Pick<
  WorkflowManagerOptions,
  | "concurrency"
  | "loadSavedWorkflow"
  | "defaultAgentTimeoutMs"
  | "defaultAgentRetries"
  | "defaultTokenBudget"
  | "toolsets"
  | "excludeSubagentTools"
  | "persistAgentSessions"
  | "syncHostTools"
  | "enableIrc"
>;

/**
 * Statuses in which a run's execution has genuinely settled — no promise is
 * still pending, no lease is still held, nothing will asynchronously mutate
 * this ManagedRun again. "paused" is deliberately excluded: both a manual
 * pause() and a usage-limit checkpoint leave the run resumable and, from the
 * in-memory-retention question's point of view, still "the run the user is
 * looking at" — only completed/failed/aborted runs are eviction candidates.
 * See the `runs` field doc comment for the full eviction lifecycle contract.
 */
const IN_MEMORY_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

/**
 * How many terminal (completed/failed/aborted) runs' full in-memory state
 * (agents array, journal, snapshot, agentTimestamps) to retain in `runs`
 * before the oldest is evicted. Kept small: a terminal run's data is fully
 * on disk (run-persistence.ts) by the time it's eviction-eligible, so the
 * in-memory copy exists only to serve a `getRun()`/`getSnapshot()` caller
 * that wants the LIVE object (vs. listRuns()'s persisted view) for a run
 * that *just* finished — a handful is enough for that; unbounded retention
 * is exactly the leak this bounds (run-level analog of the subagent
 * memory-retention mitigation in agent.ts).
 */
const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;

export class WorkflowManager extends EventEmitter {
  /**
   * Lifecycle contract for `runs`:
   *
   *  - An entry is added when a run starts (startInBackground/runSync) or is
   *    resumed (resume()), always with a live AbortController and (usually)
   *    an active RunLease.
   *  - While status is "running" or "paused", the entry is NEVER evicted —
   *    its execution could still settle (a pending executeRun() promise) or
   *    it is mid-usage-limit-checkpoint/manually-paused and still considered
   *    "the current state of this run" by callers. Eviction only ever
   *    considers an entry AFTER executeRun() has fully settled it to
   *    "completed" | "failed" | "aborted" (see IN_MEMORY_TERMINAL_STATUSES)
   *    and persisted + released its lease — i.e. strictly after the same
   *    isCurrent()-gated persistRun()/releaseRunLease() calls in
   *    executeRun()'s success/catch tails.
   *  - Once terminal, an entry becomes eviction-ELIGIBLE (recordTerminalRun())
   *    but is not necessarily evicted immediately: up to
   *    maxTerminalRunsInMemory terminal entries are kept, oldest evicted
   *    first, so a `getRun()` call immediately after completion (e.g. the
   *    "complete" event's own synchronous listeners — task-panel's result
   *    delivery, `/workflows watch`) still sees the live object. Once
   *    evicted, the entry is simply removed from `runs`; nothing else reads
   *    or writes it again.
   *  - Every caller of getRun()/getSnapshot() must treat "undefined"/null as
   *    "no live in-memory copy right now" and fall back to listRuns() (backed
   *    by run-persistence.ts, which is what's authoritative for a run once
   *    the in-memory copy is gone) — this mirrors how those callers already
   *    treat any run this process never had in memory (e.g. one started by a
   *    different process and only ever seen via listRuns()). resume() never
   *    depends on `runs` for a run's state either: it always reloads from
   *    persistence, so an evicted runId resumes exactly like one from a
   *    prior process.
   *  - isCurrent(managed) composes with eviction the same way it composes
   *    with resume()/deleteRun() replacing or removing an entry: eviction
   *    removes the map entry outright, so a stale execution's later settle
   *    (isCurrent() check) sees `this.runs.get(runId) !== managed` (in fact
   *    undefined) and correctly no-ops, exactly as it would after
   *    resume()/deleteRun().
   */
  private runs = new Map<string, ManagedRun>();
  /**
   * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
   * the eviction order for `runs` (see its doc comment). A runId can appear
   * more than once (e.g. resumed after eviction, then terminates again);
   * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
   * of the current map entry for that id before deleting), so duplicates
   * are harmless.
   */
  private terminalRunQueue: string[] = [];
  private maxTerminalRunsInMemory: number;
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private defaultTokenBudget: number | null;
  private toolsets?: Record<string, () => ToolDefinition[]>;
  private excludeSubagentTools?: string[];
  private persistAgentSessions: boolean;
  private syncHostTools: boolean;
  private enableIrc: boolean;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.syncHostTools = options.syncHostTools ?? true;
    this.enableIrc = options.enableIrc ?? false;
    this.maxTerminalRunsInMemory = options.maxTerminalRunsInMemory ?? DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /**
   * Refresh host configuration after Pi reloads the extension while retaining
   * this manager's live runs, controllers, leases, and event listeners.
   * Existing executions keep the options they captured at start; subsequent
   * runs and resumes use these refreshed defaults.
   */
  reconfigureAfterReload(options: WorkflowManagerReloadOptions): void {
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.syncHostTools = options.syncHostTools ?? true;
    this.enableIrc = options.enableIrc ?? false;
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Expose the host session's model registry to integrations sharing this
   * manager. Workflow execution reads the same registry internally.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    const controller = new AbortController();
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
      lease,
      autoResume: exec.autoResume,
      // Resolve the budget once at start and freeze it on the run (see
      // ManagedRun.tokenBudget) so resume keeps start-time semantics.
      tokenBudget: exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget,
      toolset: exec.toolset,
      // Same freeze-at-start pattern as tokenBudget, for the same reason: a
      // resumed run must keep these values, not re-resolve against the
      // manager's current defaults (see ManagedRun doc comments).
      maxAgents: exec.maxAgents,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      concurrency: exec.concurrency !== undefined ? exec.concurrency : this.concurrency,
      agentRetries: exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries,
      agentTimestamps: new Map(),
      agentsById: new Map(),
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      this.persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
        autoResume: managed.autoResume,
        tokenBudget: managed.tokenBudget,
        toolset: managed.toolset,
        maxAgents: managed.maxAgents,
        agentTimeoutMs: managed.agentTimeoutMs,
        concurrency: managed.concurrency,
        agentRetries: managed.agentRetries,
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    managed.autoResume = exec.autoResume;
    managed.tokenBudget = exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget;
    managed.toolset = exec.toolset;
    // Same freeze-at-start pattern as tokenBudget (see startInBackground/ManagedRun).
    managed.maxAgents = exec.maxAgents;
    managed.agentTimeoutMs = exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs;
    managed.concurrency = exec.concurrency !== undefined ? exec.concurrency : this.concurrency;
    managed.agentRetries = exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    return {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
      agentTimestamps: new Map(),
      agentsById: new Map(),
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      confirm,
      tools,
      initialTokenUsage,
    } = exec;
    // maxAgents/agentTimeoutMs/concurrency/agentRetries were resolved (per-run
    // value, else the manager default at the time) and frozen on the managed
    // run at start/resume (see ManagedRun doc comments) — read them from there
    // first, exactly like resolvedTokenBudget below, so a resumed run keeps the
    // values it started with instead of re-resolving against the manager's
    // CURRENT defaults. The exec.* fallbacks are a safety net for direct
    // executeRun callers that skipped the start paths (same rationale as
    // resolvedTokenBudget's tokenBudget fallback).
    const resolvedMaxAgents = managed.maxAgents !== undefined ? managed.maxAgents : maxAgents;
    const resolvedAgentTimeoutMs =
      managed.agentTimeoutMs !== undefined
        ? managed.agentTimeoutMs
        : agentTimeoutMs !== undefined
          ? agentTimeoutMs
          : this.defaultAgentTimeoutMs;
    const resolvedConcurrency =
      managed.concurrency !== undefined ? managed.concurrency : (concurrency ?? this.concurrency);
    const resolvedAgentRetries =
      managed.agentRetries !== undefined ? managed.agentRetries : (agentRetries ?? this.defaultAgentRetries);
    // The budget was resolved (per-run value, else defaultTokenBudget) and frozen
    // on the managed run at start/resume — read it from there so a resumed run
    // keeps the budget it started with. exec.tokenBudget is a safety net for
    // direct executeRun callers that skipped the start paths.
    const resolvedTokenBudget = managed.tokenBudget !== undefined ? managed.tokenBudget : (tokenBudget ?? null);
    // Explicit tools win for this execution; else re-resolve the run's persisted
    // toolset tag (how a resumed /deep-research keeps its web tools); else the
    // agent layer's default coding tools.
    const resolvedTools = tools ?? (managed.toolset ? this.toolsets?.[managed.toolset]?.() : undefined);
    // Gated the same way as this.emitLive() below (see isCurrent()) — a stale
    // execution's progress callback would otherwise keep driving live UI
    // (task panel, etc.) for a run that's been superseded or deleted.
    const progress = () => {
      if (this.isCurrent(managed)) onProgress?.(managed.snapshot);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        // Use the managed run's persisted id as the workflow runId so the value
        // returned in result.runId matches the id that listRuns()/resume() use.
        // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
        // path would surface a non-resumable id to the model.
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        syncHostTools: this.syncHostTools,
        enableIrc: this.enableIrc,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents: resolvedMaxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget: resolvedTokenBudget,
        tools: resolvedTools,
        excludeTools: this.excludeSubagentTools,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        // Seed the fresh SharedRuntime's spend counter from the persisted total
        // (resume()) so the hard tokenBudget cap holds cumulatively across a
        // pause/resume cycle instead of resetting to zero each time (see A2 —
        // runWorkflow only applies this on the fresh-SharedRuntime branch, never
        // overriding an inherited options.sharedRuntime from a nested workflow()).
        initialTokenUsage,
        // Retried-attempt spend (see WorkflowRunOptions.onRetrySpend and A2):
        // recordTokens() in workflow.ts already folded this into
        // shared.spent/tokenUsage, but onAgentEnd never sees a retried
        // (non-final) attempt — fold it into the same persisted aggregate here
        // so a run paused after a retry doesn't under-count against the budget.
        onRetrySpend: (tokens) => {
          this.accumulateTokenUsage(managed, tokens);
        },
        onAgentJournal: (entry) => {
          // Append (crash-safe-ish): keep the latest entry per (runId, index)
          // pair, then persist. Matching on index ALONE would let a nested
          // workflow()'s callIndex-0 entry evict the parent's own
          // callIndex-0 entry (and vice versa) — they're only distinguished
          // by runId (see JournalEntry.runId). This is the high-frequency
          // progress persist (fires once per completed agent, can burst
          // under concurrency) — throttled (trailing edge). Every
          // lifecycle-critical persist below (status transitions, run end,
          // pause/resume/stop) still calls persistRun() directly and flushes this.
          managed.journal = managed.journal.filter((e) => !(e.index === entry.index && e.runId === entry.runId));
          managed.journal.push(entry);
          this.schedulePersist(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emitLive(managed, "log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emitLive(managed, "phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          const id = managed.snapshot.agents.length + 1;
          const agentSnapshot: WorkflowAgentSnapshot = {
            id,
            callId: event.id,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          };
          managed.snapshot.agents.push(agentSnapshot);
          // Index by the call's unique id (never label — see agentsById's doc
          // comment) so onAgentEnd/onAgentHistory can resolve back to exactly
          // THIS entry even when a concurrent sibling shares its label.
          managed.agentsById.set(event.id, agentSnapshot);
          // Real per-agent start time, captured the moment the agent actually
          // starts (not the run's startedAt) — see agentTimestamps.
          managed.agentTimestamps.set(id, { startedAt: new Date().toISOString() });
          this.emitLive(managed, "agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            // Keep the full value for the interactive pager; compact surfaces
            // continue to use resultPreview.
            agent.result = event.result;
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.tokenUsage) agent.tokenUsage = event.tokenUsage;
            if (event.model) agent.model = event.model;
            // Real per-agent end time — only terminal agents get one; a still-
            // running agent's entry keeps endedAt undefined.
            const ts = managed.agentTimestamps.get(agent.id);
            if (ts) ts.endedAt = new Date().toISOString();
          }
          // Progressive run-wide token aggregate (A2): workflow.ts's onTokenUsage
          // callback below fires exactly once, only when the whole script finishes
          // successfully (a deliberate, tested contract — see
          // "agent() accumulates usage across multiple agents" in agent.test.ts,
          // which asserts one final event, not one per agent). A run that
          // pauses/aborts/fails mid-flight never reaches it, so without tracking
          // it here too, a paused run's persisted tokenUsage would stay whatever
          // it was (usually unset) — starving resume()'s spend-seeding of the
          // very data it needs. Accumulate additively from every onAgentEnd
          // instead: a cache-hit replay reports tokens: 0 (see agent()'s replay
          // branch in workflow.ts), so replaying the unchanged prefix on resume
          // is a no-op add here, matching the "already historically spent, don't
          // double-count" semantics of journal replay.
          this.accumulateTokenUsage(managed, event.tokens ?? 0, event.tokenUsage);
          this.emitLive(managed, "agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.history = event.history;
          }
          this.emitLive(managed, "agentHistory", { runId: managed.runId, agentId: agent?.id, ...event });
          progress();
        },
        onAgentUsage: (event) => {
          const agent = managed.agentsById.get(event.id);
          if (!agent) return;
          // Cumulative snapshot for THIS agent — overwrite, never accumulate.
          // onAgentEnd replaces it with the authoritative final figure, and the
          // run-wide aggregate is still only touched there, so a live tick can
          // never double-count against the persisted total or the token budget.
          agent.tokenUsage = event.tokenUsage;
          agent.tokens = event.tokenUsage.total;
          this.emitLive(managed, "agentUsage", { runId: managed.runId, agentId: agent.id, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emitLive(managed, "tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.status = "completed";
      managed.result = result;
      // Gated the same way as disk/lease below (see emitLive()): a stale
      // execution's "complete" would otherwise still deliver a result for a
      // run that's been superseded or deleted (e.g. background result
      // delivery into the conversation) even though it's no longer current.
      this.emitLive(managed, "complete", { runId: managed.runId, result });

      // Persist final state. persistRun()/writeRunToDisk() already no-op if
      // `managed` has been superseded (resume()/deleteRun() took over this
      // runId) — see isCurrent(). Guard the lease release the same way: a
      // stale execution settling after resume() has already acquired a NEW
      // lease for this runId must not touch that newer lease's bookkeeping.
      this.persistRun(managed);
      if (this.isCurrent(managed)) {
        this.releaseRunLease(managed);
        // Now (and only now — after the run's data is safely on disk and its
        // lease released) does this run become eviction-eligible; see the
        // `runs` field doc comment.
        this.recordTerminalRun(managed.runId);
      }

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      const usageLimitPaused = !managed.controller.signal.aborted && isProviderUsageLimit(workflowError);
      // A consult() intervention point was reached (the script is parked for
      // review, not failed). Mutually exclusive with the abort branch: an
      // intentional stop/pause always wins over a consult pause. The payload
      // must carry the full waiting_consult identity — consult()'s contract
      // guarantees it, but a CONSULT_PENDING raised by any other path has no
      // such guarantee; a malformed one fails loudly below (failed + error
      // event) instead of silently parking on an empty identity.
      const consultPending =
        !managed.controller.signal.aborted &&
        workflowError.code === WorkflowErrorCode.CONSULT_PENDING &&
        isConsultPendingPayload(workflowError.payload);
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (consultPending) {
        // Consult review gate: checkpoint the run as waiting_consult with the
        // pending intervention point recorded, so resolveConsult (later task)
        // can answer it and resume. Only when the run is still "running" — a
        // stop() that landed in this window already set "aborted" and must not
        // be overwritten.
        // consultPending already guarantees the payload passed
        // isConsultPendingPayload() — the guard re-run here is what narrows
        // workflowError.payload to the non-null shape for TS.
        if (managed.status === "running" && isConsultPendingPayload(workflowError.payload)) {
          managed.status = "waiting_consult";
          managed.pendingConsult = {
            journalPrefix: workflowError.payload.journalPrefix,
            callIndex: workflowError.payload.callIndex,
            prompt: workflowError.payload.prompt,
            opts: workflowError.payload.opts,
            generation: 0,
          };
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      // Both branches gated via emitLive() (see its doc comment) — a stale
      // execution's "paused"/"error" is equally misleading once superseded.
      if (usageLimitPaused) {
        this.emitLive(managed, "paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (consultPending) {
        // Consult review gate — a pause for review, NOT a failure. Only the
        // consult-pending notice fires; emitting "error" here would make the
        // delivery layer misreport the consultation as a failed run.
        if (managed.status === "waiting_consult") {
          this.emitLive(managed, "consult-pending", {
            runId: managed.runId,
            prompt: managed.pendingConsult?.prompt,
            opts: managed.pendingConsult?.opts,
            // Delivery override (set only by intervene() re-targeting to
            // "main"); absent on a fresh park, so conditionally spread to keep
            // the payload shape stable for exact-equality consumers.
            ...(managed.pendingConsult?.to !== undefined ? { to: managed.pendingConsult.to } : {}),
          });
          // 裁定 1：链触发在 manager 内部（fire-and-forget，不阻塞 catch 尾）。
          this.maybeStartReviewChain(managed);
        }
      } else if (managed.controller.signal.aborted) {
        // Deliberate stop/pause/delete. The abort rejection is the MECHANISM of
        // the user's own request, not a failure to report: stop()/pause() have
        // already emitted "stopped"/"paused" and persisted the terminal status.
        // Emitting "error" here made a hand-stopped run announce itself as
        // `✗ Background workflow … failed: Subagent was aborted`, which the
        // result-delivery listener turned into a turn-triggering follow-up —
        // waking the orchestrator to investigate a "failure" the user caused.
      } else if (this.listenerCount("error") > 0) {
        // Guarded: EventEmitter throws on an unlistened "error" emit, which
        // would abort this catch block mid-way — skipping the final persist,
        // the lease release, and the real error rethrow below.
        this.emitLive(managed, "error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state (see the success-path comment above for the
      // isCurrent() rationale — same guard, same reason).
      this.persistRun(managed);
      if (this.isCurrent(managed)) {
        this.releaseRunLease(managed);
        // "paused" (manual pause() or a usage-limit checkpoint) is
        // deliberately NOT eviction-eligible — only a genuinely settled
        // terminal status is (see IN_MEMORY_TERMINAL_STATUSES / the `runs`
        // field doc comment). recordTerminalRun() itself re-checks this too,
        // but skip the call entirely here so a paused run never even enters
        // the eviction queue.
        if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status)) this.recordTerminalRun(managed.runId);
      }

      throw workflowError;
    }
  }

  /**
   * True when `managed` is still the live, current entry for its runId in
   * `this.runs` — false once resume() has replaced it with a new ManagedRun
   * object for the same runId, or deleteRun() has removed it entirely. A
   * superseded ManagedRun's async completion (executeRun's promise settling
   * well after something else already took over or tore down that runId)
   * must not write to disk or touch lease state on the newer execution's
   * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
   */
  private isCurrent(managed: ManagedRun): boolean {
    return this.runs.get(managed.runId) === managed;
  }

  /**
   * Emit an event on behalf of `managed`, but only while it's still the
   * current entry for its runId (see isCurrent()) — mirrors the disk/lease
   * guard for the observer-facing side of the same problem. A superseded
   * execution's progress/terminal events (log, phase, agentStart/End,
   * tokenUsage, complete, error, paused) are not just stale-but-harmless:
   * "complete" in particular can drive background result delivery into the
   * conversation, so letting a deleted/superseded run's stale settle still
   * fire it would deliver a result for a run that, from the caller's POV, no
   * longer exists (or has since been superseded by a newer execution whose
   * own events already tell the true story). No event in this set has a
   * legitimate reason to still reach listeners once superseded — unlike
   * disk writes there's no "expected race, harmless no-op" nuance here, it's
   * simply wrong to notify twice (or for a run that's gone). Events emitted
   * directly by pause()/stop()/resume()/deleteRun() themselves are NOT routed
   * through this helper — those methods own the transition and ARE current
   * at the moment they fire, same precedent as their persist/lease calls.
   */
  private emitLive(managed: ManagedRun, event: string, payload: unknown): void {
    if (this.isCurrent(managed)) this.emit(event, payload);
  }

  /**
   * Mark `runId` as eviction-eligible now that its execution has genuinely
   * settled to a terminal status (completed/failed/aborted — see
   * IN_MEMORY_TERMINAL_STATUSES), and evict the oldest eligible entries
   * beyond maxTerminalRunsInMemory. Callers must only invoke this after the
   * same isCurrent()-gated persistRun()/releaseRunLease() sequence executeRun()
   * already uses (see the `runs` field doc comment for the full contract) —
   * this method itself re-validates the CURRENT entry's status before
   * deleting anything, so it never evicts a run that isn't (or is no longer)
   * genuinely terminal, including one resumed back to "running" after being
   * queued here but before its turn to be evicted came up.
   */
  private recordTerminalRun(runId: string): void {
    this.terminalRunQueue.push(runId);
    while (this.terminalRunQueue.length > this.maxTerminalRunsInMemory) {
      const oldest = this.terminalRunQueue.shift();
      if (oldest === undefined) break;
      const current = this.runs.get(oldest);
      // Re-check the CURRENT entry for this id (not the ManagedRun object
      // that was terminal when queued) — resume() may have since replaced
      // it with a fresh, live execution, which must never be evicted here.
      if (current && IN_MEMORY_TERMINAL_STATUSES.has(current.status)) {
        this.runs.delete(oldest);
      }
    }
  }

  /**
   * Additively fold one agent-call's token cost into the run-wide persisted
   * aggregate (managed.snapshot.tokenUsage), seeded (on resume) from the
   * persisted total-at-pause — see A2. Shared by onAgentEnd (a completed or
   * finally-failed agent call) and onRetrySpend (a failed attempt that WILL
   * be retried, whose cost recordTokens() already folded into
   * shared.spent/tokenUsage in workflow.ts, but which onAgentEnd never sees —
   * see WorkflowRunOptions.onRetrySpend for why that needs its own channel).
   */
  private accumulateTokenUsage(
    managed: ManagedRun,
    tokens: number,
    tokenUsage?: { input: number; output: number; cost: number; cacheRead: number; cacheWrite: number },
  ): void {
    const prior = managed.snapshot.tokenUsage;
    const usage = {
      input: prior?.input ?? 0,
      output: prior?.output ?? 0,
      total: prior?.total ?? 0,
      cost: prior?.cost ?? 0,
      cacheRead: prior?.cacheRead ?? 0,
      cacheWrite: prior?.cacheWrite ?? 0,
    };
    usage.total += tokens;
    if (tokenUsage) {
      usage.input += tokenUsage.input;
      usage.output += tokenUsage.output;
      usage.cost += tokenUsage.cost;
      usage.cacheRead += tokenUsage.cacheRead;
      usage.cacheWrite += tokenUsage.cacheWrite;
    }
    managed.snapshot.tokenUsage = usage;
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
  private static readonly PERSIST_THROTTLE_MS = 400;

  /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Coalesce rapid progress persists (currently: onAgentJournal, which fires
   * once per completed agent and can burst under concurrency) to at most one
   * disk write per PERSIST_THROTTLE_MS (trailing edge) instead of one write
   * per tick — persistRun() does a full JSON.stringify of the run plus up to
   * 3 sync writes, so firing it once per agent in a long run is O(N^2).
   *
   * Lifecycle-critical writes (status transitions, run end, pause/resume/stop)
   * must NOT use this — call persistRun() directly, which flushes (and cancels)
   * any pending timer first so a stale trailing write can never fire after, and
   * resurrect, a terminal state.
   */
  private schedulePersist(managed: ManagedRun): void {
    if (this.persistTimers.has(managed.runId)) return; // already scheduled; the trailing write reads live state
    const timer = setTimeout(() => {
      this.persistTimers.delete(managed.runId);
      this.writeRunToDisk(managed);
    }, WorkflowManager.PERSIST_THROTTLE_MS);
    // A pending progress persist should never keep the process alive on its own.
    timer.unref?.();
    this.persistTimers.set(managed.runId, timer);
  }

  /**
   * Persist immediately and synchronously. Cancels any pending throttled write
   * for this run first, so the write that lands is always the caller's current
   * (final) state — never superseded by a stale deferred write. Use this for
   * every lifecycle-critical persist: run start, status transitions, run end,
   * pause()/resume()/stop().
   */
  private persistRun(managed: ManagedRun): void {
    // A superseded execution's persist call must not touch the CURRENT
    // execution's pending-timer bookkeeping for this runId (see isCurrent()).
    // writeRunToDisk() below re-checks this too (it's the sole choke point
    // schedulePersist()'s deferred timer also funnels through), so this is a
    // belt-and-suspenders early-out specifically for the timer-clearing side
    // effect, which writeRunToDisk() alone wouldn't prevent.
    if (!this.isCurrent(managed)) return;
    const timer = this.persistTimers.get(managed.runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(managed.runId);
    }
    this.writeRunToDisk(managed);
  }

  private writeRunToDisk(managed: ManagedRun) {
    // The sole choke point for every disk write (both persistRun()'s direct
    // calls and schedulePersist()'s deferred timer funnel through here) — skip
    // silently when `managed` is no longer the current entry for its runId
    // (see isCurrent()). This is an expected race outcome (resume() replaced
    // it, or deleteRun() removed it), not an error: writing anyway would
    // resurrect a torn-down run's file, or clobber a newer execution's
    // in-progress/completed state with this stale one's.
    //
    // This check is redundant with persistRun()'s own early-return for every
    // CURRENT call site — it earns its keep solely for schedulePersist()'s
    // deferred setTimeout callback, the one path into this method that skips
    // persistRun() entirely. That callback only fires from onAgentJournal, and
    // onAgentJournal only fires for a call that got PAST agent()'s
    // throwIfAborted() check (see workflow.ts) — which, since run-fatal abort
    // (SharedRuntime.runFatalController) now seals every top-level run's
    // shared runtime the instant any error escapes it uncaught, means a
    // genuinely superseded-but-never-aborted execution (the only kind that
    // could previously still journal a stray call after resume() replaced it)
    // is structurally impossible to construct anymore — see the "unreachable
    // defense-in-depth (#2)" test in workflow-manager.test.ts for the worked
    // example and its own note. This check is KEPT anyway: it costs nothing,
    // and removing it would silently reopen a stale-write path the moment any
    // future change (e.g. a new way to journal without throwIfAborted()'s
    // gate) reintroduces a producer for it.
    if (!this.isCurrent(managed)) return;
    try {
      // Resumable states need their journal; completed/aborted states need rich
      // agent details. Persist exactly one full copy of each agent result instead
      // of writing it to both agents[].result and journal[].result.
      const keepsResumeJournal = managed.status !== "completed" && managed.status !== "aborted";
      this.persistence.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        // Persist the real script + journal so the run can be resumed. Runs live
        // in workflow run storage — protect via directory permissions, not blanking.
        script: managed.script,
        args: managed.args,
        sessionId: this.sessionId,
        journal: keepsResumeJournal ? managed.journal : undefined,
        status: managed.status,
        // The pending consult (waiting_consult runs) — persisted so the
        // intervention point survives a cold restart and resume() rehydrates
        // it onto the ManagedRun (see PersistedRunState.pendingConsult).
        pendingConsult: managed.pendingConsult,
        // Persisted every write (not just at pause) so a stale read during the
        // "paused" event race (see UsageLimitScheduler) is still correct — this
        // is fixed at run-start and doesn't change over the run's lifetime.
        autoResume: managed.autoResume,
        // Auto-review chain's completed-cycle counter (裁定 3) — carried on the
        // managed run so the next consult trigger's cap check sees it. Absent
        // until the first chain completion (undefined stays unpersisted).
        ...(managed.consultAutoApplied !== undefined ? { consultAutoApplied: managed.consultAutoApplied } : {}),
        // Start-time execution context, re-read by resume() (see ManagedRun).
        tokenBudget: managed.tokenBudget,
        toolset: managed.toolset,
        maxAgents: managed.maxAgents,
        agentTimeoutMs: managed.agentTimeoutMs,
        concurrency: managed.concurrency,
        agentRetries: managed.agentRetries,
        // Why a usage-limit pause happened, so the navigator / a future cold start
        // can show it and (eventually) re-arm resume after the budget refills.
        pauseReason: managed.status === "paused" && isProviderUsageLimit(managed.error) ? "usage_limit" : undefined,
        resetHint:
          managed.status === "paused" && isProviderUsageLimit(managed.error) ? managed.error.resetHint : undefined,
        phases: managed.snapshot.phases,
        currentPhase: managed.snapshot.currentPhase,
        // Real per-agent timestamps only (see agentTimestamps) — never the run's
        // own startedAt or "now" stamped onto every agent on every write. A
        // still-running agent is persisted with no endedAt.
        agents: managed.snapshot.agents.map((a) => {
          const { result, ...summary } = a;
          const ts = managed.agentTimestamps.get(a.id);
          return {
            ...summary,
            // Live runs keep the rich value in memory. Cold resumable runs use
            // the journal and retain resultPreview until replay reconstructs it.
            ...(keepsResumeJournal || result === undefined ? {} : { result }),
            startedAt: ts?.startedAt,
            endedAt: ts?.endedAt,
          };
        }),
        logs: managed.snapshot.logs,
        result: managed.result?.result,
        tokenUsage: managed.snapshot.tokenUsage
          ? {
              input: managed.snapshot.tokenUsage.input,
              output: managed.snapshot.tokenUsage.output,
              total: managed.snapshot.tokenUsage.total,
              cost: managed.snapshot.tokenUsage.cost,
              cacheRead: managed.snapshot.tokenUsage.cacheRead,
              cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
            }
          : undefined,
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Answer a waiting_consult run's intervention point — the single choke
   * point (spec §4) through which every resolution flows: journal the outcome
   * under the pending consult's call anchor, clear the pending consult, flip
   * the run to paused, persist, and resume. Returns false when the run is not
   * actually parked on a pending consult (already answered, completed,
   * stopped…).
   *
   * `options.script` is the (possibly edited) script to resume with — the
   * review reply or the user's own edit. When omitted, the persisted script
   * resumes as-is ("维持原脚本继续"). A supplied script is validated here and
   * a malformed one THROWS (the tool layer decides how to surface the error —
   * keeping the run parked on waiting_consult). The state gate (waiting_consult
   * + pending consult) runs FIRST, so a reply to a run that is no longer
   * parked returns false even when the reply's script is malformed — the
   * malformed-script throw is reserved for genuinely parked runs.
   *
   * `options.summary` and `options.expectedGeneration` are
   * applyReviewChain()-specific additions (NOT part of the public reply
   * contract, which is `{script?}`): the chain's review summary is merged
   * into the pending consult before the outcome is built (so
   * buildConsultOutcome() journals it), and the captured generation is
   * re-validated INSIDE the same critical section that writes — a
   * cross-process intervene that bumped the generation after the chain's own
   * fast-fail check discards the stale chain (return false, zero side
   * effects) instead of applying its script.
   *
   * Lock semantics (honest): the run lease is a CONSULT lock, not a general
   * write lock — save() itself does not validate it (see run-persistence),
   * and while a run is parked on waiting_consult the process holding the
   * in-memory copy writes to disk WITHOUT the lease (intervene /
   * markConsultFailed / resolveConsult funnel through persistRun →
   * writeRunToDisk → save). The lease only serializes lease-holding writers
   * (this disk branch and stop()'s disk branch); a peer's unlocked
   * in-memory-path save landing between this branch's lease-held reload and
   * save is a known residual µs-level window that the lease narrows but
   * cannot fully close.
   *
   * Ordering matters: persistRun() runs BEFORE resume() because resume()
   * rebuilds its journal exclusively from disk — an entry that only ever
   * reached memory would be silently dropped when resume() reconstructs the
   * run, and the user's answer would be lost to a re-pended consult. The
   * resume() waiting_consult guard would deadlock this choke point, so the
   * run is flipped to paused first (the existing paused-resumable path) — in
   * memory, and on disk by the persist below.
   */
  async resolveConsult(
    runId: string,
    options?: { script?: string; summary?: string; expectedGeneration?: number },
  ): Promise<boolean> {
    const managed = this.runs.get(runId);
    const persisted = this.persistence.load(runId);
    const pending = managed?.pendingConsult ?? persisted?.pendingConsult;
    const expectedGeneration = options?.expectedGeneration;

    // State gate FIRST — before script validation: only a run parked on
    // waiting_consult — in memory, or on disk after a cold start
    // (recoverStaleRuns leaves waiting_consult runs parked) — with a pending
    // consult may be answered. A reply to a completed/already-resolved run
    // is refused by contract, and a malformed script in that reply must
    // return false rather than throw.
    if (!pending) return false;
    if (managed) {
      if (managed.status !== "waiting_consult") return false;
    } else {
      if (!persisted || persisted.status !== "waiting_consult") return false;
    }

    if (options?.script !== undefined) {
      parseWorkflowScript(options.script); // throws on a malformed script
    }

    // Journal the outcome under the pending consult's call anchor — skipped
    // for intervene()-created consults, which have no consult() call to
    // answer (their prompt is the intervention itself, not a review reply).
    // A chain-supplied `summary` (applyReviewChain) is merged into the
    // pending consult BEFORE the outcome is built, so buildConsultOutcome()
    // sees it (链应用 → applied:true + 链摘要 + 已应用脚本，双审查重要 2)。
    const buildEntry = (p: PendingConsult): JournalEntry | undefined => {
      const merged: PendingConsult =
        options?.summary !== undefined ? { ...p, summary: options.summary } : p;
      if (merged.callIndex !== undefined && merged.journalPrefix !== undefined) {
        return {
          index: merged.callIndex,
          runId: merged.journalPrefix.replace(/:$/, ""),
          hash: hashConsult(merged.prompt, merged.opts),
          result: buildConsultOutcome(merged, options?.script),
        };
      }
      return undefined;
    };

    if (managed) {
      // Memory path: ONE synchronous critical section — the generation
      // re-check, summary merge, journal append, pending clear, status flip,
      // chain increment and persist below run with no await between them, so
      // no in-process writer can interleave. applyReviewChain's own check is
      // a fast-fail; this re-check (against the snapshot the write is built
      // from) is the authoritative one.
      if (expectedGeneration !== undefined && pending.generation !== expectedGeneration) {
        return false;
      }
      const revisedPath = (pending as ManagerPendingConsult).revisedPath;
      const journalEntry = buildEntry(pending);
      if (journalEntry) managed.journal = [...managed.journal, journalEntry];
      delete managed.pendingConsult;
      managed.status = "paused";
      // 重要 1：链应用（summary 标记）在临界区内递增 consultAutoApplied，并入同一
      // 次 persistRun 的 save——不再在链的 await 返回后微任务落地，闭合「应用后
      // 同步连打咨询读到陈旧计数」的竞态。用户 reply（无 summary）不递增。
      if (options?.summary !== undefined) {
        managed.consultAutoApplied = (managed.consultAutoApplied ?? 0) + 1;
      }
      // Disk must carry paused + no pending + the journal entry BEFORE
      // resume() runs (resume()'s journal source is disk alone).
      this.persistRun(managed);
      // 次要 2：pending 消亡即清建议文件（confirm 链保留的 tmp 只被该 pending
      // 引用；失配 false 路径不删——pending 仍在等答复）。
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
    } else {
      // Disk-only cold-start path: no in-memory object to flip — flip the
      // persisted state directly (same lease-protected pattern as stop()'s
      // disk branch). resume() below then materializes the run itself.
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) return false;
      try {
        // ONE lease-held critical section: "reload → status gate → generation
        // re-check → summary merge → journal → clear → paused → save" is a
        // single write, so the state the journal entry is built from is the
        // state that gets saved — no separate two-phase write can split it.
        // (load() holds no lock and save() does not check it either — see the
        // lock-semantics note in the doc comment: the lease narrows, but a
        // peer's unlocked in-memory-path save landing between this reload and
        // save is a documented residual µs-level window.)
        const latest = this.persistence.load(runId);
        if (!latest || latest.status !== "waiting_consult") return false;
        // Cross-process generation re-check (see expectedGeneration above):
        // an intervene in another process may have bumped the generation
        // after applyReviewChain's fast-fail check — the stale chain's script
        // must not be applied (return false, no journal write, no state
        // touched).
        if (expectedGeneration !== undefined && latest.pendingConsult?.generation !== expectedGeneration) {
          return false;
        }
        const revisedPath = (latest.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
        const journalEntry = latest.pendingConsult ? buildEntry(latest.pendingConsult) : undefined;
        this.persistence.save({
          ...latest,
          status: "paused",
          pendingConsult: undefined,
          ...(journalEntry ? { journal: [...(latest.journal ?? []), journalEntry] } : {}),
          // 重要 1：链应用在临界区内递增，并入同一次 save（磁盘分支同内存路径）。
          ...(options?.summary !== undefined ? { consultAutoApplied: (latest.consultAutoApplied ?? 0) + 1 } : {}),
          updatedAt: new Date().toISOString(),
        });
        if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
      } finally {
        this.persistence.releaseRunLease(lease);
      }
    }

    // Resume from the persisted (or edited) script. The persist above already
    // flipped disk to paused, so resume()'s status guards and journal source
    // see the resolved state, not waiting_consult.
    //
    // 必修 1（最终审查收口）：skipConsultSettledCheck 必须为 true——resume 的
    // settled:false 前置检查是为拒绝「静默跳过未答复 consult」的裸恢复设计的，
    // resolveConsult 不是裸恢复，两条路径都绝不静默跳过：
    //   1) 有锚点 pending（callIndex/journalPrefix 齐备）：上文刚写了遮蔽性
    //      journal entry，答复本身成为新尾条——检查本就会通过（settled 不存在）；
    //   2) 无锚点 pending（intervene 所建，无 callIndex 故不写 entry、无法遮蔽
    //      尾条）或脚本变化：重放对 settled:false 条目按 miss 处理 → 直播执行 →
    //      consult 重新挂起、用户仍可答复（参见 workflow.ts consult 的 settled:false
    //      分支），不是静默跳过。
    // 若不绕过：无锚点 pending 遇到 settled:false 尾条时，上文已清 pending/置
    // paused/persist，这里 resume() 返回 false —— resolveConsult 返回 false 但
    // 状态已变更：回复被静默消费、运行搁浅在 paused 且无 pendingConsult、工具层
    // 误报「回复未生效」（最终审查已独立复现）。
    return this.resume(runId, {
      ...(options?.script !== undefined ? { script: options.script } : {}),
      // 仅 resolveConsult 传 true（内部标志，公开调用方不可见）。
      skipConsultSettledCheck: true,
    });
  }

  /**
   * Mark a waiting_consult run's review as failed (no answer produced):
   * journal a settled:false outcome under the pending consult's anchor (so a
   * later resume REPENDS the consult instead of replaying past it — see the
   * settled:false semantics in workflow.ts's consult()), clear the pending
   * consult, fail the run, persist, mark it terminal, and emit an error
   * event. Returns without doing anything when the run is not parked on a
   * pending consult.
   */
  async markConsultFailed(runId: string, reason: string): Promise<void> {
    const managed = this.runs.get(runId);
    const persisted = this.persistence.load(runId);
    const pending = managed?.pendingConsult ?? persisted?.pendingConsult;

    if (!pending) return;

    let journalEntry: JournalEntry | undefined;
    if (pending.callIndex !== undefined && pending.journalPrefix !== undefined) {
      journalEntry = {
        index: pending.callIndex,
        runId: pending.journalPrefix.replace(/:$/, ""),
        hash: hashConsult(pending.prompt, pending.opts),
        result: { applied: false, reason, settled: false },
      };
    }

    const error = new WorkflowError(reason, WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    if (managed) {
      if (managed.status !== "waiting_consult") return;
      const revisedPath = (pending as ManagerPendingConsult).revisedPath;
      if (journalEntry) managed.journal = [...managed.journal, journalEntry];
      delete managed.pendingConsult;
      managed.status = "failed";
      managed.error = error;
      // 重要 1：失败也递增（裁定 3），且并入本次 persistRun 的同一次 save——
      // 不再由链在 await 返回后单独 persistRun（闭合微任务竞态）。
      managed.consultAutoApplied = (managed.consultAutoApplied ?? 0) + 1;
      this.persistRun(managed);
      // 次要 2：pending 消亡即清建议文件。
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
      // Emit BEFORE recordTerminalRun(), mirroring executeRun()'s catch tail
      // (emit → persist → record). In the failed → resume → re-terminal
      // scenario the runId is already in the terminal queue; recordTerminalRun's
      // push-shift can then evict this very runId, making emitLive()'s
      // isCurrent() check fail and silently dropping the error event. Emitting
      // while the run is still current guarantees delivery.
      if (this.listenerCount("error") > 0) this.emitLive(managed, "error", { runId, error });
      this.recordTerminalRun(runId);
    } else {
      if (!persisted || persisted.status !== "waiting_consult") return;
      const lease = this.persistence.acquireRunLease(runId);
      if (!lease) return;
      try {
        const revisedPath = (persisted.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
        this.persistence.save({
          ...persisted,
          status: "failed",
          pendingConsult: undefined,
          ...(journalEntry ? { journal: [...(persisted.journal ?? []), journalEntry] } : {}),
          // 重要 1：失败也递增，并入同一次 save（磁盘分支同内存路径）。
          consultAutoApplied: (persisted.consultAutoApplied ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
      } finally {
        this.persistence.releaseRunLease(lease);
      }
      // Disk-only cold-start path: the state transition happened with no
      // in-memory execution (and none superseded), so there is no
      // isCurrent()-style stale execution whose event could mislead — a plain
      // guarded emit is the correct ownership, and matches the memory path's
      // error-event contract. Guarded like executeRun's catch tail:
      // EventEmitter throws on an unlistened "error" emit.
      this.recordTerminalRun(runId);
      if (this.listenerCount("error") > 0) this.emit("error", { runId, error });
    }
  }

  /**
   * Intervene on a running/paused workflow: park it on waiting_consult with a
   * to:"main" pending consult (no call anchor — there is no consult() call to
   * answer), persist, THEN abort the controller so the execution stops at its
   * next cooperative checkpoint. The catch tail's abort branch only rewrites
   * status when it is still "running", so the waiting_consult status set here
   * is preserved. On an already-waiting_consult run, re-target DELIVERY to
   * "main" via the `to` override field and bump the generation — invalidating
   * any in-flight review chain that captured the older generation
   * (applyReviewChain drops it). The pending opts are never rewritten: they
   * ARE the hash identity resolveConsult journals and replay recomputes, so
   * rewriting them would silently discard the answer (replay miss → re-pend).
   * The memory fresh-park branch emits "consult-pending" (to:"main" delivery
   * override) right after persistRun — the delivery layer routes on to ?? opts.to
   * and wakes the main agent, closing the intervene→reply loop that was a silent
   * dead end when the catch tail alone was the only emission point (its abort
   * path is excluded by the `!aborted` consultPending guard). The memory
   * re-target branch emits only when the original delivery was suppressed
   * (to:"agent" and non-confirm — see the branch comment): shapes already
   * delivered at park (to:"main", confirm-exempt to:"agent", to-缺省) must not
   * be re-sent, or the main agent receives the same consult message twice.
   * Returns false when the run is not in a reachable state.
   */
  intervene(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (managed.status === "running" || managed.status === "paused") {
        managed.status = "waiting_consult";
        managed.pendingConsult = {
          prompt: "用户主动介入",
          opts: { to: "main" },
          generation: (managed.pendingConsult?.generation ?? 0) + 1,
        };
        this.persistRun(managed);
        // 重要 1（任务 5 复检）：intervene 投递闭环——persist 后发射
        // consult-pending（to:"main" 投递覆盖）。此前全仓库 consult-pending 唯一
        // 发射点在 catch 尾（intervene 的 abort 路径被 `!aborted` 排除），主代理
        // 收不到任何消息/唤醒，intervene→reply 回路静默死端。投递层按 to ?? opts.to
        // 分流 + wakesTurn 判定，发射即闭环。abort 后 catch 尾的 consultPending
        // 判定为 false（!aborted 不成立），不会重复发射。
        const pending = managed.pendingConsult;
        this.emitLive(managed, "consult-pending", {
          runId: managed.runId,
          prompt: pending.prompt,
          opts: pending.opts,
          to: "main",
        });
        // After persist — the catch tail keeps the waiting_consult status we
        // just set (its abort branch only overwrites "running").
        managed.controller.abort();
        return true;
      }
      if (managed.status === "waiting_consult") {
        const existing = managed.pendingConsult;
        if (!existing) return false;
        // Re-target DELIVERY to "main" via the `to` override field — never
        // by rewriting opts.to. The pending opts are the script's ORIGINAL
        // consult() call: resolveConsult hashes them, and replay recomputes
        // the identical hash from the script's own call, so rewriting opts.to
        // would corrupt the hash identity and silently drop the answer
        // (replay miss → re-pend). Delivery routing reads `to ?? opts.to`.
        managed.pendingConsult = {
          ...existing,
          to: "main",
          generation: existing.generation + 1,
        };
        this.persistRun(managed);
        // 重要 1（任务 5 复检）：改投分支补投递事件——携带 to:"main" 覆盖字段
        // （投递层读 to ?? opts.to 分流）。原投递被抑制的 to:"agent" 咨询（自动审阅
        // 链自治）在此刻才真正送达主代理，人工答复回路由此闭环。
        //
        // 复检重要 2（复检 A）：投递层无去重，去重必须落在守卫侧——有效投递目标取
        // `to ?? opts.to`，而 park 即已投递的形状不止 to:"main"：confirm 豁免抑制的
        // to:"agent"（task-panel 抑制条件 `(to ?? opts.to) === "agent" && apply !==
        // "confirm"`）与 to 缺省（(undefined ?? undefined) !== "agent"）在 park 时都
        // 已送达主代理。旧守卫仅 `target !== "main"` 漏判这两种形状、改投时再次发射
        // ——主代理重复收到同一条咨询消息（旧 ⑬ 在 park 后注册监听器才令「恰一次」
        // 断言失明）。新守卫取投递层抑制条件的**取反**：仅原投递确被抑制
        // （to:"agent" 且非 confirm）时补发射；其余（to 缺省、confirm、main）跳过。
        // generation+1 与陈旧链失效语义照常保留。
        const suppressed = (existing.to ?? existing.opts.to) === "agent" && existing.opts.apply !== "confirm";
        if (suppressed) {
          const pending = managed.pendingConsult;
          this.emitLive(managed, "consult-pending", {
            runId: managed.runId,
            prompt: pending.prompt,
            opts: pending.opts,
            to: "main",
          });
        }
        return true;
      }
      return false;
    }

    // Disk-only fallback: the run lives in another process (or a prior pi
    // session) — flip the persisted state directly (same lease-protected
    // pattern as stop()'s disk branch).
    const persisted = this.persistence.load(runId);
    if (
      !persisted ||
      (persisted.status !== "running" && persisted.status !== "paused" && persisted.status !== "waiting_consult")
    ) {
      return false;
    }
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const existing = persisted.pendingConsult;
      this.persistence.save({
        ...persisted,
        status: "waiting_consult",
        pendingConsult:
          persisted.status === "waiting_consult" && existing
            ? { ...existing, to: "main", generation: existing.generation + 1 }
            : { prompt: "用户主动介入", opts: { to: "main" }, generation: (existing?.generation ?? 0) + 1 },
        updatedAt: new Date().toISOString(),
      });
    } finally {
      this.persistence.releaseRunLease(lease);
    }
    return true;
  }

  /**
   * Apply a finished review chain's result to a waiting_consult run. The
   * chain captured `generation` when it started; if the run has since been
   * re-targeted by intervene() (generation bumped), the result is stale and
   * is DISCARDED — returns false without journaling or touching state (tmp
   * cleanup is the caller's job).
   *
   * Pure validation + delegation: a fast-fail check (pending consult exists,
   * captured generation still matches) then a hand-off to resolveConsult(),
   * the single choke point, with the chain's `summary` and `expectedGeneration`
   * — resolveConsult merges the summary into the pending consult,
   * re-validates the generation, journals the outcome, clears the pending
   * consult, flips the run to paused, persists, and resumes, all inside ONE
   * critical section (synchronous in memory; one lease-held reload→save on
   * the disk branch). There is deliberately no separate summary write here:
   * the old two-phase write (chain persists the summary, then resolveConsult
   * re-validates and resolves) left a window in which a peer's unlocked write
   * could land between the two saves and be clobbered — closed by
   * construction now.
   *
   * Lock semantics (honest): the lease is a CONSULT lock — save() does not
   * validate it, and the in-memory run holder writes to disk WITHOUT the
   * lease while the run is parked on waiting_consult (intervene /
   * markConsultFailed / resolveConsult funnel through persistRun → save). The
   * lease therefore only serializes lease-holding writers; a peer's unlocked
   * save landing between this disk branch's lease-held reload and save is a
   * known residual µs-level window, documented in resolveConsult's doc
   * comment — not a closed serialization guarantee.
   */
  async applyReviewChain(
    runId: string,
    options: { generation: number; script?: string; summary: string },
  ): Promise<boolean> {
    // Fast-fail: no pending consult, or a generation bump since the chain
    // captured it (a re-target to main) — discard the stale chain before any
    // write. The authoritative re-check happens inside resolveConsult's
    // critical section; this is an early-out for the common stale case.
    const managed = this.runs.get(runId);
    const persisted = this.persistence.load(runId);
    const pending = managed?.pendingConsult ?? persisted?.pendingConsult;
    if (!pending || pending.generation !== options.generation) return false;

    return this.resolveConsult(runId, {
      ...(options.script !== undefined ? { script: options.script } : {}),
      summary: options.summary,
      // Re-validated inside resolveConsult's critical section (the memory
      // path's synchronous check, or the disk branch's lease-held reload): a
      // peer intervene that bumped the generation after this fast-fail check
      // discards the stale chain — return false, zero side effects.
      expectedGeneration: options.generation,
    });
  }

  /**
   * 裁定 1：consult-pending 后的链触发分流——在 manager 内部决定是否派生自动审阅链
   * （fire-and-forget，不阻塞 catch 尾）。投递目标取 `to ?? opts.to`（intervene 的
   * 改投覆盖优先）：to:"main" 不启动（人工答复走 workflow_control）；apply:"confirm"
   * 启动但只产出建议（裁定 4，不应用）；apply 缺省归一为 "auto"（规格 §1；双审查
   * 关键 1：省略 apply 必须照常启动链——否则 to:agent 咨询三路皆空永久挂起），
   * 且 consultAutoApplied 未超上限（递增前 > 5 判定）时启动；超限回落
   * waiting_consult + 发射 consult-limit（人工兜底）。
   */
  private maybeStartReviewChain(managed: ManagedRun): void {
    const pc = managed.pendingConsult;
    if (!pc || (pc.to ?? pc.opts.to) === "main") return;
    const apply = pc.opts.apply ?? "auto"; // 关键 1：规格 §1 缺省 "auto"
    if (apply === "confirm") {
      void this.runAutoReviewChain(managed.runId).catch(() => {});
      return;
    }
    const autoApplied = this.persistence.load(managed.runId)?.consultAutoApplied ?? 0;
    if (autoApplied > 5) {
      this.emitLive(managed, "consult-limit", { runId: managed.runId });
      return;
    }
    void this.runAutoReviewChain(managed.runId).catch(() => {});
  }

  /**
   * 自动审阅链（裁定 2-7 + 双审查修复）：在 manager 内部派生审阅子代理，产出修订
   * 脚本（写入 tmp 文件）、链内校验（parseWorkflowScript）后经 applyReviewChain
   * 应用；至多重试 1 次（反馈按失败原因分流：解析失败 / 缺文件 / 拒绝 / 调用异常，
   * 双审查次要 3）。仍失败 → auto 模式 markConsultFailed（含恢复指引）；confirm 模式
   * 保持 waiting_consult（双审查次要 1：confirm 链只是建议生成器，失败不 kill 整个
   * run——标准咨询消息已在 park 时投递，用户仍可 reply）。
   *
   * consultAutoApplied 递增（重要 1）：移入 resolveConsult / markConsultFailed 的
   * 临界区、与各自 persistRun 同一次 save——闭合「应用后同步连打咨询读到递增前
   * 计数」的微任务竞态（上限绕过 + tmp 碰撞的根源）。
   *
   * 陈旧链判定（关键 2：代际数字会被 fresh park 回收为 0，纯 generation 比较会把
   * 旧咨询 A 的修订误用到新咨询 B）——启动时捕获 pendingConsult 的**对象引用**
   * pendingRef，每次触碰前校验 `managed.pendingConsult === pendingRef`：
   * resolveConsult / intervene / re-park 均换对象，失配即陈旧 → rmSync tmp + 静默
   * 丢弃；applyReviewChain 的 generation 检查作第二道防线（intervene 若原地突变
   * 由它兜底）。
   *
   * tmp 生命周期（关键 3：confirm 保留的文件被同路径复用误读）——文件名带唯一
   * nonce 杜绝跨链碰撞，且链启动时 rmSync(tmpPath, {force:true}) 清掉任何陈旧残留。
   */
  private async runAutoReviewChain(runId: string): Promise<void> {
    const parked = this.runs.get(runId);
    const pending = parked?.pendingConsult;
    if (!parked || parked.status !== "waiting_consult" || !pending) return;
    if ((pending.to ?? pending.opts.to) === "main") return;
    // 关键 2：捕获对象引用（而非代际数字——数字会被 fresh park 回收）。
    const pendingRef = pending as ManagerPendingConsult;
    const generation = pending.generation;
    const applyMode = pending.opts.apply ?? "auto"; // 关键 1：与触发点同步归一
    const n = (this.persistence.load(runId)?.consultAutoApplied ?? 0) + 1;
    // 关键 3：nonce 文件名 + 启动即清残留（跨链同路径复用误读的最后防线）。
    // 复检 A P3（顺手加固）：nonce 用 randomUUID 替换 1ms 分辨率时间戳（理论碰撞）。
    const tmpPath = join(tmpdir(), `consult-${runId}-${generation}-${n}-${randomUUID()}.js`);
    rmSync(tmpPath, { force: true });
    let lastFailure: { kind: ReviewFailureKind; detail: string } | undefined;

    // 陈旧校验：resolve/intervene/re-park 均换对象；失配 → 丢弃（零状态触碰）。
    const stale = (): boolean => {
      const managed = this.runs.get(runId);
      return !managed || managed.status !== "waiting_consult" || managed.pendingConsult !== pendingRef;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = this.buildReviewPrompt(parked, pending, tmpPath, lastFailure);
      let result: { ok: true; summary: string } | { ok: false; reason: string };
      try {
        result = await this.runReviewAgent(runId, prompt);
      } catch (error) {
        // 关键 4：runReviewAgent 异常（provider 错误等）不再被 fire-and-forget 吞掉
        // 导致永久 waiting_consult + tmp 泄漏——按一次审阅失败处理（记 lastFailure
        // 后走重试/失败路径）。
        lastFailure = { kind: "error", detail: error instanceof Error ? error.message : String(error) };
        continue;
      }

      // 审阅期间可能 stop()/intervene()/resolveConsult()/re-park——对象身份校验。
      if (stale()) {
        rmSync(tmpPath, { force: true });
        return; // 陈旧结果：静默丢弃，不递增 consultAutoApplied
      }
      const managed = this.runs.get(runId)!;
      // 裁定 5：审阅 token 已经 onUsage 累加进运行快照——超预算按失败路径处理
      // （不重试：重试只会继续花费）。confirm 失败保持 waiting_consult（次要 1）。
      const budget = managed.tokenBudget;
      if (budget !== null && budget !== undefined && (managed.snapshot.tokenUsage?.total ?? 0) > budget) {
        rmSync(tmpPath, { force: true });
        if (applyMode !== "confirm") {
          await this.markConsultFailed(
            runId,
            `自动审阅链 token 花费超出运行预算（${budget}）。请用 /workflows resume 带脚本恢复（咨询将重新挂起，届时可答复）`,
          );
        }
        return;
      }
      if (!result.ok) {
        lastFailure = { kind: "reject", detail: result.reason };
        continue;
      }
      let revised: string;
      try {
        revised = readFileSync(tmpPath, "utf8");
      } catch (error) {
        lastFailure = { kind: "nofile", detail: String(error) };
        continue;
      }
      try {
        parseWorkflowScript(revised);
      } catch (error) {
        lastFailure = { kind: "parse", detail: String(error) };
        continue;
      }
      if (applyMode === "confirm") {
        // 裁定 4 + 次要 2：不应用——建议落 pendingConsult（revisedScript/summary/
        // revisedPath），persistRun 后发射 consult-review-ready；tmp 保留到 pending
        // 消亡（resolveConsult/stop/markConsultFailed/deleteRun 清理）。
        managed.pendingConsult = {
          ...managed.pendingConsult!,
          revisedScript: revised,
          summary: result.summary,
          revisedPath: tmpPath,
        };
        this.persistRun(managed);
        this.emitLive(managed, "consult-review-ready", { runId, summary: result.summary, revisedPath: tmpPath });
        return;
      }
      // 关键 2 最后一道闸：apply 前再校验一次对象身份（applyReviewChain 的
      // generation 检查兜底 intervene 原地突变场景——两道防线并存）。
      if (stale()) {
        rmSync(tmpPath, { force: true });
        return;
      }
      await this.applyReviewChain(runId, { generation, script: revised, summary: result.summary });
      // 成功应用/失配丢弃均由 applyReviewChain → resolveConsult 临界区统一裁决；
      // consultAutoApplied +1 在 resolveConsult 内与 persistRun 同一次 save（重要 1）。
      rmSync(tmpPath, { force: true });
      return;
    }
    rmSync(tmpPath, { force: true });
    // 复检 B 关键 2 残留：异常耗尽路径此前缺对象身份校验——catch 直接 continue、
    // 循环耗尽后无条件 markConsultFailed。若末次尝试抛异常时用户已 reply（q1 收口
    // → 恢复 → q2 fresh re-park，代际数字回收为 0）或 intervene（pending 换对象），
    // markConsultFailed 的 status 守卫（waiting_consult 且 pending 存在）会通过，
    // 陈旧链对 fresh 咨询落 settled:false journal、run 置 failed、发误导 error
    // 事件、consultAutoApplied 误 +1。与正常返回路径一致：先 stale() 再落地失败态。
    if (stale()) return;
    if (applyMode !== "confirm") {
      await this.markConsultFailed(
        runId,
        `审阅子代理未能产出可解析的修改后脚本：${lastFailure?.detail || "未知原因"}。请用 /workflows resume 带脚本恢复（咨询将重新挂起，届时可答复）`,
      );
    }
    // confirm 模式重试耗尽：保持 waiting_consult（次要 1），用户仍可 reply。
  }

  /** 审阅子代理的系统指引（附加在任务 prompt 之前）。 */
  private static readonly REVIEW_AGENT_INSTRUCTIONS =
    "你是 workflow 脚本审阅者：审查脚本逻辑并产出修改后的完整脚本。必须把修改后的完整脚本用 write 工具写入任务指定的文件路径（一次性写全量，不要只写改动片段），并严格按任务要求的 JSON 格式返回结果。";

  /**
   * 组装审阅任务 prompt：运行快照摘要 + 当前脚本全文 + consult 咨询内容 +
   * tmpPath 写入指示 + JSON 返回约定；第 2 次尝试附上次失败反馈（按原因分流——
   * 双审查次要 3：parse 失败 / 缺文件 / 拒绝 / 调用异常各有独立文案，不再恒说
   * 「未通过解析」）。
   */
  private buildReviewPrompt(
    managed: ManagedRun,
    pending: PendingConsult,
    tmpPath: string,
    failure?: { kind: ReviewFailureKind; detail: string },
  ): string {
    const snap = managed.snapshot;
    const header =
      `你是 workflow 脚本审阅者。运行 ${managed.runId} 在 consult() 咨询点暂停等待审阅。\n` +
      `咨询内容：${pending.prompt}\n` +
      `运行摘要：${snap.name}${snap.phases.length > 0 ? `（阶段：${snap.phases.join("、")}）` : ""}` +
      `，已完成 ${snap.doneCount}/${snap.agentCount} agents。\n` +
      `当前脚本全文：\n\`\`\`js\n${managed.script}\n\`\`\`\n`;
    const task =
      `请审阅脚本并给出修改，把修改后的完整脚本写入文件 ${tmpPath}（用 write 工具一次性写全量）。\n` +
      `完成后返回 JSON：{"ok": true, "summary": "修改摘要"}；若无法完成，返回 {"ok": false, "reason": "原因"}。`;
    if (!failure) return `${header}\n${task}`;
    const feedback =
      failure.kind === "parse"
        ? `上一次审阅产出的脚本未通过解析：\n${failure.detail}`
        : failure.kind === "nofile"
          ? `上一次审阅没有把修改后的完整脚本写入指定文件（读文件失败）：${failure.detail}`
          : failure.kind === "reject"
            ? `上一次审阅拒绝产出修订：${failure.detail}`
            : `上一次审阅调用失败：${failure.detail}`;
    return `${header}\n${task}\n\n${feedback}`;
  }

  /**
   * 派生审阅子代理并执行一次审阅（裁定 2 的 runReviewAgent）。复用注入的 runner
   * （this.agent，测试注入 mock）；缺省构建与 executeRun 同款配置的 WorkflowAgent
   * （mainModel/modelRegistry/persistAgentSessions/syncHostTools/enableIrc/
   * excludeTools；工具面 = 默认编码工具集——write 已在其中，workflow/workflow_control
   * 经 DEFAULT_EXCLUDED_SUBAGENT_TOOLS 排除）。输出约定：把修改后完整脚本写入 prompt
   * 指定的 tmpPath，返回 JSON {ok:true,summary} | {ok:false,reason}（宽松解析：非 JSON
   * 文本按 ok 处理，脚本合法性由链内 parseWorkflowScript 把关）。token usage 经
   * onUsage 回调实时累加进运行快照（裁定 5：有上报通道），预算校验由链执行。
   */
  private async runReviewAgent(
    runId: string,
    prompt: string,
  ): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
    const runner = this.agent ?? this.defaultReviewAgent();
    const raw = await runner.run(prompt, {
      label: "consult-review",
      sessionName: `workflow:${runId} consult review`,
      instructions: WorkflowManager.REVIEW_AGENT_INSTRUCTIONS,
      onUsage: (usage: AgentUsage) => {
        // 审阅期间 run 可能被替换（人工答复 → resume）——只累加进当前 managed，
        // 陈旧对象上的累加自然随 isCurrent() 防线丢弃。
        const current = this.runs.get(runId);
        if (current) this.accumulateTokenUsage(current, usage.total, usage);
      },
    });
    const text = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // 宽松解析（类型守卫收窄后再读字段，不信任未校验形状）：{ok:false, reason}
    // 视为审阅失败；其余（含非 JSON 文本）按成功处理，summary 取 summary 字段或原文。
    if (isReviewReply(parsed) && parsed.ok === false) {
      return { ok: false, reason: typeof parsed.reason === "string" ? parsed.reason : "审阅子代理未完成任务" };
    }
    const summary = isReviewReply(parsed) && typeof parsed.summary === "string" ? parsed.summary : text;
    return { ok: true, summary };
  }

  /** 缺省审阅代理（懒构建一次；注入 runner 存在时永远用注入的）。 */
  private defaultReviewAgentInstance?: WorkflowAgent;
  private defaultReviewAgent(): Pick<WorkflowAgent, "run"> {
    if (this.agent) return this.agent;
    this.defaultReviewAgentInstance ??= new WorkflowAgent({
      cwd: this.cwd,
      mainModel: this.mainModel,
      modelRegistry: this.modelRegistry,
      persistAgentSessions: this.persistAgentSessions,
      syncHostTools: this.syncHostTools,
      enableIrc: this.enableIrc,
      excludeTools: this.excludeSubagentTools,
    });
    return this.defaultReviewAgentInstance;
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   *
   * `opts.script` lets the orchestrating model resume with an EDITED script
   * (cached-prefix reuse / iteration): unchanged agent() calls whose content
   * hash still matches the journal entry at their positional callIndex replay
   * from cache, while the first changed or newly inserted call — and everything
   * after it — re-runs live. When `opts.script` is omitted, resume behaves
   * exactly as before and uses the persisted script (auto-resume, TUI resume);
   * this keeps the existing single-arg `resume(runId)` callers (e.g. the
   * UsageLimitScheduler) unchanged. `opts.args` overrides the persisted args
   * only when provided; otherwise the persisted args are kept.
   *
   * `opts.skipConsultSettledCheck` is INTERNAL — only resolveConsult() passes
   * true. The settled:false veto below exists to refuse PLAIN resumes that
   * would silently skip past a consult whose review failed without an answer;
   * resolveConsult is never a plain resume (see the safety rationale at its
   * call site), so its internal resume must not be vetoed AFTER it has
   * already cleared the pending consult and flipped the run to paused — a
   * veto there would strand the run (reply consumed, status paused, no
   * pendingConsult) while resolveConsult still reports false.
   */
  async resume(
    runId: string,
    opts?: { script?: string; args?: unknown; skipConsultSettledCheck?: boolean },
  ): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, one that was
    // intentionally aborted (pause/stop/Esc), or one parked on a pending
    // consult (waiting_consult — only resolveConsult may release it, by
    // flipping the status to paused first; see the stop() doc comment's
    // waiting_consult notes). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;
    if (active?.status === "waiting_consult") return false;

    const persisted = this.persistence.load(runId);
    if (
      !persisted?.script ||
      persisted.status === "completed" ||
      persisted.status === "aborted" ||
      persisted.status === "waiting_consult"
    ) {
      return false;
    }

    // A consult that failed without an answer (markConsultFailed) journaled a
    // settled:false outcome — replay treats it as a miss, so a plain resume
    // would RE-PEND the consult at that call index with no progress. The user
    // never answered it, so silently skipping past it is wrong: refuse plain
    // resume (no script, or a byte-identical one). Resuming with an EDITED
    // script is the sanctioned path — the edit makes the replay hash-miss and
    // re-raise the consult with the NEW prompt, which the user then answers
    // through resolveConsult. Only the LAST journal entry is consulted: a
    // resolved re-pend shadows its failed predecessor (the replay Map keys by
    // call index and the later write wins).
    const journal = persisted.journal ?? [];
    const lastEntry = journal[journal.length - 1];
    const hasUnsettledConsult =
      lastEntry !== undefined &&
      typeof lastEntry.result === "object" &&
      lastEntry.result !== null &&
      "settled" in lastEntry.result &&
      lastEntry.result.settled === false;
    if (
      hasUnsettledConsult &&
      opts?.skipConsultSettledCheck !== true &&
      (opts?.script === undefined || opts.script === persisted.script)
    ) {
      return false;
    }
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

    // Use the edited script when supplied, else the persisted one (backward-compat).
    const script = opts?.script ?? persisted.script;
    const args = opts?.args !== undefined ? opts.args : persisted.args;

    // Normalize the persisted total-at-pause once: PersistedRunState.tokenUsage
    // has optional cost/cacheRead/cacheWrite (legacy runs may lack them), but
    // both the seeded snapshot and initialTokenUsage need concrete numbers.
    const priorTokenUsage = persisted.tokenUsage
      ? {
          input: persisted.tokenUsage.input,
          output: persisted.tokenUsage.output,
          total: persisted.tokenUsage.total,
          cost: persisted.tokenUsage.cost ?? 0,
          cacheRead: persisted.tokenUsage.cacheRead ?? 0,
          cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
        }
      : undefined;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        // Seed the live snapshot's aggregate from the persisted total-at-pause
        // (see A2) so a pause that lands before this resume's first agent
        // completes doesn't lose the prior spend — onAgentEnd accumulates on
        // top of this rather than starting from scratch.
        tokenUsage: priorTokenUsage,
      },
      controller,
      startedAt: new Date(),
      // The (possibly edited) script + args become the run's own — persistRun()
      // writes them below, so a later resume of this run sees the edited script.
      script,
      args,
      journal: persisted.journal ?? [],
      // The pending consult, when this run was parked on one (resolveConsult
      // flips the status to paused before resuming, so the persisted
      // pendingConsult is what tells the continuation which intervention
      // point it is answering and what outcome was recorded).
      pendingConsult: persisted.pendingConsult,
      background: true,
      lease,
      // Carry the original opt-out forward across resumes; it's fixed at
      // run-start and persistRun() re-persists it on every subsequent write.
      autoResume: persisted.autoResume,
      // Carry the auto-apply counter forward — the chain's increments land on
      // the CURRENT managed and writeRunToDisk persists them, so a resumed
      // execution's next consult trigger re-reads the accumulated total.
      consultAutoApplied: persisted.consultAutoApplied,
      // Restore start-time execution context: the budget the run started with
      // (legacy runs without one resume unbudgeted — never re-apply the current
      // default to a run that predates it) and the toolset tag executeRun
      // re-resolves so e.g. a resumed /deep-research keeps its web tools.
      tokenBudget: persisted.tokenBudget !== undefined ? persisted.tokenBudget : null,
      toolset: persisted.toolset,
      // Restore the same start-time execution context for the other four
      // per-run knobs (see ManagedRun doc comments) — same rationale as
      // tokenBudget: never re-resolve against the manager's CURRENT defaults.
      // maxAgents: legacy/never-set runs resume with no cap carried forward
      // (runWorkflow's own MAX_AGENTS_PER_RUN default applies), exactly as if
      // maxAgents had never been passed at all.
      maxAgents: persisted.maxAgents,
      // agentTimeoutMs: unlike tokenBudget, a legacy run's real timeout at
      // start was never "no timeout" by omission — it was always
      // this.defaultAgentTimeoutMs, because pre-A1 resume() never threaded
      // agentTimeoutMs through at all and unconditionally fell back to the
      // manager default (see executeRun's resolvedAgentTimeoutMs fallback
      // chain). Falling back to null here would change what a legacy run's
      // resume actually does versus both its original start AND pre-fix
      // resume behavior. So — deliberately unlike tokenBudget's null
      // fallback — legacy runs resume with the manager's CURRENT default,
      // matching the only semantics such a run ever had.
      agentTimeoutMs: persisted.agentTimeoutMs !== undefined ? persisted.agentTimeoutMs : this.defaultAgentTimeoutMs,
      // concurrency/agentRetries have no "explicit opt-out sentinel" the way
      // tokenBudget's null does — a legacy run without a persisted value falls
      // back to the manager's current values, matching how this execution
      // resolved unset concurrency/agentRetries before this fix ever existed.
      concurrency: persisted.concurrency !== undefined ? persisted.concurrency : this.concurrency,
      agentRetries: persisted.agentRetries !== undefined ? persisted.agentRetries : this.defaultAgentRetries,
      // Fresh per-resume: agents (and any prior timing) are rebuilt live as
      // onAgentStart/onAgentEnd fire again for this attempt (see `agents: []`
      // above); the journal, not this map, is what makes replayed agents cheap.
      agentTimestamps: new Map(),
      agentsById: new Map(),
    };
    this.runs.set(runId, managed);
    // Persist before notifying renderers: listRuns() is their source of truth for
    // lifecycle status, while getRun() supplies the live in-memory snapshot.
    this.persistRun(managed);

    // Namespace by (runId, index) exactly like the live onAgentJournal dedup
    // above and like SharedStore's deltaKey — see JournalEntry.runId. A
    // legacy entry persisted before namespacing existed has no `runId`; it is
    // assumed to belong to this run's own top-level runId (the only frame
    // that existed before nested workflow() journaling was namespaced), so it
    // still resume-hits for a top-level call and safely cache-misses (re-runs
    // live, does not misapply) for what was actually a nested-run entry.
    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [`${e.runId ?? runId}:${e.index}`, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    // initialTokenUsage seeds the resumed execution's fresh SharedRuntime.spent
    // (A2) from the persisted total-at-pause, so the tokenBudget cap holds
    // cumulatively instead of resetting to zero. Note: shared.agentCount is
    // deliberately NOT seeded the same way — it doesn't need to be. Unlike
    // token spend (whose cache-hit replay branch skips recordTokens() to avoid
    // double-counting already-spent tokens), agent()'s shared.agentCount++
    // fires unconditionally for EVERY call, cache-hit or live, before the
    // replay check runs (see workflow.ts). Because resume() always replays the
    // whole script from callIndex 0, that replay alone reconstructs the
    // correct cumulative count inside this fresh SharedRuntime by the time any
    // new live agent runs — so maxAgents (via A1) is already a genuine
    // cumulative cap across resume with no extra seeding required.
    void this.executeRun(managed, script, args, { resumeJournal, initialTokenUsage: priorTokenUsage }).catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   *
   * Fast path: the run is live in this process (`this.runs`) — abort its
   * controller and persist "aborted" as before. Fallback: the run is not in
   * memory but is persisted as "running", "paused", or "waiting_consult" —
   * e.g. it belongs to a
   * prior pi session that this process's recoverStaleRuns() flipped to
   * "paused" on disk without repopulating this.runs (see workflow-control-tool's
   * findRun(), which resolves candidates from disk via listRuns()). There is no
   * live controller to abort in that case — the run simply isn't executing in
   * this process — so mark it aborted on disk directly, mirroring resume()'s
   * persisted-fallback lease handling.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (
        managed.status !== "running" &&
        managed.status !== "paused" &&
        managed.status !== "waiting_consult"
      ) {
        return false;
      }
      // Whether this run's OWN executeRun() promise has already fully settled
      // matters for whether stop() itself must be the one to call
      // recordTerminalRun(): a usage-limit checkpoint runs executeRun()'s
      // catch tail to completion before "paused" is ever observable (it
      // deliberately skipped recordTerminalRun() then, since "paused" isn't
      // terminal) — so there is no FUTURE tail left that will ever call it
      // for this managed object. The same holds for a waiting_consult run:
      // its status only becomes observable AFTER the tail's catch block has
      // run to completion (persist + lease release), so stop() stopping a
      // waiting_consult run is the only settle that will ever mark it
      // terminal. A manual pause() sets "paused" while its
      // cooperative abort may still be settling; in that narrow window the
      // tail later settles this object to "aborted" (terminal) and records a
      // SECOND time — a tolerated duplicate: recordTerminalRun() is
      // idempotent-safe under duplicates (re-validates the current entry),
      // the lease was already cleared here, and the worst case is the
      // stopped run leaving memory earlier than FIFO order (persistence
      // fallback covers every consumer). A "running" run, by contrast,
      // always still has that tail pending;
      // it (not stop()) is what calls recordTerminalRun() once it actually
      // settles to "aborted" — see the `runs` field doc comment's rule that
      // eviction eligibility must wait for the real settle, not a request to
      // abort. Without this, stopping an already-paused run left it in
      // `runs` forever (no future tail to mark it eviction-eligible) — a
      // small leak in exactly the class this manager otherwise bounds.
      const hadNoPendingSettle = managed.status === "paused" || managed.status === "waiting_consult";
      // 次要 2：pending 消亡即清建议文件（confirm 链保留的 tmp）。
      const revisedPath = (managed.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
      managed.controller.abort();
      managed.status = "aborted";
      // Spec §6: stop/rm explicitly clears the pending consult — an aborted
      // run must not keep its intervention prompt (in memory or on disk;
      // writeRunToDisk persists managed.pendingConsult verbatim, so clear
      // before the persist below).
      managed.pendingConsult = undefined;
      this.emit("stopped", { runId });
      this.persistRun(managed);
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
      this.releaseRunLease(managed);
      if (hadNoPendingSettle) this.recordTerminalRun(runId);
      return true;
    }

    const persisted = this.persistence.load(runId);
    if (
      !persisted ||
      (persisted.status !== "running" && persisted.status !== "paused" && persisted.status !== "waiting_consult")
    ) {
      return false;
    }
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      // Spec §6: stop/rm explicitly clears the pending consult — the spread
      // would otherwise carry a waiting_consult prompt onto the aborted run
      // on disk.
      const revisedPath = (persisted.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
      this.persistence.save({ ...persisted, status: "aborted", pendingConsult: undefined, updatedAt: new Date().toISOString() });
      // 次要 2：pending 消亡即清建议文件。
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
    } finally {
      this.persistence.releaseRunLease(lease);
    }
    this.emit("stopped", { runId });
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   *
   * If `runId` is still live in this process (running or paused-in-memory),
   * abort its controller FIRST, before any teardown below — a live run left
   * un-aborted would otherwise keep executing in the background indefinitely
   * (burning API calls/tokens/holding a worktree) after its record is gone.
   * Aborting first, while `managed` is still `this.runs.get(runId)`, costs
   * nothing extra: the abort signal is fire-and-forget (cooperative — the
   * execution winds down on its own schedule), so the exact instant we flip
   * `this.runs`/release the lease/delete files relative to it doesn't matter
   * for correctness. What DOES matter is that once this method returns, the
   * aborted execution's eventual settle (executeRun's success/catch path,
   * asynchronously, possibly much later) must be a harmless no-op rather than
   * a resurrection — that's what isCurrent() guarantees: `this.runs.delete()`
   * below means executeRun's later persistRun()/releaseRunLease() calls on
   * this same `managed` object find `this.runs.get(runId) !== managed` (in
   * fact `undefined`, since the entry is gone) and skip writing/releasing.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      // 次要 2（对齐扩展）：run 删除即清 pending 引用着的建议文件。
      const revisedPath = (managed.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
      if (!managed.controller.signal.aborted) managed.controller.abort();
      this.releaseRunLease(managed);
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
    } else {
      const persisted = this.persistence.load(runId);
      const revisedPath = (persisted?.pendingConsult as ManagerPendingConsult | undefined)?.revisedPath;
      if (revisedPath !== undefined) rmSync(revisedPath, { force: true });
    }
    this.runs.delete(runId);
    // Cancel any pending throttled write so a deferred persist can't fire after
    // deletion and resurrect the run's file on disk.
    const timer = this.persistTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(runId);
    }
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
