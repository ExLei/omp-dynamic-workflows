import type { ParseResult, RunDetail, SaveLocation, SaveLocations, ServerState } from "./types";

/**
 * The server binds loopback and requires a per-process bearer token; omp prints
 * the URL with `?token=…`. Keep it out of the visible query string once read so
 * a screenshot of the UI does not leak it.
 */
function readToken(): string {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) {
    sessionStorage.setItem("wf-token", fromQuery);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
    return fromQuery;
  }
  return sessionStorage.getItem("wf-token") ?? "";
}

export const TOKEN = readToken();

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-workflow-token": TOKEN, ...init?.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

export interface StartRunBody {
  script?: string;
  name?: string;
  args?: unknown;
  concurrency?: number;
  maxAgents?: number;
}

export const api = {
  state: () => call<ServerState>("/api/state"),
  parse: (script: string) => call<ParseResult>("/api/parse", { method: "POST", body: JSON.stringify({ script }) }),
  start: (body: StartRunBody) => call<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  detail: (runId: string) => call<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
  control: (runId: string, action: "pause" | "resume" | "stop") =>
    call<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" }),
  remove: (runId: string) => call<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
  saveLocations: (name: string) =>
    call<SaveLocations>(`/api/save-locations?name=${encodeURIComponent(name)}`),
  save: (body: { name: string; description: string; script: string; location: SaveLocation }) =>
    call<{ ok: boolean; saved: { name: string; path: string; location: SaveLocation } }>("/api/saved", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function eventsUrl(): string {
  return `/api/events?token=${encodeURIComponent(TOKEN)}`;
}
