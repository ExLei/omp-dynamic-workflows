import packageJson from "../package.json" with { type: "json" };
import type { EffortState } from "./effort-command.js";
import type { WorkflowManager } from "./workflow-manager.js";

/**
 * Live extension state that OMP may hand from one extension generation to the
 * next during `/reload`. This deliberately stays process-local: run snapshots
 * and journals already provide the durable cold-start path, while the live
 * manager is what owns in-flight promises, abort controllers, and event streams.
 */
export const WORKFLOW_EXTENSION_VERSION = packageJson.version;

export interface WorkflowReloadRuntime {
  cwd: string;
  /** Package version that created this manager. Only an exact match is retained. */
  extensionVersion: string;
  manager: WorkflowManager;
  effort: EffortState;
}

export interface WorkflowRuntimeClaim {
  compatible?: WorkflowReloadRuntime;
  versionMismatch?: WorkflowReloadRuntime;
}

interface HandoffEntry {
  runtime: WorkflowReloadRuntime;
  timer: ReturnType<typeof setTimeout>;
}

// Derived from the package name so a differently-named build of this plugin
// (e.g. the upstream pi-dynamic-workflows) loaded in the same process gets its
// own handoff table instead of contending for ours on a shared global key.
const RELOAD_HANDOFF_KEY = Symbol.for(`${packageJson.name}:reload-handoffs`);
const RELOAD_HANDOFF_TTL_MS = 30_000;

function handoffs(): Map<string, HandoffEntry> {
  const root = globalThis as typeof globalThis & { [RELOAD_HANDOFF_KEY]?: Map<string, HandoffEntry> };
  const existing = root[RELOAD_HANDOFF_KEY];
  if (existing) return existing;
  const created = new Map<string, HandoffEntry>();
  root[RELOAD_HANDOFF_KEY] = created;
  return created;
}

/**
 * Stage a live runtime immediately before Pi tears down the old extension runner.
 *
 * `ttlMs` is only ever overridden by tests; production callers rely on the
 * default so a slow/failed reload doesn't strand a staged runtime forever.
 */
export function handoffWorkflowRuntime(runtime: WorkflowReloadRuntime, ttlMs: number = RELOAD_HANDOFF_TTL_MS): void {
  const store = handoffs();
  const previous = store.get(runtime.cwd);
  if (previous) clearTimeout(previous.timer);

  const entry = {} as HandoffEntry;
  entry.runtime = runtime;
  entry.timer = setTimeout(() => {
    if (store.get(runtime.cwd) !== entry) return;
    // No new extension generation ever claimed this runtime. Anything still
    // "running" in it would otherwise burn tokens to completion and deliver
    // its result into a manager nobody can reach anymore, so pause it onto
    // the same journal-recovery path a version-mismatch reload uses.
    pauseStrandedWorkflowRuntime(runtime);
    store.delete(runtime.cwd);
  }, ttlMs);
  entry.timer.unref?.();
  store.set(runtime.cwd, entry);
}

/** Claim a staged runtime from the extension generation that `/reload` just stopped. */
export function takeWorkflowRuntime(cwd: string): WorkflowReloadRuntime | undefined {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  store.delete(cwd);
  return entry.runtime;
}

/**
 * Claim a staged runtime and compare its package version with this extension
 * generation. Any package update falls back to a fresh manager; only reloads
 * within the exact same installed version retain live workflow state.
 */
export function claimWorkflowRuntime(cwd: string): WorkflowRuntimeClaim {
  const runtime = takeWorkflowRuntime(cwd);
  if (!runtime) return {};
  return runtime.extensionVersion === WORKFLOW_EXTENSION_VERSION
    ? { compatible: runtime }
    : { versionMismatch: runtime };
}

/**
 * Move a runtime's live runs onto the existing journal recovery path when no
 * compatible manager will carry them forward — a replaced extension version,
 * or a staged handoff that expired unclaimed.
 */
export function pauseStrandedWorkflowRuntime(runtime: WorkflowReloadRuntime): number {
  let paused = 0;
  for (const run of runtime.manager.listRuns()) {
    if (run.status === "running" && runtime.manager.pause(run.runId)) paused++;
  }
  return paused;
}

/** Test/cleanup helper; identity guard avoids deleting a newer handoff. */
export function discardWorkflowRuntime(cwd: string, runtime?: WorkflowReloadRuntime): void {
  const store = handoffs();
  const entry = store.get(cwd);
  if (!entry || (runtime && entry.runtime !== runtime)) return;
  clearTimeout(entry.timer);
  store.delete(cwd);
}
