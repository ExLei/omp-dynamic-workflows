/** Mirrors the payloads emitted by src/web-server.ts. */

export type AgentStatus = "queued" | "running" | "done" | "error" | "skipped";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AgentHistoryEntry {
  role: "user" | "assistant" | "tool";
  kind: "text" | "toolCall" | "toolResult" | "error";
  text: string;
  toolName?: string;
  path?: string;
  isError?: boolean;
}

export interface AgentSnapshot {
  id: number;
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: AgentStatus;
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: string;
  history?: AgentHistoryEntry[];
  tokens?: number;
  tokenUsage?: TokenUsage;
  model?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: AgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: TokenUsage;
  runId?: string;
}

export interface RunSummary {
  runId: string;
  name: string;
  status: RunStatus;
  currentPhase: string | null;
  agentCount: number;
  doneCount: number;
  errorCount: number;
  runningCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  tokens: number;
  cost: number;
  pauseReason: string | null;
}

export interface SavedWorkflowInfo {
  name: string;
  description: string;
  location: "project" | "user";
  script: string;
  parameters: Record<string, unknown> | null;
  savedAt: string;
}

export interface ServerState {
  cwd: string;
  runs: RunSummary[];
  saved: SavedWorkflowInfo[];
  builtins: Array<{ name: string; description: string }>;
}

export interface OutlineNode {
  kind: string;
  name?: string;
  detail?: string;
  line: number;
  dynamic: boolean;
  children: OutlineNode[];
}

export interface WorkflowOutline {
  nodes: OutlineNode[];
  phases: string[];
  agentCallSites: number;
  hasDynamicFanout: boolean;
  error?: string;
}

export interface ParseResult {
  ok: boolean;
  meta?: { name: string; description: string; phases?: Array<{ title: string; detail?: string; model?: string }> };
  outline?: WorkflowOutline;
  error?: string;
}

export type SaveLocation = "project" | "user";

export interface SaveLocationOption {
  location: SaveLocation;
  /** "Project" / "Personal", matching the TUI navigator's picker. */
  label: string;
  /** Absolute directory the workflow lands in. */
  dir: string;
  /** Short form: `.omp/workflows/saved` / `~/.omp/workflows/saved`. */
  display: string;
}

export interface SaveLocations {
  options: SaveLocationOption[];
  /** Destinations that already hold this name — saving there overwrites. */
  existing: SaveLocation[];
}

export interface RunDetail {
  runId: string;
  status: RunStatus;
  script: string;
  args: unknown;
  live: boolean;
  error: { message: string; code?: string } | null;
  durationMs: number | null;
  snapshot: WorkflowSnapshot | null;
}

/** One line in the live event feed. */
export interface FeedEntry {
  id: number;
  at: number;
  type: string;
  runId?: string;
  text: string;
}
