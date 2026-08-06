import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { outlineWorkflowScript } from "../src/web-outline.js";
import { startWorkflowWebServer, type WorkflowWebServer } from "../src/web-server.js";
import { hashConsult } from "../src/workflow.js";
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

  test("resume accepts an optional script body and routes waiting_consult to resolveConsult", async () => {
    // One held agent per invocation: the consult run's post-resume agent call,
    // then the plain run's agent call that pause() interrupts.
    const gateA = Promise.withResolvers<unknown>();
    const gateB = Promise.withResolvers<unknown>();
    let invocation = 0;
    await withServer(
      async (server, manager) => {
        const base = `http://127.0.0.1:${server.port}`;
        const parkScript =
          'export const meta = { name: "consult-run", description: "park" };\n' +
          'consult("q", { to: "main" });\n' +
          "return 'unreachable';";
        const replyScript =
          'export const meta = { name: "consult-run", description: "reply" };\n' +
          'consult("q", { to: "main" });\n' +
          'return await agent("go", { label: "worker" });';
        const plainScript =
          'export const meta = { name: "plain-run", description: "hold an agent" };\n' +
          'return await agent("go", { label: "worker" });';
        const doneScript = 'export const meta = { name: "plain-run", description: "replacement" };\nreturn 7;';

        // A malformed reply never reaches the manager: 400 up front, the run
        // stays parked on waiting_consult.
        const { runId, promise: parked } = manager.startInBackground(parkScript);
        await parked.catch(() => {});
        expect(manager.getRun(runId)?.status).toBe("waiting_consult");
        const bad = await fetch(`${base}/api/runs/${runId}/resume`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ script: "return 1" }),
        });
        expect(bad.status).toBe(400);
        expect((await bad.json()).error).toContain("脚本无效");
        expect(manager.getRun(runId)?.status).toBe("waiting_consult");

        // A valid reply routes to resolveConsult: the outcome is journaled on
        // disk BEFORE resume, and the run is back executing.
        const ok = await (
          await fetch(`${base}/api/runs/${runId}/resume`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ script: replyScript }),
          })
        ).json();
        expect(ok).toEqual({ ok: true });
        for (let attempt = 0; attempt < 100 && manager.getRun(runId)?.snapshot.agents.length !== 1; attempt++) {
          await Bun.sleep(25);
        }
        expect(manager.getRun(runId)?.status).toBe("running");
        // Running runs keep their journal on disk — the consult entry proves
        // the reply reached resolveConsult (only it journals consult outcomes).
        const consultEntry = manager.getPersistence().load(runId)?.journal?.find((e) => e.index === 0);
        expect(consultEntry).toEqual({
          index: 0,
          runId,
          hash: hashConsult("q", { to: "main" }),
          result: { applied: true, revisedScript: replyScript, summary: "应用了用户提供的脚本" },
        });

        // Non-waiting_consult resume with a script walks the existing path:
        // pause a running run, resume with a replacement script — the resumed
        // execution runs THAT script (its return value proves it).
        const { runId: plainId } = manager.startInBackground(plainScript);
        for (let attempt = 0; attempt < 100 && manager.getRun(plainId)?.snapshot.agents.length !== 1; attempt++) {
          await Bun.sleep(25);
        }
        const paused = await (
          await fetch(`${base}/api/runs/${plainId}/pause`, { method: "POST", headers: auth })
        ).json();
        expect(paused).toEqual({ ok: true });
        expect(manager.getRun(plainId)?.status).toBe("paused");

        const resumed = await (
          await fetch(`${base}/api/runs/${plainId}/resume`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ script: doneScript }),
          })
        ).json();
        expect(resumed).toEqual({ ok: true });
        let detail: { status?: string; script?: string; snapshot?: { result?: unknown } } = {};
        for (let attempt = 0; attempt < 100; attempt++) {
          detail = await (await fetch(`${base}/api/runs/${plainId}`, { headers: auth })).json();
          if (detail.status === "completed" || detail.status === "failed") break;
          await Bun.sleep(25);
        }
        expect(detail.status).toBe("completed");
        expect(detail.script).toBe(doneScript);
        expect(detail.snapshot?.result).toBe(7);

        // Release both held agents so the runs settle before the cwd is wiped.
        gateA.resolve("done:go");
        gateB.resolve("done:go");
      },
      {
        run() {
          return (invocation++ === 0 ? gateA.promise : gateB.promise) as Promise<string>;
        },
      },
    );
  });

  test("GET /api/runs/:id exposes pendingConsult.revisedScript ?? script for waiting_consult runs", async () => {
    await withServer(async (server, manager) => {
      const base = `http://127.0.0.1:${server.port}`;
      const original =
        'export const meta = { name: "consult", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'unreachable';";
      const revised =
        'export const meta = { name: "consult", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'revised';";

      const { runId, promise } = manager.startInBackground(original);
      await promise.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // No revision ready yet → the detail falls back to the run's own script.
      const before = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
      expect(before.script).toBe(original);

      // Direct construction of a confirm-chain artifact (the manager has no
      // public setter; mirror what maybeStartReviewChain's confirm branch
      // writes onto the pending consult), in memory and on disk.
      const live = manager.getRun(runId)!;
      live.pendingConsult = { ...live.pendingConsult!, revisedScript: revised };
      const persisted = manager.getPersistence().load(runId)!;
      manager.getPersistence().save({
        ...persisted,
        pendingConsult: { ...persisted.pendingConsult!, revisedScript: revised },
      });

      // The detail surfaces the review's latest artifact so the console's
      // reply path edits the revised script, not the original (spec §8).
      const after = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
      expect(after.status).toBe("waiting_consult");
      expect(after.script).toBe(revised);
    });
  });

  test("intervene parks the run named in the URL, never a different live run", async () => {
    // One held agent per run: the fix under test is that the per-row 介入
    // button routes by the CLICKED row's runId (store.control(action, runId)),
    // so the endpoint must park exactly the URL-specified run and leave any
    // other live run executing.
    const gateA = Promise.withResolvers<unknown>();
    const gateB = Promise.withResolvers<unknown>();
    let invocation = 0;
    await withServer(
      async (server, manager) => {
        const base = `http://127.0.0.1:${server.port}`;
        const held =
          'export const meta = { name: "held", description: "d" };\n' +
          'return await agent("go", { label: "worker" });';
        const { runId: runA, promise: doneA } = manager.startInBackground(held);
        const { runId: runB } = manager.startInBackground(held);
        for (let attempt = 0; attempt < 100 && manager.getRun(runB)?.snapshot.agents.length !== 1; attempt++) {
          await Bun.sleep(25);
        }
        expect(manager.getRun(runA)?.status).toBe("running");
        expect(manager.getRun(runB)?.status).toBe("running");

        const intervened = await (
          await fetch(`${base}/api/runs/${runB}/intervene`, { method: "POST", headers: auth })
        ).json();
        expect(intervened).toEqual({ ok: true });
        expect(manager.getRun(runB)?.status).toBe("waiting_consult");
        expect(manager.getRun(runA)?.status).toBe("running");

        // Release both held agents so the runs settle before the cwd is wiped.
        gateA.resolve("done:a");
        gateB.resolve("done:b");
        await doneA.catch(() => {});
      },
      {
        run() {
          return (invocation++ === 0 ? gateA.promise : gateB.promise) as Promise<string>;
        },
      },
    );
  });

  test("resume rejects a non-string script and a malformed body with 400, never a silent bare resume", async () => {
    await withServer(async (server, manager) => {
      const base = `http://127.0.0.1:${server.port}`;
      const parkScript =
        'export const meta = { name: "consult-run", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'unreachable';";
      const { runId, promise: parked } = manager.startInBackground(parkScript);
      await parked.catch(() => {});
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // Non-string script: previously coerced to "no script" — a bare resume
      // that would have discarded the intended reply. Now a 400 up front.
      const notString = await fetch(`${base}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ script: 42 }),
      });
      expect(notString.status).toBe(400);
      expect((await notString.json()).error).toContain("script");
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // Malformed JSON: previously swallowed into {} → bare resume. Now a 400.
      const badJson = await fetch(`${base}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: auth,
        body: '{script: "oops"',
      });
      expect(badJson.status).toBe(400);
      expect((await badJson.json()).error).toContain("JSON");
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");

      // A bare (empty-body) resume stays valid — the console's 恢复 button.
      // resolveConsult with no script is the documented 维持原脚本 continue:
      // the run is released and its trivial script completes.
      const bare = await fetch(`${base}/api/runs/${runId}/resume`, { method: "POST", headers: auth });
      expect(bare.status).toBe(200);
      expect((await bare.json()).ok).toBe(true);
      let released: { status?: string } = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        released = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
        if (released.status === "completed" || released.status === "failed") break;
        await Bun.sleep(25);
      }
      expect(released.status).toBe("completed");
      expect(manager.getPersistence().load(runId)?.pendingConsult).toBeUndefined();
    });
  });

  test("disk-only GET /api/runs/:id surfaces revisedScript ?? script after a cold start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-web-diskonly-"));
    try {
      const original =
        'export const meta = { name: "consult", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'unreachable';";
      const revised =
        'export const meta = { name: "consult", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'revised';";

      // Park a waiting_consult run in a first manager, then write the review
      // revision to DISK only — the fresh manager below has no in-memory copy.
      const first = new WorkflowManager({ cwd });
      const { runId, promise } = first.startInBackground(original);
      await promise.catch(() => {});
      expect(first.getRun(runId)?.status).toBe("waiting_consult");
      const persisted = first.getPersistence().load(runId)!;
      first.getPersistence().save({
        ...persisted,
        pendingConsult: { ...persisted.pendingConsult!, revisedScript: revised },
      });

      // Cold start: a fresh manager + server over the same cwd (recoverStaleRuns
      // leaves waiting_consult runs parked).
      const manager = new WorkflowManager({ cwd });
      expect(manager.getRun(runId)).toBeUndefined();
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
      const server = startWorkflowWebServer({
        manager,
        storage: createWorkflowStorage(cwd),
        cwd,
        port: 0,
        token: TOKEN,
      });
      try {
        const detail = await (
          await fetch(`http://127.0.0.1:${server.port}/api/runs/${runId}`, { headers: auth })
        ).json();
        expect(detail.status).toBe("waiting_consult");
        // The cold-start path reads pendingConsult.revisedScript off disk, so
        // the console's reply baseline is the review's artifact, not the original.
        expect(detail.script).toBe(revised);
      } finally {
        server.stop();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("disk-only waiting_consult resume routes to resolveConsult after a cold start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-web-diskonly-resume-"));
    try {
      const parkScript =
        'export const meta = { name: "consult", description: "park" };\n' +
        'consult("q", { to: "main" });\n' +
        "return 'unreachable';";
      const replyScript =
        'export const meta = { name: "consult", description: "reply" };\n' +
        'consult("q", { to: "main" });\n' +
        'return await agent("go", { label: "worker" });';

      const first = new WorkflowManager({ cwd });
      const { runId, promise } = first.startInBackground(parkScript);
      await promise.catch(() => {});
      expect(first.getPersistence().load(runId)?.status).toBe("waiting_consult");

      // Cold start: a fresh manager + server over the same cwd — the parked
      // run exists only on disk; the resumed run's agent call is gate-held.
      const gate = Promise.withResolvers<unknown>();
      const manager = new WorkflowManager({ cwd, agent: { run: () => gate.promise } as never });
      expect(manager.getRun(runId)).toBeUndefined();
      const server = startWorkflowWebServer({
        manager,
        storage: createWorkflowStorage(cwd),
        cwd,
        port: 0,
        token: TOKEN,
      });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const ok = await (
          await fetch(`${base}/api/runs/${runId}/resume`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ script: replyScript }),
          })
        ).json();
        expect(ok).toEqual({ ok: true });
        for (let attempt = 0; attempt < 100 && manager.getRun(runId)?.snapshot.agents.length !== 1; attempt++) {
          await Bun.sleep(25);
        }
        expect(manager.getRun(runId)?.status).toBe("running");

        // Only resolveConsult journals consult outcomes — the entry proves the
        // reply went through the disk-only resolveConsult branch, and the
        // pending consult was cleared in the same critical section.
        const released = manager.getPersistence().load(runId);
        expect(released?.pendingConsult).toBeUndefined();
        expect(released?.journal?.[0]).toEqual({
          index: 0,
          runId,
          hash: hashConsult("q", { to: "main" }),
          result: { applied: true, revisedScript: replyScript, summary: "应用了用户提供的脚本" },
        });

        gate.resolve("done");
        let settled: { status?: string } = {};
        for (let attempt = 0; attempt < 100; attempt++) {
          settled = await (await fetch(`${base}/api/runs/${runId}`, { headers: auth })).json();
          if (settled.status === "completed" || settled.status === "failed") break;
          await Bun.sleep(25);
        }
        expect(settled.status).toBe("completed");
      } finally {
        server.stop();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
