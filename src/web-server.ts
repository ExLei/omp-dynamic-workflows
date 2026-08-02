/**
 * Feasibility spike: a loopback HTTP/SSE surface over the *live* WorkflowManager.
 *
 * Why in-process: the manager's AbortControllers, EventEmitter stream and
 * in-memory `ManagedRun` snapshots never leave the process that executes a run
 * (see src/workflow-manager.ts emitLive/pause, src/extension-reload.ts). A
 * separate server process could only tail `~/.omp/workflows/projects/<key>/runs/*.json`
 * (~400ms throttle, no history/usage ticks) and could not pause a foreign run.
 * Mounting the server inside the omp process gives the web UI exactly the same
 * observability and control the TUI navigator has.
 *
 * Loaded lazily (dynamic import behind an opt-in), so it costs nothing on omp's
 * blocking extension-load path — the same discipline as src/omp-host.ts.
 *
 * SECURITY: starting a run executes arbitrary JS in this process. The server
 * binds loopback only and requires a per-process bearer token.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_WORKFLOWS, resolveWorkflowInvocation } from "./builtin-workflows.js";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import { outlineWorkflowScript } from "./web-outline.js";
import { parseWorkflowScript } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { isSafeSavedWorkflowName, saveLocationOptions, type WorkflowStorage } from "./workflow-saved.js";

/** Manager events mirrored to the browser. Same set the TUI task panel listens on. */
const RUN_EVENTS = [
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

/** Coalesce snapshot pushes per run: agent/history events can burst. */
const SNAPSHOT_COALESCE_MS = 80;
/** Keep intermediaries from closing an idle event stream. */
const HEARTBEAT_MS = 15_000;
/** Cap any single serialized value pushed to the browser. */
const MAX_VALUE_CHARS = 20_000;

export interface WorkflowWebServerOptions {
  manager: WorkflowManager;
  storage: WorkflowStorage;
  cwd: string;
  /** 0 (default) picks an ephemeral port. */
  port?: number;
  hostname?: string;
  /** Reuse a token across restarts; otherwise a fresh one is minted. */
  token?: string;
  /** Built UI root; defaults to the bundled `web/dist`. */
  webRoot?: string;
}

export interface WorkflowWebServer {
  url: string;
  port: number;
  token: string;
  /**
   * True for runs this console started. The extension uses it to keep a
   * browser click from waking the TUI's assistant with an unsolicited turn.
   */
  ownsRun(runId: string): boolean;
  stop(): void;
}

type Client = { id: number; write: (chunk: string) => void; close: () => void };

export function startWorkflowWebServer(options: WorkflowWebServerOptions): WorkflowWebServer {
  const { manager, storage, cwd } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const hostname = options.hostname ?? "127.0.0.1";
  // Resolved on the first non-API request, not at start: when nobody opens the
  // console this never touches the filesystem.
  let webRoot: string | undefined = options.webRoot;
  const assetRoot = (): string => (webRoot ??= resolveWebRoot());

  const clients = new Map<number, Client>();
  let clientSeq = 0;
  /** Runs this console started, for `ownsRun`. */
  const ownedRuns = new Set<string>();
  const pendingSnapshots = new Set<string>();
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const broadcast = (type: string, data: unknown): void => {
    if (clients.size === 0) return;
    const frame = `event: ${type}\ndata: ${safeJson(data)}\n\n`;
    for (const client of clients.values()) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client.id);
      }
    }
  };

  const flushSnapshots = (): void => {
    snapshotTimer = undefined;
    for (const runId of pendingSnapshots) {
      const snapshot = manager.getRun(runId)?.snapshot;
      if (snapshot) broadcast("snapshot", { runId, snapshot: serializeSnapshot(snapshot, false) });
    }
    pendingSnapshots.clear();
    broadcast("runs", { runs: manager.listRuns().map(summarizeRun) });
  };

  const queueSnapshot = (runId: string | undefined): void => {
    if (runId) pendingSnapshots.add(runId);
    snapshotTimer ??= setTimeout(flushSnapshots, SNAPSHOT_COALESCE_MS);
  };

  const listeners = RUN_EVENTS.map((type) => {
    const listener = (payload: unknown): void => {
      const runId = (payload as { runId?: string } | undefined)?.runId;
      broadcast(type, clampEvent(payload));
      queueSnapshot(runId);
    };
    manager.on(type, listener);
    return [type, listener] as const;
  });

  const heartbeat = setInterval(() => broadcast("ping", { t: Date.now() }), HEARTBEAT_MS);
  // The extension owns process lifetime; never hold it open for the UI.
  heartbeat.unref?.();

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (!path.startsWith("/api/")) return staticAsset(assetRoot(), path);
      if (!authorized(request, url, token)) return json({ error: "unauthorized" }, 401);

      try {
        return await route(request, url, path);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });

  async function route(request: Request, url: URL, path: string): Promise<Response> {
    if (path === "/api/events") return eventStream();

    if (path === "/api/state" && request.method === "GET") {
      return json({
        cwd,
        runs: manager.listRuns().map(summarizeRun),
        saved: storage.list().map((w) => ({
          name: w.name,
          description: w.description,
          location: w.location,
          script: w.script,
          parameters: w.parameters ?? null,
          savedAt: w.savedAt,
        })),
        builtins: BUILTIN_WORKFLOWS.map((b) => ({ name: b.name, description: b.description })),
      });
    }

    if (path === "/api/parse" && request.method === "POST") {
      const { script } = (await request.json()) as { script?: string };
      if (typeof script !== "string") return json({ error: "script required" }, 400);
      try {
        const { meta } = parseWorkflowScript(script);
        return json({ ok: true, meta, outline: outlineWorkflowScript(script) });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (path === "/api/runs" && request.method === "POST") {
      const body = (await request.json()) as {
        script?: string;
        name?: string;
        args?: unknown;
        concurrency?: number;
        maxAgents?: number;
        tokenBudget?: number | null;
        agentRetries?: number;
        agentTimeoutMs?: number | null;
      };
      let script = body.script;
      let tools: unknown;
      let toolset: string | undefined;
      if (!script && body.name) {
        const invocation = resolveWorkflowInvocation(body.name, body.args, { storage, cwd });
        if (!invocation) return json({ error: `unknown workflow: ${body.name}` }, 404);
        script = invocation.script;
        tools = invocation.tools;
        toolset = invocation.toolset;
      }
      if (!script) return json({ error: "script or name required" }, 400);
      // Fail fast with the same validation the tool path uses, so the editor
      // reports a script error instead of a run that dies immediately.
      parseWorkflowScript(script);
      const { runId } = manager.startInBackground(script, body.args, {
        tools: tools as never,
        toolset,
        concurrency: body.concurrency,
        maxAgents: body.maxAgents,
        tokenBudget: body.tokenBudget,
        agentRetries: body.agentRetries,
        agentTimeoutMs: body.agentTimeoutMs,
      });
      ownedRuns.add(runId);
      queueSnapshot(runId);
      return json({ runId });
    }

    // Saved-workflow destinations, mirroring the navigator's save picker: which
    // directories are offered and which already hold this name (overwrite).
    if (path === "/api/save-locations" && request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      return json({
        options: saveLocationOptions(cwd),
        existing: isSafeSavedWorkflowName(name) ? storage.locationsOf(name) : [],
      });
    }

    if (path === "/api/saved" && request.method === "POST") {
      const body = (await request.json()) as {
        name?: string;
        description?: string;
        script?: string;
        location?: "project" | "user";
      };
      if (!body.name || !isSafeSavedWorkflowName(body.name)) return json({ error: "invalid name" }, 400);
      if (!body.script?.trim()) return json({ error: "script required" }, 400);
      // Same validation the tool path applies, so a broken script never becomes
      // a slash command that fails at invoke time.
      const { meta } = parseWorkflowScript(body.script);
      const location = body.location ?? "project";
      const saved = storage.save(
        {
          name: body.name,
          description: body.description?.trim() || meta.description,
          script: body.script,
          location,
        },
        location,
      );
      return json({ ok: true, saved: { name: saved.name, path: saved.path, location: saved.location } });
    }

    // Per-agent detail. The SSE snapshot deliberately ships trimmed agents
    // (prompt 400 chars, last 6 history entries) so a 20-agent run does not
    // re-broadcast megabytes on every tick; the drawer that actually displays
    // one agent's transcript pulls the untrimmed record here instead.
    const agentMatch = /^\/api\/runs\/([^/]+)\/agents\/(\d+)$/.exec(path);
    if (agentMatch && request.method === "GET") {
      const runId = decodeURIComponent(agentMatch[1]!);
      const agentId = Number(agentMatch[2]);
      const live = manager.getRun(runId);
      const snapshot = live?.snapshot ?? persistedSnapshot(manager.listAllRuns().find((r) => r.runId === runId));
      const agent = snapshot?.agents.find((entry) => entry.id === agentId);
      if (!agent) return json({ error: "not found" }, 404);
      return json({ runId, live: Boolean(live), agent: serializeAgent(agent, true) });
    }

    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(pause|resume|stop))?$/.exec(path);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      const action = runMatch[2];
      if (!action && request.method === "GET") {
        const live = manager.getRun(runId);
        const persisted = manager.listAllRuns().find((r) => r.runId === runId);
        if (!live && !persisted) return json({ error: "not found" }, 404);
        // The final value lives on ManagedRun.result (workflow-manager.ts:791),
        // never on the progress snapshot — surface it explicitly.
        const snapshot = live ? serializeSnapshot(live.snapshot, true) : persistedSnapshot(persisted);
        const result = live?.result?.result ?? persisted?.result;
        if (snapshot && result !== undefined) snapshot.result = result;
        return json({
          runId,
          status: live?.status ?? persisted?.status,
          script: live?.script ?? persisted?.script,
          args: live?.args ?? persisted?.args ?? null,
          live: Boolean(live),
          error: live?.error ? { message: live.error.message, code: live.error.code } : null,
          durationMs: live?.result?.durationMs ?? persisted?.durationMs ?? null,
          snapshot,
        });
      }
      if (!action && request.method === "DELETE") return json({ ok: manager.deleteRun(runId) });
      if (action && request.method === "POST") {
        if (action === "pause") return json({ ok: manager.pause(runId) });
        if (action === "stop") return json({ ok: manager.stop(runId) });
        if (action === "resume") return json({ ok: await manager.resume(runId) });
      }
    }

    return json({ error: "not found" }, 404);
  }

  function eventStream(): Response {
    const id = ++clientSeq;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        clients.set(id, {
          id,
          write: (chunk) => controller.enqueue(encoder.encode(chunk)),
          close: () => controller.close(),
        });
        controller.enqueue(
          encoder.encode(
            `event: hello\ndata: ${safeJson({ runs: manager.listRuns().map(summarizeRun) })}\n\n`,
          ),
        );
      },
      cancel() {
        clients.delete(id);
        controllerRef = undefined;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  const port = server.port ?? options.port ?? 0;
  return {
    url: `http://${hostname}:${port}/?token=${token}`,
    port,
    token,
    ownsRun: (runId) => ownedRuns.has(runId),
    stop() {
      clearInterval(heartbeat);
      if (snapshotTimer) clearTimeout(snapshotTimer);
      for (const [type, listener] of listeners) manager.off(type, listener);
      for (const client of clients.values()) {
        try {
          client.close();
        } catch {
          // client already gone
        }
      }
      clients.clear();
      server.stop(true);
    },
  };
}

/**
 * Locate the built React bundle. `web/dist` sits beside `src/` in a source
 * checkout and beside `dist/src/` after `tsc -p tsconfig.build.json`, so both
 * layouts are probed before giving up.
 */
function resolveWebRoot(): string {
  const fromEnv = process.env.OMP_WORKFLOW_WEB_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "index.html"))) return fromEnv;
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const candidate of [join(here, "..", "web", "dist"), join(here, "..", "..", "web", "dist")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return "";
}

const NOT_BUILT_HTML = `<!doctype html><meta charset="utf-8"><title>omp workflows</title>
<body style="background:#0d1117;color:#d7dee6;font:14px ui-monospace,monospace;padding:32px">
<h2 style="color:#58a6ff">UI 尚未构建</h2>
<p>在插件目录执行:</p>
<pre style="background:#0b0f14;border:1px solid #2b333d;border-radius:6px;padding:12px">cd web &amp;&amp; bun install &amp;&amp; bun run build</pre>
<p>开发模式:<code>cd web &amp;&amp; bun run dev</code>(Vite 会把 /api 代理到本服务)。</p>
</body>`;

/**
 * Static file serving with SPA fallback. Path traversal is rejected by
 * requiring the resolved target to stay under the asset root.
 */
function staticAsset(webRoot: string, pathname: string): Response {
  if (!webRoot) {
    return new Response(NOT_BUILT_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const target = relative === "" ? join(webRoot, "index.html") : join(webRoot, relative);
  const inRoot = target === webRoot || target.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep);
  // Directories must fall through to the SPA entry, not be handed to Bun.file.
  const servable = inRoot && statSync(target, { throwIfNoEntry: false })?.isFile() === true;
  const file = Bun.file(servable ? target : join(webRoot, "index.html"));
  // Hashed Vite asset names are immutable; index.html must never be cached.
  const immutable = relative.startsWith("assets/");
  return new Response(file, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store" },
  });
}

function authorized(request: Request, url: URL, token: string): boolean {
  const supplied =
    url.searchParams.get("token") ??
    request.headers.get("x-workflow-token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (supplied.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

function json(body: unknown, status = 200): Response {
  return new Response(safeJson(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** JSON with cycle tolerance and a hard size cap on any single string value. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "string" && val.length > MAX_VALUE_CHARS) return `${val.slice(0, MAX_VALUE_CHARS)}…[truncated]`;
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "function") return undefined;
    if (val && typeof val === "object") {
      if (seen.has(val as object)) return "[circular]";
      seen.add(val as object);
      if (val instanceof Map) return Object.fromEntries(val);
      if (val instanceof Set) return [...val];
      if (val instanceof Error) return { name: val.name, message: val.message };
    }
    return val;
  });
}

type RunSummary = ReturnType<typeof summarizeRun>;

function summarizeRun(run: {
  runId: string;
  workflowName: string;
  status: string;
  currentPhase?: string;
  agents?: Array<{ status: string }>;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: { total?: number; cost?: number; cacheRead?: number; input?: number; output?: number };
  pauseReason?: string;
}) {
  const agents = run.agents ?? [];
  return {
    runId: run.runId,
    name: run.workflowName,
    status: run.status,
    currentPhase: run.currentPhase ?? null,
    agentCount: agents.length,
    doneCount: agents.filter((a) => a.status === "done").length,
    errorCount: agents.filter((a) => a.status === "error").length,
    runningCount: agents.filter((a) => a.status === "running").length,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt ?? run.startedAt,
    completedAt: run.completedAt ?? null,
    durationMs: run.durationMs ?? null,
    tokens: run.tokenUsage?.total ?? 0,
    cost: run.tokenUsage?.cost ?? 0,
    pauseReason: run.pauseReason ?? null,
  };
}

/** Strip the heavy fields unless the caller asked for a full detail payload. */
function serializeSnapshot(snapshot: WorkflowSnapshot, full: boolean): WorkflowSnapshot {
  return {
    ...snapshot,
    logs: snapshot.logs.slice(-200),
    result: full ? snapshot.result : undefined,
    agents: snapshot.agents.map((agent) => serializeAgent(agent, full)),
  };
}

function serializeAgent(agent: WorkflowAgentSnapshot, full: boolean): WorkflowAgentSnapshot {
  return {
    ...agent,
    prompt: full ? agent.prompt : agent.prompt.slice(0, 400),
    result: full ? agent.result : undefined,
    history: full ? agent.history : agent.history?.slice(-6),
  };
}

function persistedSnapshot(run: unknown): WorkflowSnapshot | null {
  if (!run || typeof run !== "object") return null;
  const r = run as {
    workflowName?: string;
    phases?: string[];
    currentPhase?: string;
    logs?: string[];
    agents?: WorkflowAgentSnapshot[];
    result?: unknown;
    durationMs?: number;
    tokenUsage?: WorkflowSnapshot["tokenUsage"];
    runId?: string;
  };
  const agents = r.agents ?? [];
  return {
    name: r.workflowName ?? "workflow",
    phases: r.phases ?? [],
    currentPhase: r.currentPhase,
    logs: (r.logs ?? []).slice(-200),
    agents,
    agentCount: agents.length,
    runningCount: agents.filter((a) => a.status === "running").length,
    doneCount: agents.filter((a) => a.status === "done").length,
    errorCount: agents.filter((a) => a.status === "error").length,
    durationMs: r.durationMs,
    result: r.result,
    tokenUsage: r.tokenUsage,
    runId: r.runId,
  };
}

/** Event payloads carry full agent results/prompts; trim before they hit the wire. */
function clampEvent(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (typeof clone.prompt === "string") clone.prompt = clone.prompt.slice(0, 400);
  if (typeof clone.result === "string") clone.result = clone.result.slice(0, 2000);
  return clone;
}

export type { RunSummary };
