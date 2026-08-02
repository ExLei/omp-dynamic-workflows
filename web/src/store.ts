import { create } from "zustand";
import { api, eventsUrl } from "./lib/api";
import type {
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
  description: "Web orchestration feasibility probe",
  phases: [{ title: "recon" }, { title: "judge" }],
};

await phase("recon");
const findings = await parallel(
  ["auth", "runtime", "storage"].map((area) => () =>
    agent(\`inspect the \${area} layer and list risks\`, { label: \`scout-\${area}\` }),
  ),
);

await phase("judge");
return await agent(\`rank these risks:\\n\${findings.join("\\n---\\n")}\`, { label: "judge" });
`;

interface WorkflowStore {
  connected: boolean;
  cwd: string;
  runs: RunSummary[];
  saved: SavedWorkflowInfo[];
  builtins: Array<{ name: string; description: string }>;
  snapshots: Record<string, WorkflowSnapshot>;
  selectedRunId: string | null;
  selectedAgentId: number | null;
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
  setScript: (script: string) => void;
  setArgsText: (argsText: string) => void;
  setRunName: (name: string) => void;
  validate: () => Promise<ParseResult | null>;
  start: () => Promise<void>;
  control: (action: "pause" | "resume" | "stop") => Promise<void>;
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

export const useStore = create<WorkflowStore>((set, get) => ({
  connected: false,
  cwd: "",
  runs: [],
  saved: [],
  builtins: [],
  snapshots: {},
  selectedRunId: null,
  selectedAgentId: null,
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
    set({ selectedRunId: runId, selectedAgentId: null });
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
      set({ notice: { kind: "error", text: "args 不是合法 JSON" } });
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

  async control(action) {
    const runId = get().selectedRunId;
    if (!runId) return;
    try {
      const { ok } = await api.control(runId, action);
      set({ notice: { kind: ok ? "info" : "error", text: `${action}: ${ok ? "ok" : "拒绝(状态不允许)"}` } });
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
      set({ script: "", runName: name, notice: { kind: "info", text: `按名称解析:${name}` } });
    }
  },
}));
