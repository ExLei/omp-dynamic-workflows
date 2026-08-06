/**
 * `/workflows watch` output-channel contract (M4b):
 *  - UI session: progress streams to the status bar (ctx.ui.setStatus) — zero
 *    change from the pre-M4b behavior, pinned here.
 *  - Headless/ACP session (hasUI=false): one compact `workflow-watch` custom
 *    message per second instead, and the interval is cleared once the run
 *    settles (complete/error/stopped/paused) — or, when the run is `rm`'d
 *    (no final event emitted), on the next tick once its snapshot is gone —
 *    so nothing keeps ticking (or emitting) after the watch ends.
 *  - A watch is pinned to its runId: events from other runs never end it.
 *
 * Driven through the real registered command handler with a real
 * WorkflowManager and a blocking agent (same pattern as stop-semantics.test.ts),
 * so the full watch path — not a hand-rolled fixture — is exercised.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

const SCRIPT =
  'export const meta = { name: "watchable", description: "probe", phases: [{ title: "work" }] };\n' +
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

interface SentMessage {
  customType?: string;
  content: string;
  display?: boolean;
}

/** Minimal pi: captures sendMessage and the registered command handler. */
function capturePi(sent: SentMessage[]) {
  let handler: (args: string, ctx: never) => Promise<void> = async () => {};
  const pi = {
    getCommands: () => [],
    registerCommand(_name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      handler = def.handler;
    },
    sendMessage(message: SentMessage) {
      sent.push(message);
    },
  };
  return { pi, getHandler: () => handler };
}

describe("/workflows watch output channel", () => {
  test("headless session streams one workflow-watch message per tick and stops on settle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-watch-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: SentMessage[] = [];
    const { pi, getHandler } = capturePi(sent);
    registerWorkflowCommands(pi as never, manager);

    // Host-managed timer surface: capture the callback + record clears, so the
    // test never depends on wall-clock timers. clearTimer kills the interval
    // (the real host unrefs/clears it), so a dead interval can no longer tick.
    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify() {}, setStatus() {} },
      setInterval(fn: () => void) {
        tick = fn;
        return { handle: "watch-timer" };
      },
      clearTimer(timer: unknown) {
        cleared.push(timer);
        tick = undefined;
      },
    };

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      await getHandler()(`watch ${runId}`, ctx as never);

      // First frame is pushed immediately, as a workflow-watch custom message.
      const watchMessages = sent.filter((m) => m.customType === "workflow-watch");
      expect(watchMessages.length).toBe(1);
      expect(watchMessages[0]!.display).toBe(true);
      expect(watchMessages[0]!.content).toContain("watchable");
      expect(watchMessages[0]!.content).toContain("done");
      expect(tick).toBeDefined();

      // Each timer tick pushes another frame.
      tick!();
      expect(sent.filter((m) => m.customType === "workflow-watch")).toHaveLength(2);

      // Settling the run clears the interval and prints the final snapshot.
      manager.stop(runId);
      await promise.catch(() => {});

      expect(cleared).toEqual([{ handle: "watch-timer" }]);
      const finals = sent.filter((m) => m.customType === "workflows");
      expect(finals).toHaveLength(1);
      expect(finals[0]!.content).toContain("watchable");

      // The interval is gone: clearing killed it, so no further ticks can emit.
      expect(tick).toBeUndefined();
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("UI session keeps the status-bar channel and never sends workflow-watch messages", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-watch-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: SentMessage[] = [];
    const { pi, getHandler } = capturePi(sent);
    registerWorkflowCommands(pi as never, manager);

    const status: Array<[string, string | undefined]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        setStatus(key: string, text: string | undefined) {
          status.push([key, text]);
        },
      },
    };

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      await getHandler()(`watch ${runId}`, ctx as never);

      // Status bar got the compact progress line; no workflow-watch messages.
      expect(sent.filter((m) => m.customType === "workflow-watch")).toHaveLength(0);
      expect(status.filter(([, text]) => text !== undefined).length).toBeGreaterThan(0);
      expect(status[0]![1]).toContain("watchable");

      // On settle the status key is cleared and the final snapshot prints.
      manager.stop(runId);
      await promise.catch(() => {});

      const last = status[status.length - 1]!;
      expect(last[1]).toBeUndefined();
      const finals = sent.filter((m) => m.customType === "workflows");
      expect(finals).toHaveLength(1);
      expect(finals[0]!.content).toContain("watchable");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("another run's settle event does not end this watch (filter pinned to runId)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-watch-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: SentMessage[] = [];
    const { pi, getHandler } = capturePi(sent);
    registerWorkflowCommands(pi as never, manager);

    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify() {}, setStatus() {} },
      setInterval(fn: () => void) {
        tick = fn;
        return { handle: "watch-timer" };
      },
      clearTimer(timer: unknown) {
        cleared.push(timer);
        tick = undefined;
      },
    };

    try {
      const { runId: watchedId, promise: watchedPromise } = manager.startInBackground(SCRIPT);
      await started;
      const { runId: otherId, promise: otherPromise } = manager.startInBackground(SCRIPT);

      await getHandler()(`watch ${watchedId}`, ctx as never);
      expect(tick).toBeDefined();

      // The other run settling emits "stopped" with its own runId — the
      // watch ignores it, keeps its timer, and emits nothing final.
      manager.stop(otherId);
      await otherPromise.catch(() => {});
      expect(tick).toBeDefined();
      expect(cleared).toEqual([]);
      expect(sent.filter((m) => m.customType === "workflows")).toHaveLength(0);
      tick!();
      expect(sent.filter((m) => m.customType === "workflow-watch")).toHaveLength(2);

      // The watched run settling is what actually ends the watch.
      manager.stop(watchedId);
      await watchedPromise.catch(() => {});
      expect(cleared).toEqual([{ handle: "watch-timer" }]);
      expect(tick).toBeUndefined();
      expect(sent.filter((m) => m.customType === "workflows")).toHaveLength(1);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("pausing the run ends the watch: timer cleaned and final snapshot printed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-watch-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: SentMessage[] = [];
    const { pi, getHandler } = capturePi(sent);
    registerWorkflowCommands(pi as never, manager);

    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify() {}, setStatus() {} },
      setInterval(fn: () => void) {
        tick = fn;
        return { handle: "watch-timer" };
      },
      clearTimer(timer: unknown) {
        cleared.push(timer);
        tick = undefined;
      },
    };

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      await getHandler()(`watch ${runId}`, ctx as never);
      expect(tick).toBeDefined();

      // "paused" is a final event: the watch stops streaming and prints the
      // run's current snapshot as the final message.
      manager.pause(runId);
      await promise.catch(() => {});

      expect(cleared).toEqual([{ handle: "watch-timer" }]);
      expect(tick).toBeUndefined();
      const finals = sent.filter((m) => m.customType === "workflows");
      expect(finals).toHaveLength(1);
      expect(finals[0]!.content).toContain("watchable");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("removing the run (rm, no final event) self-cleans the timer on the next tick", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-watch-"));
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const manager = blockingManager(cwd, { resolve: () => resolveStarted() });

    const sent: SentMessage[] = [];
    const { pi, getHandler } = capturePi(sent);
    registerWorkflowCommands(pi as never, manager);

    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const ctx = {
      hasUI: false,
      ui: { notify() {}, setStatus() {} },
      setInterval(fn: () => void) {
        tick = fn;
        return { handle: "watch-timer" };
      },
      clearTimer(timer: unknown) {
        cleared.push(timer);
        tick = undefined;
      },
    };

    try {
      const { runId, promise } = manager.startInBackground(SCRIPT);
      await started;

      await getHandler()(`watch ${runId}`, ctx as never);
      expect(tick).toBeDefined();

      // rm emits no final event — the run simply disappears from the manager.
      expect(manager.deleteRun(runId)).toBe(true);
      await promise.catch(() => {});

      // The next tick sees a null snapshot and self-cleans: listeners are
      // unbound, the timer is cleared, and no frame/final message is emitted.
      tick!();
      expect(cleared).toEqual([{ handle: "watch-timer" }]);
      expect(tick).toBeUndefined();
      expect(sent.filter((m) => m.customType === "workflow-watch")).toHaveLength(1);
      expect(sent.filter((m) => m.customType === "workflows")).toHaveLength(0);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
