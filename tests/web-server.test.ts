import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { outlineWorkflowScript } from "../src/web-outline.js";
import { startWorkflowWebServer, type WorkflowWebServer } from "../src/web-server.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";

const TOKEN = "test-token";
const auth = { "content-type": "application/json", "x-workflow-token": TOKEN };

const SCRIPT = `export const meta = { name: "web_test", description: "probe", phases: [{ title: "recon" }] };
await phase("recon");
const out = await parallel(["a", "b"].map((k) => () => agent("scan " + k, { label: "w-" + k })));
return out.join(",");`;

/** Boot a manager + server on an ephemeral port in a throwaway cwd. */
async function withServer(
  run: (server: WorkflowWebServer, manager: WorkflowManager, cwd: string) => Promise<void>,
  agent: { run(prompt: string, options?: AgentRunOptions<never>): Promise<string> } = {
    async run(prompt) {
      return `done:${prompt}`;
    },
  },
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "omp-web-"));
  const manager = new WorkflowManager({ cwd, agent: agent as never });
  const server = startWorkflowWebServer({
    manager,
    storage: createWorkflowStorage(cwd),
    cwd,
    port: 0,
    token: TOKEN,
  });
  try {
    await run(server, manager, cwd);
  } finally {
    server.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow static outline", () => {
  test("separates statically known structure from runtime-decided fan-out", () => {
    const outline = outlineWorkflowScript(SCRIPT);
    expect(outline.error).toBeUndefined();
    expect(outline.phases).toEqual(["recon"]);
    // One literal `agent(...)` call site, even though it fans out to two agents:
    // the analyzer must not pretend to know the width.
    expect(outline.agentCallSites).toBe(1);
    expect(outline.hasDynamicFanout).toBe(true);
    // `phase()` is a marker at runtime, so the statements it governs hang off it.
    expect(outline.nodes.map((node) => node.kind)).toEqual(["phase"]);
    expect(outline.nodes[0]?.children.map((node) => node.kind)).toEqual(["parallel"]);
    expect(outline.nodes[0]?.children[0]?.flow).toBe("parallel");
    expect(outline.nodes[0]?.children[0]?.children.map((node) => node.kind)).toEqual(["agent"]);
  });

  test("a straight-line script reports no dynamic fan-out", () => {
    const outline = outlineWorkflowScript(
      `export const meta = { name: "s", description: "d" };\nawait phase("one");\nawait agent("go", { label: "solo" });`,
    );
    expect(outline.hasDynamicFanout).toBe(false);
    expect(outline.nodes.map((node) => node.name)).toEqual(["one"]);
    expect(outline.nodes[0]?.children.map((node) => node.name)).toEqual(["solo"]);
  });

  test("siblings keep execution order and each phase owns the calls that follow it", () => {
    const outline = outlineWorkflowScript(
      [
        `export const meta = { name: "s", description: "d" };`,
        `await phase("a");`,
        `await agent("first", { label: "one" });`,
        `await agent("second", { label: "two" });`,
        `await phase("b");`,
        `await agent("third", { label: "three" });`,
      ].join("\n"),
    );
    expect(outline.nodes.map((node) => node.name)).toEqual(["a", "b"]);
    expect(outline.nodes[0]?.children.map((node) => node.name)).toEqual(["one", "two"]);
    expect(outline.nodes[1]?.children.map((node) => node.name)).toEqual(["three"]);
    // Line numbers must be the real call sites, not the fold order.
    expect(outline.nodes[0]?.children.map((node) => node.line)).toEqual([3, 4]);
  });

  test("a loop becomes an explicit container, since its width is unknowable", () => {
    const outline = outlineWorkflowScript(
      [
        `export const meta = { name: "s", description: "d" };`,
        `for (const area of args.areas) {`,
        `  await agent("scan", { label: "scout" });`,
        `}`,
      ].join("\n"),
    );
    expect(outline.nodes.map((node) => node.kind)).toEqual(["loop"]);
    expect(outline.nodes[0]?.dynamic).toBe(true);
    expect(outline.nodes[0]?.children.map((node) => node.kind)).toEqual(["agent"]);
    // Inside a loop even a fully literal agent call has unknown multiplicity.
    expect(outline.nodes[0]?.children[0]?.dynamic).toBe(true);
    expect(outline.hasDynamicFanout).toBe(true);
  });

  test("a syntax error is reported, never thrown", () => {
    expect(outlineWorkflowScript("const = ;").error).toBeTruthy();
  });
});

describe("workflow web server", () => {
  test("rejects every API request without the bearer token", async () => {
    await withServer(async (server) => {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/state`)).status).toBe(401);
      expect((await fetch(`${base}/api/state`, { headers: { "x-workflow-token": "wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/api/state`, { headers: auth })).status).toBe(200);
    });
  });

  test("builtins in /api/state carry a preview script", async () => {
    await withServer(async (server) => {
      const state = (await (await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: auth })).json()) as {
        builtins: Array<{ name: string; script: string }>;
      };
      expect(state.builtins.length).toBe(5);
      for (const builtin of state.builtins) {
        expect(builtin.script, `${builtin.name} missing preview`).toBeTruthy();
        expect(builtin.script).toContain("export const meta");
      }
    });
  });

  test("never serves a file outside the asset root", async () => {
    await withServer(async (server) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/%2e%2e%2f%2e%2e%2fpackage.json`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("omp-dynamic-workflows");
    });
  });

  test("an invalid script is rejected before a run is created", async () => {
    await withServer(async (server, manager) => {
      const base = `http://127.0.0.1:${server.port}`;
      const parsed = await (
        await fetch(`${base}/api/parse`, { method: "POST", headers: auth, body: JSON.stringify({ script: "return 1" }) })
      ).json();
      expect(parsed.ok).toBe(false);

      const rejected = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ script: "return 1" }),
      });
      expect(rejected.status).toBe(500);
      expect(manager.listRuns()).toHaveLength(0);
    });
  });

  test("a run started over HTTP streams live events and lands its return value", async () => {
    await withServer(async (server) => {
      const base = `http://127.0.0.1:${server.port}`;
      const events = new Map<string, number>();
      const stream = await fetch(`${base}/api/events?token=${TOKEN}`);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split >= 0) {
            const type = /^event: (.+)$/m.exec(buffer.slice(0, split))?.[1];
            if (type) events.set(type, (events.get(type) ?? 0) + 1);
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf("\n\n");
          }
        }
      })();

      const { runId } = await (
        await fetch(`${base}/api/runs`, { method: "POST", headers: auth, body: JSON.stringify({ script: SCRIPT }) })
      ).json();
      expect(runId).toBeTruthy();

      let detail: { status?: string; snapshot?: { result?: unknown; agents: unknown[] } } = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
        if (detail.status === "completed" || detail.status === "failed") break;
        await Bun.sleep(25);
      }

      expect(detail.status).toBe("completed");
      expect(detail.snapshot?.agents).toHaveLength(2);
      // The terminal value lives on ManagedRun.result, never on the progress
      // snapshot — the detail endpoint has to merge it in.
      expect(detail.snapshot?.result).toBe("done:scan a,done:scan b");
      // Snapshot frames are coalesced (SNAPSHOT_COALESCE_MS); with an instant
      // stub agent the run settles before that timer fires.
      await Bun.sleep(200);
      await reader.cancel().catch(() => {});
      await pump;
      expect(events.get("hello")).toBe(1);
      expect(events.get("agentStart")).toBe(2);
      expect(events.get("agentEnd")).toBe(2);
      expect(events.get("complete")).toBe(1);
      expect(events.get("snapshot")).toBeGreaterThan(0);
    });
  });

  test("shared references across one response serialize intact at every occurrence", async () => {
    await withServer(async (server) => {
      const base = `http://127.0.0.1:${server.port}`;
      const script = `export const meta = { name: "shared_ref", description: "probe" };\nawait agent("scan", { label: "w-x" });\nreturn args;`;
      const { runId } = await (
        await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ script, args: { tag: "shared" } }),
        })
      ).json();
      expect(runId).toBeTruthy();

      let detail: { status?: string; snapshot?: { result?: unknown } } = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
        if (detail.status === "completed" || detail.status === "failed") break;
        await Bun.sleep(25);
      }

      expect(detail.status).toBe("completed");
      // The script returns `args` verbatim, and the detail response carries the
      // same object as its own top-level `args` field. A cycle detector that
      // remembers every object it ever saw flags the second occurrence as
      // "[circular]"; only the current ancestor path may count as a cycle.
      expect(detail.snapshot?.result).toEqual({ tag: "shared" });
    });
  });

  test("the agent endpoint serves the untrimmed record the drawer needs", async () => {
    await withServer(async (server) => {
      const base = `http://127.0.0.1:${server.port}`;
      const { runId } = await (
        await fetch(`${base}/api/runs`, { method: "POST", headers: auth, body: JSON.stringify({ script: SCRIPT }) })
      ).json();
      for (let attempt = 0; attempt < 100; attempt++) {
        const detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
        if (detail.status === "completed" || detail.status === "failed") break;
        await Bun.sleep(25);
      }

      const agent = await (await fetch(`${base}/api/runs/${runId}/agents/1`, { headers: auth })).json();
      expect(agent.agent.id).toBe(1);
      expect(agent.agent.label).toBe("w-a");
      // `result` is stripped from snapshot pushes; this endpoint must carry it.
      expect(agent.agent.result).toBe("done:scan a");

      expect((await fetch(`${base}/api/runs/${runId}/agents/99`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/api/runs/nope/agents/1`, { headers: auth })).status).toBe(404);
    });
  });

  test("pause and stop drive the same manager the TUI holds", async () => {
    const gate = Promise.withResolvers<string>();
    await withServer(
      async (server, manager) => {
        const base = `http://127.0.0.1:${server.port}`;
        const { runId } = await (
          await fetch(`${base}/api/runs`, { method: "POST", headers: auth, body: JSON.stringify({ script: SCRIPT }) })
        ).json();
        for (let attempt = 0; attempt < 100 && manager.getRun(runId)?.snapshot.agents.length !== 2; attempt++) {
          await Bun.sleep(25);
        }

        const pause = async () =>
          (await (await fetch(`${base}/api/runs/${runId}/pause`, { method: "POST", headers: auth })).json()).ok;
        expect(await pause()).toBe(true);
        expect(manager.getRun(runId)?.status).toBe("paused");
        // A second pause is refused rather than silently re-applied.
        expect(await pause()).toBe(false);

        const stopped = await (
          await fetch(`${base}/api/runs/${runId}/stop`, { method: "POST", headers: auth })
        ).json();
        expect(stopped).toEqual({ ok: true });
        expect(manager.getRun(runId)?.status).toBe("aborted");
        gate.resolve("released");
      },
      { run: () => gate.promise },
    );
  });

  test("saving writes to the chosen scope and reports overwrite targets", async () => {
    await withServer(async (server, _manager, cwd) => {
      const base = `http://127.0.0.1:${server.port}`;
      const before = await (await fetch(`${base}/api/save-locations?name=probe_cmd`, { headers: auth })).json();
      expect(before.options.map((option: { location: string }) => option.location)).toEqual(["project", "user"]);
      expect(before.existing).toEqual([]);

      const saved = await (
        await fetch(`${base}/api/saved`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ name: "probe_cmd", description: "", script: SCRIPT, location: "project" }),
        })
      ).json();
      expect(saved.saved.location).toBe("project");
      expect(saved.saved.path).toBe(join(cwd, ".omp", "workflows", "saved", "probe_cmd.js"));
      expect(existsSync(saved.saved.path)).toBe(true);

      const after = await (await fetch(`${base}/api/save-locations?name=probe_cmd`, { headers: auth })).json();
      expect(after.existing).toEqual(["project"]);

      // A path-unsafe name must never reach the filesystem layer.
      const rejected = await fetch(`${base}/api/saved`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "../escape", script: SCRIPT, location: "user" }),
      });
      expect(rejected.status).toBe(400);
    });
  });
});
