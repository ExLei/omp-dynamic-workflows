import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

const SCRIPT =
  'export const meta = { name: "stoppable", description: "probe", phases: [{ title: "work" }] };\n' +
  'return await agent("go", { label: "worker" });';

/** An agent that never finishes on its own — it only ends when the run is aborted. */
function blockingManager(cwd: string, started: { resolve?: () => void }): WorkflowManager {
  return new WorkflowManager({
    cwd,
    agent: {
      run(_prompt: string, options?: AgentRunOptions<never>) {
        started.resolve?.();
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Subagent was aborted")), {
            once: true,
          });
        });
      },
    } as unknown as WorkflowManagerOptions["agent"],
  });
}

describe("stopping a run by hand", () => {
  test("emits stopped, never error, and settles as aborted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-stop-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const errors: unknown[] = [];
    const stopped: string[] = [];
    manager.on("error", (e: { runId: string }) => errors.push(e));
    manager.on("stopped", (e: { runId: string }) => stopped.push(e.runId));

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      expect(manager.stop(runId)).toBe(true);
      await promise.catch(() => {});

      expect(stopped).toEqual([runId]);
      // The abort rejection IS the user's request taking effect — not a failure.
      expect(errors).toEqual([]);
      expect(manager.getRun(runId)?.status).toBe("aborted");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("delivers a non-turn-triggering notice instead of a failure follow-up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-stop-deliver-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: { content: string; triggerTurn?: boolean }[] = [];
    const pi = {
      sendMessage(message: { content: string }, options?: { triggerTurn?: boolean }) {
        sent.push({ content: message.content, triggerTurn: options?.triggerTurn });
      },
    };
    installResultDelivery(pi as never, manager, {});

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      manager.stop(runId);
      await promise.catch(() => {});

      expect(sent).toHaveLength(1);
      expect(sent[0]!.triggerTurn).toBe(false);
      expect(sent[0]!.content).toContain("stopped by the user");
      expect(sent[0]!.content).not.toContain("failed");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
