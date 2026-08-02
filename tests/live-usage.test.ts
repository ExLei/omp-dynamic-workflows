import { describe, expect, test } from "bun:test";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import { usageFromMessages } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowManagerOptions } from "../src/workflow-manager.js";
import { WorkflowManager } from "../src/workflow-manager.js";

const usage = (total: number, cost = 0): AgentUsage => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost,
});

const META = (name: string) =>
  `export const meta = { name: "${name}", description: "probe", phases: [{ title: "work" }] };\n`;

describe("live token usage", () => {
  test("usageFromMessages sums assistant usage and ignores everything else", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 5, totalTokens: 17, cost: { total: 0.5 } },
      },
      { role: "toolResult", toolName: "read" },
      {
        role: "assistant",
        usage: { input: 4, output: 3, cacheRead: 50, cacheWrite: 0, totalTokens: 7, cost: { total: 0.25 } },
      },
    ];
    expect(usageFromMessages(messages)).toEqual({
      input: 14,
      output: 5,
      cacheRead: 150,
      cacheWrite: 5,
      total: 24,
      cost: 0.75,
    });
  });

  test("usageFromMessages reports nothing when the provider reported nothing", () => {
    expect(usageFromMessages([{ role: "assistant", usage: { input: 0, output: 0, totalTokens: 0 } }])).toBeUndefined();
  });

  test("onAgentUsage fires mid-run and onAgentEnd still settles the final figure", async () => {
    const live: { id: string; label: string; total: number }[] = [];
    const ended: { tokens?: number; total?: number }[] = [];

    const result = await runWorkflow(
      `${META("live-usage")}const out = await agent("do work", { label: "worker" }); return out;`,
      {
        agent: {
          async run(_prompt: string, options?: AgentRunOptions<never>) {
            // Two provider round-trips, then the terminal usage read.
            options?.onUsageProgress?.(usage(100));
            options?.onUsageProgress?.(usage(250));
            options?.onUsage?.(usage(300, 1.5));
            return "done";
          },
        },
        onAgentUsage: (event) => {
          live.push({ id: event.id, label: event.label, total: event.tokenUsage.total });
        },
        onAgentEnd: (event) => {
          ended.push({ tokens: event.tokens, total: event.tokenUsage?.total });
        },
      },
    );

    expect(result.result).toBe("done");
    expect(live.map((e) => e.total)).toEqual([100, 250]);
    expect(live.every((e) => e.label === "worker")).toBe(true);
    expect(new Set(live.map((e) => e.id)).size).toBe(1);
    // Live ticks are display-only: the run's accounting still comes from the
    // single terminal usage read, not the sum of the progress snapshots.
    expect(ended).toEqual([{ tokens: 300, total: 300 }]);
    expect(result.tokenUsage?.total).toBe(300);
    expect(result.tokenUsage?.cost).toBe(1.5);
  });

  test("no onAgentUsage consumer means no live sampling is requested", async () => {
    let progressRequested = true;
    await runWorkflow(`${META("no-usage")}return await agent("x");`, {
      agent: {
        async run(_prompt: string, options?: AgentRunOptions<never>) {
          progressRequested = options?.onUsageProgress !== undefined;
          options?.onUsage?.(usage(10));
          return "ok";
        },
      },
    });
    expect(progressRequested).toBe(false);
  });

  test("the manager updates the running agent's snapshot and emits agentUsage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-live-usage-"));
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options?: AgentRunOptions<never>) {
          options?.onUsageProgress?.(usage(1000, 0.25));
          // The snapshot must already show this agent's live figures while it
          // is still running — that is the whole point of the progress path.
          const running = manager.listRuns()[0];
          expect(running?.status).toBe("running");
          const live = manager.getRun(running.runId)?.snapshot.agents[0];
          expect(live?.status).toBe("running");
          expect(live?.tokenUsage?.total).toBe(1000);
          options?.onUsage?.(usage(1200, 0.3));
          return "done";
        },
      } as unknown as WorkflowManagerOptions["agent"],
    });
    const events: { agentId?: number; total: number }[] = [];
    manager.on("agentUsage", (e: { agentId?: number; tokenUsage: AgentUsage }) => {
      events.push({ agentId: e.agentId, total: e.tokenUsage.total });
    });

    const result = await manager.runSync(`${META("manager-live")}return await agent("go", { label: "w" });`);

    expect(result.result).toBe("done");
    expect(events).toEqual([{ agentId: 1, total: 1000 }]);
    expect(result.tokenUsage?.total).toBe(1200);
    rmSync(cwd, { recursive: true, force: true });
  });
});
