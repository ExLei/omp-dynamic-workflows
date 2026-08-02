/**
 * Feasibility harness: run the workflow web surface WITHOUT an omp process.
 *
 *   bun spike/web-standalone.ts          -> simulated agent runner (no model calls)
 *   bun spike/web-standalone.ts --real   -> real subagents via host().createAgentSession
 *
 * The simulated runner emits the same callbacks a real subagent does
 * (onUsageProgress / onHistory / onUsage), so every live path the UI depends on
 * is exercised end to end without spending tokens.
 */

import * as pi from "@oh-my-pi/pi-coding-agent";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import { installHostRuntime } from "../src/omp-host.js";
import { warmFrontmatter, warmSchemaValidator } from "../src/omp-lazy.js";
import { startWorkflowWebServer } from "../src/web-server.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";

installHostRuntime({ pi, typebox } as unknown as Parameters<typeof installHostRuntime>[0]);
await Promise.all([warmFrontmatter(), warmSchemaValidator()]);

const real = process.argv.includes("--real");
const port = Number(process.env.WF_WEB_PORT ?? 7788);
const cwd = process.cwd();

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

const usage = (step: number): AgentUsage => ({
  input: step * 1_400,
  output: step * 260,
  cacheRead: step * 9_000,
  cacheWrite: 0,
  total: step * 1_660,
  cost: step * 0.0032,
});

/** Mimics WorkflowAgent.run's observable contract without touching a provider. */
const simulated = {
  async run(prompt: string, options?: AgentRunOptions<never>): Promise<string> {
    const label = options?.label ?? "agent";
    const steps = 4 + (label.length % 3);
    options?.onModelResolved?.("simulated/echo-1");
    for (let step = 1; step <= steps; step++) {
      await delay(800, options?.signal);
      options?.onUsageProgress?.(usage(step));
      options?.onHistory?.([
        { role: "assistant", kind: "text", text: `${label}: step ${step}/${steps}` },
        { role: "assistant", kind: "toolCall", text: `read src/file-${step}.ts`, toolName: "read" },
        { role: "tool", kind: "toolResult", text: `${step * 37} lines`, toolName: "read" },
      ]);
    }
    options?.onUsage?.(usage(steps));
    return `[${label}] ${prompt.slice(0, 60)} -> ok`;
  },
};

const storage = createWorkflowStorage(cwd);
const manager = new WorkflowManager({
  cwd,
  ...(real ? {} : { agent: simulated as never }),
  loadSavedWorkflow: (name: string) => storage.load(name)?.script,
});

const server = startWorkflowWebServer({
  manager,
  storage,
  cwd,
  port,
  token: process.env.WF_WEB_TOKEN,
});

console.log(`[spike] mode=${real ? "real subagents" : "simulated agents"}`);
console.log(`[spike] ${server.url}`);

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
