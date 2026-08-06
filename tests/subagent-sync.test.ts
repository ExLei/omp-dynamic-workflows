/**
 * Task 4 (M3b) + Task 5 (M3c): subagent session syncHostTools branch — host
 * skill/extension sync, post-creation denylist convergence, and the MCP
 * whitelist that only mounts tools from mcpServers-declared servers.
 *
 * Drives the REAL WorkflowAgent.run() against a minimal fake host runtime and
 * asserts the createAgentSession call it makes. bun test isolates each file
 * in its own process, so installing the fake here (overriding the real
 * binding that tests/setup.ts preloads) cannot leak into other test files.
 *
 * The fake covers exactly the host surface run() touches:
 *   - createAgentSession (records the options, returns a fake session)
 *   - getActiveSkills (the new syncHostTools channel)
 *   - discoverSessionExtensionPaths (preloadedExtensionPaths pre-discovery)
 *   - Settings.loadIsolated (shared subagent settings)
 *   - getAgentDir / discoverAuthStorage / ModelRegistry (agent dir + registry)
 *   - SessionManager.inMemory (default non-persisted sessions)
 *
 * The fake session also exposes the tool surface run() uses for the denylist
 * convergence + MCP whitelist: getAllToolNames(), getToolByName() (the SDK's
 * public session API — SessionTools itself is a private field, see
 * AgentSession#tools) and setActiveToolsByName().
 */

import { beforeEach, describe, expect, test } from "bun:test";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowAgent } from "../src/agent.js";
import { installHostRuntime } from "../src/omp-host.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const recordedSessions: Array<Record<string, unknown>> = [];

/** Tool sets passed to the fake session's setActiveToolsByName (denylist convergence). */
const appliedToolSets: string[][] = [];

/** Skills the fake host reports via getActiveSkills(). */
const activeSkills = [
  { name: "writing-plans", description: "Plan multi-step work first", filePath: "/skills/writing-plans/SKILL.md" },
  { name: "systematic-debugging", description: "Debug with a method", filePath: "/skills/systematic-debugging/SKILL.md" },
];

/**
 * Extension paths host().discoverSessionExtensionPaths reports. The first is
 * this plugin's own entry under a DIFFERENT root prefix than the real repo —
 * it must still be excluded (suffix identity), the second must be kept.
 */
const discoveredExtensionPaths = ["/x/omp-dynamic-workflows/extensions/workflow.ts", "/y/other-plugin/ext.ts"];

/** A registered tool in the fake session's registry, mirroring the SDK's tool objects. */
interface FakeToolEntry {
  name: string;
  /** Present exactly on MCP tools — the raw server name (the SDK's `mcpServerName`). */
  mcpServerName?: string;
  mcpToolName?: string;
}

/**
 * The fake session's tool registry (mounted before the MCP whitelist
 * convergence). Default: the always-on workflow defaults, the SDK's hidden
 * `goal` tool, a caller-denied tool (via WorkflowAgentOptions.excludeTools),
 * the tools that must survive — plus three MCP routes across two servers
 * (serverA×2, serverB×1), mirroring what a real enableMCP:true session mounts.
 */
let fakeRegistry: Map<string, FakeToolEntry>;

/** When true, the fake session's getToolByName throws (enumeration failure). */
let getToolByNameThrows = false;

function defaultFakeRegistry(): Map<string, FakeToolEntry> {
  const entries: FakeToolEntry[] = [
    { name: "workflow" },
    { name: "workflow_control" },
    { name: "goal" },
    { name: "denied-tool" },
    { name: "my-tool" },
    { name: "read" },
    { name: "bash" },
    { name: "mcp__servera_a1", mcpServerName: "serverA", mcpToolName: "a1" },
    { name: "mcp__servera_a2", mcpServerName: "serverA", mcpToolName: "a2" },
    { name: "mcp__serverb_b1", mcpServerName: "serverB", mcpToolName: "b1" },
  ];
  return new Map(entries.map((tool) => [tool.name, tool]));
}

/** A session double that produces one valid assistant answer per prompt. */
function makeFakeSession(): Record<string, unknown> {
  const messages: unknown[] = [];
  return {
    messages,
    getAllToolNames: () => [...fakeRegistry.keys()],
    getToolByName: (name: string) => {
      if (getToolByNameThrows) throw new Error("boom: registry read failed");
      return fakeRegistry.get(name);
    },
    async setActiveToolsByName(names: string[]) {
      appliedToolSets.push([...names]);
    },
    async prompt() {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    },
    subscribe: () => () => {},
    abort: () => {},
    dispose: () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  };
}

const mockPi = {
  getAgentDir: () => "/tmp/omp-fake-agent-dir",
  Settings: {
    loadIsolated: async () => ({}),
  },
  SessionManager: {
    inMemory: () => ({}),
  },
  discoverAuthStorage: async () => ({}),
  ModelRegistry: class {},
  getActiveSkills: () => activeSkills,
  discoverSessionExtensionPaths: async () => [...discoveredExtensionPaths],
  async createAgentSession(options: Record<string, unknown>) {
    recordedSessions.push(options);
    return { session: makeFakeSession() };
  },
};

installHostRuntime({ pi: mockPi, typebox } as unknown as Parameters<typeof installHostRuntime>[0]);

/** The options the most recent createAgentSession call received. */
function lastCall(): Record<string, unknown> {
  const call = recordedSessions[recordedSessions.length - 1];
  expect(call).toBeDefined();
  return call;
}

/** The tool set the most recent denylist convergence applied. */
function lastAppliedTools(): string[] {
  const applied = appliedToolSets[appliedToolSets.length - 1];
  expect(applied).toBeDefined();
  return applied;
}

const META = (name: string) =>
  `export const meta = { name: "${name}", description: "probe", phases: [{ title: "work" }] };\n`;

describe("subagent session syncHostTools", () => {
  beforeEach(() => {
    appliedToolSets.length = 0;
    getToolByNameThrows = false;
    fakeRegistry = defaultFakeRegistry();
  });

  test("on: syncs host skills + extensions via the omp parent->child channel, denies workflow tools", async () => {
    const agent = new WorkflowAgent({
      syncHostTools: true,
      mcpServers: ["a"],
      enableIrc: true,
      excludeTools: ["denied-tool"],
    });
    const result = await agent.run("do the work");
    expect(result).toBe("done");

    const opts = lastCall();
    expect(opts.skills).toEqual(activeSkills);
    expect(opts.disableExtensionDiscovery).toBe(false);
    expect(opts.enableMCP).toBe(true);
    expect(opts.enableIrc).toBe(true);
    // restrictToolNames: false is required for preloadedExtensionPaths /
    // extension tools to survive (true short-circuits them in the SDK); the
    // denylist is restored post-creation instead. LSP stays off (no drift).
    expect(opts.restrictToolNames).toBe(false);
    expect(opts.enableLsp).toBe(false);
    // The plugin's own extension entry is excluded from the preloaded paths.
    expect(opts.preloadedExtensionPaths).toEqual(["/y/other-plugin/ext.ts"]);
    // Existing session params are preserved alongside the new channel.
    expect(opts.agentId).toMatch(/^wf-/);
    expect(opts.taskDepth).toBe(1);
    expect(opts.allowRestrictedCustomTools).toBe(false);
    expect(Array.isArray(opts.toolNames)).toBe(true);
    expect(opts.customTools).toEqual([]);
    // Denylist convergence restores the full deny surface as an exact set:
    // every registered name minus the always-on workflow/workflow_control
    // defaults, the caller-denied excludeTools entry, and the SDK's hidden
    // `goal` tool (which getAllToolNames() includes even though the SDK's own
    // assembly filters it from the requested names).
    const applied = lastAppliedTools();
    expect(applied).toEqual(["my-tool", "read", "bash"]);
  });

  test("off: restores the isolated session (no skills, no MCP, no IRC, restricted)", async () => {
    const agent = new WorkflowAgent({ syncHostTools: false });
    await agent.run("do the work");

    const opts = lastCall();
    expect(opts.disableExtensionDiscovery).toBe(true);
    expect(opts.enableMCP).toBe(false);
    expect(opts.enableIrc).toBe(false);
    // Isolation branch keeps the original restrictToolNames: true and never
    // preloads extensions — the SDK's own filtering applies the denylist.
    expect(opts.restrictToolNames).toBe(true);
    expect(opts.preloadedExtensionPaths).toBeUndefined();
    expect("skills" in opts).toBe(false);
    expect(opts.skills).toBeUndefined();
    expect(appliedToolSets).toHaveLength(0);
  });

  test("default: syncHostTools ?? true syncs host skills", async () => {
    const agent = new WorkflowAgent();
    await agent.run("do the work");

    const opts = lastCall();
    expect(opts.skills).toEqual(activeSkills);
    expect(opts.disableExtensionDiscovery).toBe(false);
    // mcpServers ?? [] keeps MCP off; enableIrc ?? false keeps IRC off.
    expect(opts.enableMCP).toBe(false);
    expect(opts.enableIrc).toBe(false);
    expect(opts.restrictToolNames).toBe(false);
    expect(opts.enableLsp).toBe(false);
    expect(opts.preloadedExtensionPaths).toEqual(["/y/other-plugin/ext.ts"]);
  });

  test("explicit empty mcpServers keeps enableMCP false", async () => {
    const agent = new WorkflowAgent({ mcpServers: [] });
    await agent.run("do the work");
    expect(lastCall().enableMCP).toBe(false);
  });

  test("mcp whitelist: keeps only tools from mcpServers-declared servers", async () => {
    const agent = new WorkflowAgent({
      syncHostTools: true,
      mcpServers: ["serverA"],
      excludeTools: ["denied-tool"],
    });
    await agent.run("do the work");

    expect(lastCall().enableMCP).toBe(true);
    // One keep computation: the denylist rules (workflow/workflow_control/
    // goal/excludeTools) and the MCP whitelist (serverA tools only, serverB
    // dropped) land in the same exact set handed to setActiveToolsByName.
    expect(lastAppliedTools()).toEqual([
      "my-tool",
      "read",
      "bash",
      "mcp__servera_a1",
      "mcp__servera_a2",
    ]);
  });

  test("mcp whitelist: empty mcpServers keeps no MCP tools", async () => {
    const agent = new WorkflowAgent({ syncHostTools: true, mcpServers: [] });
    await agent.run("do the work");

    // enableMCP false means no MCP routes would be mounted in a real session;
    // even when the registry still carries them (stale/misconfigured), the
    // empty whitelist denies every MCP tool while the denylist still applies
    // (no excludeTools here, so denied-tool survives as a plain tool).
    expect(lastCall().enableMCP).toBe(false);
    expect(lastAppliedTools()).toEqual(["denied-tool", "my-tool", "read", "bash"]);
  });

  test("mcp whitelist: enumeration failure degrades to deny-all-MCP (conservative)", async () => {
    getToolByNameThrows = true;
    const agent = new WorkflowAgent({ syncHostTools: true, mcpServers: ["serverA"] });
    await agent.run("do the work");

    // Whitelist undecidable -> no MCP tools at all; the run itself still works
    // (denied-tool survives because no excludeTools were configured).
    expect(lastAppliedTools()).toEqual(["denied-tool", "my-tool", "read", "bash"]);
  });

  test("manager -> runWorkflow -> WorkflowAgent forwards the three options", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-sync-test-"));
    try {
      const manager = new WorkflowManager({
        cwd,
        syncHostTools: true,
        mcpServers: ["a"],
        enableIrc: true,
      });
      const result = await manager.runSync(
        `${META("sync-chain")}const out = await agent("do the work"); return out;`,
      );
      expect(result.result).toBe("done");

      const opts = lastCall();
      expect(opts.skills).toEqual(activeSkills);
      expect(opts.disableExtensionDiscovery).toBe(false);
      expect(opts.enableMCP).toBe(true);
      expect(opts.enableIrc).toBe(true);
      expect(opts.restrictToolNames).toBe(false);
      expect(opts.enableLsp).toBe(false);
      expect(opts.preloadedExtensionPaths).toEqual(["/y/other-plugin/ext.ts"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
