/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_AGENT_RETRIES, MAX_CONCURRENCY, normalizeKeywordTriggerWord } from "./config.js";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowSettings {
  keywordTriggerEnabled?: boolean;
  /** Literal keyword that arms workflows mode from interactive input. */
  keywordTriggerWord?: string;
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard token budget applied to runs that don't pass their own
   * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
   * project override to cancel a global budget); omitted also means no budget.
   */
  defaultTokenBudget?: number | null;
  /** Default max concurrent agents per run. Clamped to the runtime maximum. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Bottom task-panel display mode: "compact" (default, one line per run) | "detailed". */
  progressPanelMode?: "compact" | "detailed";
  /** Max agents shown per phase in detailed progress mode (default 8). */
  progressPanelMaxAgents?: number;
  /**
   * Persist each workflow subagent transcript as a real pi session file under
   * the standard sessions directory (~/.omp/agent/sessions/<encoded-cwd>/),
   * keyed by the project cwd. Default false: subagent sessions stay in-memory
   * and only the compacted history embedded in the run JSON survives.
   */
  persistAgentSessions?: boolean;
  /**
   * Character cap on a delivered background-run result's JSON-dump fallback
   * before truncation (default 400). String results and `verdict`/`report`/
   * `summary`/`synthesis` fields are never truncated.
   */
  deliveredResultMaxChars?: number;
  /**
   * Extra tool names to deny in workflow subagent sessions, on top of the
   * always-on `workflow`/`workflow_control` defaults (#107). Use it to block
   * other recursive-orchestration tools you have installed (e.g. a pi-subagents
   * tool) so a subagent can't fan out through them.
   */
  excludeSubagentTools?: string[];
  /** 子代理会话全量同步主代理扩展工具/技能（默认 true）。 */
  syncHostTools?: boolean;
  /** MCP 白名单：只在这些服务器的工具进子代理；空数组 = 不启用 MCP。 */
  mcpServers?: string[];
  /** 子代理会话启用 IRC 通信（默认 false）。 */
  enableIrc?: boolean;
  /**
   * 同步/后台执行兜底开关（规格决策记录第 2 节预留项，V1 实测触发）：
   * "always" 强制同步执行（进度帧流式显示，ACP 会话可实时看到进展）、
   * "never" 强制后台（立即返回、结果后投递）、缺省 "auto" 维持现状判定
   * （isAcpOrHeadlessSession —— 见 workflow-tool.ts backgroundDefault）。
   * ACP 会话实测 ctx.hasUI===true，auto 判定在 ACP 下不触发同步，因此
   * ACP 需要显式 "always" 才能强制同步。
   */
  syncMode?: "auto" | "always" | "never";
  /**
   * Local web console (see src/web-server.ts). On by default: the marginal
   * startup cost is ~3ms (module eval + loopback bind), which is inside the
   * noise of omp's own launch, and the server shares the live WorkflowManager
   * so the browser and the TUI navigator show the same runs.
   *
   * It still executes arbitrary workflow JS on request, so it binds loopback
   * only and mints a per-process token. Set `enabled: false` to turn it off.
   */
  web?: {
    enabled?: boolean;
    /** Fixed port; omitted picks an ephemeral one. */
    port?: number;
    /** Print the console URL on session start (default true). */
    announce?: boolean;
    /**
     * Open the console in the default browser when the session starts.
     * Default false: auto-launching a browser on every `omp` in every repo is
     * hostile, and it is plain wrong over SSH. `/workflows web` opens it on
     * demand instead.
     */
    open?: boolean;
  };
}

export interface WorkflowSettingsStore {
  load(): WorkflowSettings;
  save(settings: WorkflowSettings): void;
}

export interface WorkflowSettingsOptions {
  /** Explicit settings path, primarily for tests and migrations. */
  settingsPath?: string;
  /** Project cwd whose project-level settings should override global settings. */
  cwd?: string;
  /** Explicit project settings path, primarily for tests. */
  projectSettingsPath?: string;
  /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
  scope?: "global" | "project";
}

/** Resolved launch decision for the web console. */
export interface WebConsoleConfig {
  enabled: boolean;
  /** 0 asks the OS for an ephemeral port. */
  port: number;
  announce: boolean;
  /** Launch the default browser once the console is up. */
  open: boolean;
}

/**
 * Decide whether (and where) to start the web console.
 *
 * Precedence: `OMP_WORKFLOW_WEB` wins over settings, because it is what a user
 * reaches for to flip the behaviour of one launch. `0`/`false`/`off` disable;
 * an integer above 1 pins that port; anything else (`1`, `true`, empty) just
 * enables with an ephemeral port. Absent the variable, the console is on unless
 * `web.enabled` is explicitly false — see the cost note on WorkflowSettings.web.
 */
export function resolveWebConsoleConfig(
  settings: WorkflowSettings,
  env: Record<string, string | undefined> = process.env,
): WebConsoleConfig {
  const web = settings.web ?? {};
  const announce = web.announce !== false;
  const open = web.open === true;
  const override = env.OMP_WORKFLOW_WEB;
  if (override === undefined) {
    return { enabled: web.enabled !== false, port: web.port ?? 0, announce, open };
  }
  const flag = override.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return { enabled: false, port: 0, announce, open };
  const pinned = Number(flag);
  const port = Number.isInteger(pinned) && pinned > 1 && pinned <= 65_535 ? pinned : (web.port ?? 0);
  return { enabled: true, port, announce, open };
}

/** Path to the user-level workflow settings JSON file (~/.omp/workflows/settings.json). */
export function getWorkflowSettingsPath(): string {
  return join(workflowHomeDir(), "settings.json");
}

/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd: string): string {
  return workflowProjectPaths(cwd).settingsPath;
}

/** Load settings from disk. Missing, corrupt, or invalid files resolve to {}. */
export function loadWorkflowSettings(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettings {
  const options = normalizeOptions(settingsPathOrOptions);
  const globalSettings = readSettings(options.settingsPath ?? getWorkflowSettingsPath());
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  if (!projectPath) return globalSettings;
  return { ...globalSettings, ...readSettings(projectPath) };
}

/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(
  settings: WorkflowSettings,
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): void {
  const options = normalizeOptions(settingsPathOrOptions);
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  const path =
    options.scope === "project" && projectPath ? projectPath : (options.settingsPath ?? getWorkflowSettingsPath());
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readObject(path);
  writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
}

/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(settings: WorkflowSettings, cwd: string): void {
  saveWorkflowSettings(settings);
  const projectPath = getWorkflowProjectSettingsPath(cwd);
  if (existsSync(projectPath)) {
    saveWorkflowSettings(settings, { projectSettingsPath: projectPath, scope: "project" });
  }
}

function normalizeOptions(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettingsOptions {
  return typeof settingsPathOrOptions === "string"
    ? { settingsPath: settingsPathOrOptions }
    : (settingsPathOrOptions ?? {});
}

function readSettings(path: string): WorkflowSettings {
  if (!existsSync(path)) return {};
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

export function normalizeSettings(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: WorkflowSettings = {};
  if (typeof raw.keywordTriggerEnabled === "boolean") {
    settings.keywordTriggerEnabled = raw.keywordTriggerEnabled;
  }
  const keywordTriggerWord = normalizeKeywordTriggerWord(raw.keywordTriggerWord);
  if (keywordTriggerWord !== undefined) settings.keywordTriggerWord = keywordTriggerWord;
  if (raw.defaultAgentTimeoutMs === null) {
    settings.defaultAgentTimeoutMs = null;
  } else if (
    typeof raw.defaultAgentTimeoutMs === "number" &&
    Number.isFinite(raw.defaultAgentTimeoutMs) &&
    raw.defaultAgentTimeoutMs > 0
  ) {
    settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
  }
  if (raw.defaultTokenBudget === null) {
    settings.defaultTokenBudget = null;
  } else {
    const defaultTokenBudget = normalizeInteger(raw.defaultTokenBudget, 1, Number.MAX_SAFE_INTEGER);
    if (defaultTokenBudget !== undefined) settings.defaultTokenBudget = defaultTokenBudget;
  }
  const defaultConcurrency = normalizeInteger(raw.defaultConcurrency, 1, MAX_CONCURRENCY);
  if (defaultConcurrency !== undefined) settings.defaultConcurrency = defaultConcurrency;
  const defaultAgentRetries = normalizeInteger(raw.defaultAgentRetries, 0, MAX_AGENT_RETRIES);
  if (defaultAgentRetries !== undefined) settings.defaultAgentRetries = defaultAgentRetries;
  if (raw.progressPanelMode === "compact" || raw.progressPanelMode === "detailed") {
    settings.progressPanelMode = raw.progressPanelMode;
  }
  if (
    typeof raw.progressPanelMaxAgents === "number" &&
    Number.isFinite(raw.progressPanelMaxAgents) &&
    raw.progressPanelMaxAgents >= 1
  ) {
    settings.progressPanelMaxAgents = Math.min(1000, Math.floor(raw.progressPanelMaxAgents));
  }
  if (typeof raw.persistAgentSessions === "boolean") {
    settings.persistAgentSessions = raw.persistAgentSessions;
  }
  const deliveredResultMaxChars = normalizeInteger(raw.deliveredResultMaxChars, 1, 1_000_000);
  if (deliveredResultMaxChars !== undefined) settings.deliveredResultMaxChars = deliveredResultMaxChars;
  if (Array.isArray(raw.excludeSubagentTools)) {
    const names = raw.excludeSubagentTools.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (names.length) settings.excludeSubagentTools = names;
  }
  // 三字段遵循文件既有「缺省即省略」不变量：仅在显式出现且类型合法时输出键，
  // 未设置/非法值不物化缺省——否则 { ...global, ...project } merge 会用项目文件
  // 的缺省键静默覆盖全局显式设置，saveWorkflowSettings 也会写入用户从未设置的键。
  // 缺省语义由消费端 ?? 兜底（syncHostTools ?? true / mcpServers ?? [] / enableIrc ?? false）。
  if (typeof raw.syncHostTools === "boolean") {
    settings.syncHostTools = raw.syncHostTools;
  }
  if (Array.isArray(raw.mcpServers)) {
    const names = raw.mcpServers
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (names.length) settings.mcpServers = names;
  }
  if (typeof raw.enableIrc === "boolean") {
    settings.enableIrc = raw.enableIrc;
  }
  // syncMode 同走「缺省即省略」不变量：仅显式合法值输出键，非法值/未设置不物化
  // 缺省（auto）——否则 merge 与 save 会写入用户从未设置的键。auto 语义由消费端
  // （workflow-tool.ts backgroundDefault）?? 兜底。
  if (raw.syncMode === "auto" || raw.syncMode === "always" || raw.syncMode === "never") {
    settings.syncMode = raw.syncMode;
  }
  const web = normalizeWebSettings(raw.web);
  if (web) settings.web = web;
  return settings;
}

function normalizeWebSettings(value: unknown): WorkflowSettings["web"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const web: NonNullable<WorkflowSettings["web"]> = {};
  if (typeof raw.enabled === "boolean") web.enabled = raw.enabled;
  if (typeof raw.announce === "boolean") web.announce = raw.announce;
  if (typeof raw.open === "boolean") web.open = raw.open;
  const port = normalizeInteger(raw.port, 1, 65_535);
  if (port !== undefined) web.port = port;
  return Object.keys(web).length > 0 ? web : undefined;
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  return Math.min(max, Math.floor(value));
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
