import { create } from "zustand";
import { api, eventsUrl } from "./lib/api";
import type {
  AgentSnapshot,
  FeedEntry,
  ParseResult,
  RunDetail,
  RunSummary,
  SaveLocation,
  SaveLocationOption,
  SavedWorkflowInfo,
  WorkflowSnapshot,
} from "./lib/types";

/** Save picker state; mirrors the navigator's project/personal destination prompt. */
interface SaveDialogState {
  name: string;
  description: string;
  location: SaveLocation;
  options: SaveLocationOption[];
  existing: SaveLocation[];
}

const FEED_LIMIT = 200;

const FEED_EVENTS = [
  "agentStart",
  "agentEnd",
  "agentHistory",
  "agentUsage",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
] as const;

const SAMPLE_SCRIPT = `export const meta = {
  name: "web_probe",
  description: "Web 编排可行性探针",
  phases: [{ title: "侦察" }, { title: "裁决" }],
};

await phase("侦察");
const findings = await parallel(
  ["auth", "runtime", "storage"].map((area) => () =>
    agent(\`检查 \${area} 层并列出风险\`, { label: \`scout-\${area}\` }),
  ),
);

await phase("裁决");
return await agent(\`对这些风险排序:\\n\${findings.join("\\n---\\n")}\`, { label: "judge" });
`;

interface WorkflowStore {
  connected: boolean;
  cwd: string;
  runs: RunSummary[];
  saved: SavedWorkflowInfo[];
  builtins: Array<{ name: string; description: string; script: string }>;
  snapshots: Record<string, WorkflowSnapshot>;
  selectedRunId: string | null;
  selectedAgentId: number | null;
  /** Untrimmed record for the agent the drawer shows; see /api/runs/:id/agents/:id. */
  agentDetail: { runId: string; agentId: number; agent: AgentSnapshot } | null;
  agentDetailLoading: boolean;
  /** Editor jump target set by clicking a static-outline node. */
  focusLine: number | null;
  feed: FeedEntry[];
  script: string;
  argsText: string;
  runName: string;
  parse: ParseResult | null;
  notice: { kind: "info" | "error"; text: string } | null;
  /** Terminal outcome per run: the value `runWorkflow` returned, plus its error. */
  results: Record<string, { value: unknown; error: { message: string; code?: string } | null; durationMs: number | null }>;
  saveDialog: SaveDialogState | null;

  connect: () => () => void;
  refresh: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  loadDetail: (runId: string) => Promise<RunDetail | null>;
  selectAgent: (agentId: number | null) => void;
  loadAgentDetail: () => Promise<void>;
  focusOutline: (line: number) => void;
  setScript: (script: string) => void;
  setArgsText: (argsText: string) => void;
  setRunName: (name: string) => void;
  validate: () => Promise<ParseResult | null>;
  start: () => Promise<void>;
  control: (action: "pause" | "resume" | "stop" | "intervene", runId?: string) => Promise<void>;
  /** 回复并继续: send the editor's script to the parked run (resolveConsult). */
  reply: (script: string) => Promise<void>;
  remove: () => Promise<void>;
  openSaveDialog: () => Promise<void>;
  closeSaveDialog: () => void;
  patchSaveDialog: (patch: Partial<SaveDialogState>) => Promise<void>;
  commitSave: () => Promise<void>;
  loadSaved: (name: string) => void;
}

let feedSeq = 0;

function pushFeed(feed: FeedEntry[], type: string, payload: Record<string, unknown>): FeedEntry[] {
  const text = String(
    payload.label ?? payload.title ?? payload.message ?? payload.reason ?? payload.runId ?? "",
  ).slice(0, 160);
  const entry: FeedEntry = {
    id: ++feedSeq,
    at: Date.now(),
    type,
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    text,
  };
  return [entry, ...feed].slice(0, FEED_LIMIT);
}

/**
 * The focused agent is refetched on its own events rather than riding the
 * snapshot: history bursts (one entry per tool call) would otherwise force a
 * full-run refetch per token.
 */
let detailTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAgentDetail(load: () => void): void {
  if (detailTimer) return;
  detailTimer = setTimeout(() => {
    detailTimer = undefined;
    load();
  }, 250);
}

export const useStore = create<WorkflowStore>((set, get) => ({
  connected: false,
  cwd: "",
  runs: [],
  saved: [],
  builtins: [],
  snapshots: {},
  selectedRunId: null,
  selectedAgentId: null,
  agentDetail: null,
  agentDetailLoading: false,
  focusLine: null,
  feed: [],
  script: SAMPLE_SCRIPT,
  argsText: "{}",
  runName: "",
  parse: null,
  notice: null,
  results: {},
  saveDialog: null,

  connect() {
    const source = new EventSource(eventsUrl());
    source.onopen = () => set({ connected: true });
    source.onerror = () => set({ connected: false });
    source.addEventListener("hello", (event) => {
      set({ connected: true, runs: JSON.parse((event as MessageEvent).data).runs });
    });
    source.addEventListener("runs", (event) => {
      set({ runs: JSON.parse((event as MessageEvent).data).runs });
    });
    source.addEventListener("snapshot", (event) => {
      const { runId, snapshot } = JSON.parse((event as MessageEvent).data) as {
        runId: string;
        snapshot: WorkflowSnapshot;
      };
      set((state) => ({ snapshots: { ...state.snapshots, [runId]: snapshot } }));
    });
    // A terminal run's return value never rides the progress snapshot (it lives
    // on ManagedRun.result), so refetch the detail once the run settles.
    for (const type of ["complete", "error", "stopped"] as const) {
      source.addEventListener(type, (event) => {
        const { runId } = JSON.parse((event as MessageEvent).data) as { runId?: string };
        if (runId) void get().loadDetail(runId);
      });
    }
    // Keep the open drawer live. Its own events are the trigger; a run-wide
    // refetch on every history burst would be wasteful.
    for (const type of ["agentHistory", "agentUsage", "agentEnd", "complete", "error", "stopped"] as const) {
      source.addEventListener(type, (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { runId?: string; agentId?: number };
        const { selectedRunId, selectedAgentId } = get();
        if (selectedAgentId === null || payload.runId !== selectedRunId) return;
        if (typeof payload.agentId === "number" && payload.agentId !== selectedAgentId) return;
        scheduleAgentDetail(() => void get().loadAgentDetail());
      });
    }
    for (const type of FEED_EVENTS) {
      source.addEventListener(type, (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as Record<string, unknown>;
        set((state) => ({ feed: pushFeed(state.feed, type, payload) }));
      });
    }
    return () => source.close();
  },

  async refresh() {
    const state = await api.state();
    set({ cwd: state.cwd, runs: state.runs, saved: state.saved, builtins: state.builtins });
  },

  async selectRun(runId) {
    set({ selectedRunId: runId, selectedAgentId: null, agentDetail: null });
    const detail = await get().loadDetail(runId);
    if (detail?.script) set({ script: detail.script });
  },

  async loadDetail(runId) {
    try {
      const detail = await api.detail(runId);
      set((state) => ({
        snapshots: detail.snapshot ? { ...state.snapshots, [runId]: detail.snapshot } : state.snapshots,
        results: {
          ...state.results,
          [runId]: { value: detail.snapshot?.result, error: detail.error, durationMs: detail.durationMs },
        },
      }));
      return detail;
    } catch {
      return null;
    }
  },

  selectAgent(agentId) {
    set({ selectedAgentId: agentId });
    if (agentId === null) set({ agentDetail: null });
    else void get().loadAgentDetail();
  },

  async loadAgentDetail() {
    const { selectedRunId, selectedAgentId, agentDetail } = get();
    if (!selectedRunId || selectedAgentId === null) return;
    // Only show the spinner on a cold open; a live refresh must not blank the pane.
    const cold = agentDetail?.runId !== selectedRunId || agentDetail.agentId !== selectedAgentId;
    if (cold) set({ agentDetailLoading: true, agentDetail: null });
    try {
      const detail = await api.agentDetail(selectedRunId, selectedAgentId);
      const current = get();
      // A slow response for an agent the user already left must not overwrite.
      if (current.selectedRunId !== selectedRunId || current.selectedAgentId !== selectedAgentId) return;
      set({ agentDetail: { runId: selectedRunId, agentId: selectedAgentId, agent: detail.agent } });
    } catch {
      // Persisted runs pruned from disk simply have no detail; the drawer falls
      // back to the snapshot copy.
    } finally {
      if (cold) set({ agentDetailLoading: false });
    }
  },

  focusOutline(line) {
    set({ focusLine: line });
  },

  setScript(script) {
    set({ script });
  },
  setArgsText(argsText) {
    set({ argsText });
  },
  setRunName(runName) {
    set({ runName });
  },

  async validate() {
    const { script } = get();
    if (!script.trim()) {
      set({ parse: null });
      return null;
    }
    try {
      const parse = await api.parse(script);
      set({ parse });
      return parse;
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
      return null;
    }
  },

  async start() {
    const { script, argsText, runName } = get();
    let args: unknown;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : undefined;
    } catch {
      set({ notice: { kind: "error", text: "参数不是合法 JSON" } });
      return;
    }
    try {
      const body = script.trim() ? { script, args } : { name: runName.trim(), args };
      const { runId } = await api.start(body);
      set({ notice: { kind: "info", text: `已启动 ${runId}` } });
      await get().selectRun(runId);
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },

  async control(action, runId = get().selectedRunId ?? undefined) {
    if (!runId) return;
    try {
      const { ok } = await api.control(runId, action);
      const label = { pause: "暂停", resume: "恢复", stop: "停止", intervene: "介入" }[action] ?? action;
      set({ notice: { kind: ok ? "info" : "error", text: `${label}: ${ok ? "成功" : "拒绝(状态不允许)"}` } });
      // After a successful intervene the run is parked on waiting_consult —
      // reload it so the editor picks up its script (revisedScript ?? script)
      // as the reply baseline, and refresh the run list so the row's status
      // stops showing a stale "运行中" (the consult-pending → runs SSE
      // broadcast normally covers this; refresh() is the double insurance).
      if (ok && action === "intervene") {
        await get().selectRun(runId);
        await get().refresh();
      }
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },

  async reply(script) {
    const runId = get().selectedRunId;
    if (!runId) return;
    try {
      const { ok } = await api.reply(runId, script);
      set({ notice: { kind: ok ? "info" : "error", text: ok ? "回复并继续：成功" : "回复并继续：拒绝(状态不允许)" } });
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },

  async remove() {
    const runId = get().selectedRunId;
    if (!runId) return;
    await api.remove(runId);
    set({ selectedRunId: null, selectedAgentId: null });
    await get().refresh();
  },

  async openSaveDialog() {
    const { script, runName, parse } = get();
    if (!script.trim()) return set({ notice: { kind: "error", text: "编辑器为空,没有可保存的脚本" } });
    const name = (runName.trim() || parse?.meta?.name || "").replace(/[^\w.-]+/g, "-");
    try {
      const { options, existing } = await api.saveLocations(name);
      set({
        saveDialog: {
          name,
          description: parse?.meta?.description ?? "",
          location: options[0]?.location ?? "project",
          options,
          existing,
        },
      });
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },

  closeSaveDialog() {
    set({ saveDialog: null });
  },

  async patchSaveDialog(patch) {
    const current = get().saveDialog;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ saveDialog: next });
    // The overwrite badge tracks the name as it is typed.
    if (patch.name !== undefined) {
      try {
        const { existing } = await api.saveLocations(next.name);
        const latest = get().saveDialog;
        if (latest && latest.name === next.name) set({ saveDialog: { ...latest, existing } });
      } catch {
        // Leave the previous badge state; the save itself still validates.
      }
    }
  },

  async commitSave() {
    const dialog = get().saveDialog;
    if (!dialog) return;
    try {
      const result = await api.save({
        name: dialog.name.trim(),
        description: dialog.description,
        script: get().script,
        location: dialog.location,
      });
      set({ saveDialog: null, runName: result.saved.name, notice: { kind: "info", text: `已保存 ${result.saved.path}` } });
      await get().refresh();
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },

  loadSaved(name) {
    const saved = get().saved.find((entry) => entry.name === name);
    if (saved) {
      set({ script: saved.script, runName: saved.name });
      void get().validate();
    } else {
      const builtin = get().builtins.find((entry) => entry.name === name);
      if (builtin) {
        set({
          script: builtin.script,
          runName: builtin.name,
          notice: { kind: "info", text: `内置模式预览：参数在运行时注入，实际调用请用斜杠命令或 workflow 工具的 name 入参` },
        });
        void get().validate();
      } else {
        set({ script: "", runName: name, notice: { kind: "info", text: `按名称解析:${name}` } });
      }
    }
  },
}));
