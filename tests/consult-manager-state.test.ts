import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunOptions } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import { WorkflowManager, type WorkflowManagerOptions } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

/**
 * A script that reaches a consult() intervention point on its very first call —
 * consult() throws CONSULT_PENDING synchronously, so the run settles through
 * executeRun's catch tail without ever calling the agent.
 */
const CONSULT_SCRIPT =
  'export const meta = { name: "consult-probe", description: "consult state machine" };\n' +
  'consult("q", { to: "agent" });\n' +
  "return 'unreachable';";

/** Start the consult script on a fresh manager and settle it to waiting_consult. */
async function startConsultRun(cwd: string): Promise<{ manager: WorkflowManager; runId: string }> {
  const manager = new WorkflowManager({ cwd });
  const { runId, promise } = manager.startInBackground(CONSULT_SCRIPT);
  await promise.catch(() => {});
  expect(manager.getRun(runId)?.status).toBe("waiting_consult");
  return { manager, runId };
}

describe("waiting_consult state machine", () => {
  test("stop() accepts waiting_consult in both memory and disk branches", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-stop-"));
    try {
      const { manager, runId } = await startConsultRun(cwd);

      // Memory branch: the run is live in this manager.
      expect(manager.stop(runId)).toBe(true);
      expect(manager.getRun(runId)?.status).toBe("aborted");
      // Spec §6: stop explicitly clears the pending consult — an aborted run
      // must not keep its intervention prompt in memory or on disk.
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(manager.getPersistence().load(runId)?.pendingConsult).toBeUndefined();

      // Disk branch: a manager that never held the run in memory stops the
      // persisted waiting_consult run against on-disk state alone.
      const second = await startConsultRun(cwd);
      const diskOnly = new WorkflowManager({ cwd });
      expect(diskOnly.getRun(second.runId)).toBeUndefined();
      expect(diskOnly.stop(second.runId)).toBe(true);
      expect(diskOnly.getPersistence().load(second.runId)?.status).toBe("aborted");
      expect(diskOnly.getPersistence().load(second.runId)?.pendingConsult).toBeUndefined();
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resume() rejects waiting_consult in both memory and disk branches", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-resume-"));
    try {
      const { manager, runId } = await startConsultRun(cwd);

      // Memory branch: the live run is refused.
      expect(await manager.resume(runId)).toBe(false);

      // Disk branch: no in-memory copy — the persisted state alone refuses.
      const diskOnly = new WorkflowManager({ cwd });
      expect(await diskOnly.resume(runId)).toBe(false);
      expect(diskOnly.getPersistence().load(runId)?.status).toBe("waiting_consult");

      // Memory/disk skew: the live run is parked on waiting_consult in memory
      // while the disk copy already says paused (the half-write window after
      // resolveConsult() flipped disk to paused before the in-memory object
      // caught up). Only the in-memory guard can veto this resume — the disk
      // guard alone would let a "paused" run through — so this assertion is
      // the regression tripwire for the memory-side waiting_consult guard.
      const { manager: skewed, runId: skewedId } = await startConsultRun(cwd);
      expect(skewed.getPersistence().load(skewedId)?.status).toBe("waiting_consult");
      skewed.getPersistence().save({ ...skewed.getPersistence().load(skewedId)!, status: "paused" });
      expect(skewed.getRun(skewedId)?.status).toBe("waiting_consult");
      expect(skewed.getPersistence().load(skewedId)?.status).toBe("paused");
      expect(await skewed.resume(skewedId)).toBe(false);
      // Restore the fixture: heal the disk copy back to waiting_consult.
      skewed.getPersistence().save({ ...skewed.getPersistence().load(skewedId)!, status: "waiting_consult" });
      expect(skewed.getPersistence().load(skewedId)?.status).toBe("waiting_consult");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("pause() rejects waiting_consult", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-pause-"));
    try {
      const { manager, runId } = await startConsultRun(cwd);

      expect(manager.pause(runId)).toBe(false);
      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getPersistence().load(runId)?.status).toBe("waiting_consult");
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("allowedActions(waiting_consult) returns [status, stop, reply, intervene]", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-actions-"));
    try {
      const { manager, runId } = await startConsultRun(cwd);
      const tool = createWorkflowControlTool({ manager });

      // pause is not an allowed transition for waiting_consult; the control
      // tool's error response carries the allowed set for the current status.
      const result = await tool.execute("call-1", { action: "pause", runId }, undefined, undefined, {} as never);
      expect(result.details?.result).toBe("error");
      expect(result.details?.allowedActions).toEqual(["status", "stop", "reply", "intervene"]);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("executeRun catch tail maps CONSULT_PENDING to waiting_consult (persisted, no error event)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-tail-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const errors: unknown[] = [];
      const consultPending: Array<{ runId: string; prompt: string }> = [];
      manager.on("error", (e) => errors.push(e));
      manager.on("consult-pending", (e) => consultPending.push(e));

      const { runId, promise } = manager.startInBackground(CONSULT_SCRIPT);
      const rejected = await promise.catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(WorkflowError);
      expect((rejected as WorkflowError).code).toBe(WorkflowErrorCode.CONSULT_PENDING);

      expect(manager.getRun(runId)?.status).toBe("waiting_consult");
      expect(manager.getRun(runId)?.pendingConsult).toEqual({
        journalPrefix: `${runId}:`,
        callIndex: 0,
        prompt: "q",
        opts: { to: "agent" },
        generation: 0,
      });
      // A consult pause is a review gate, never a failure: no error event.
      expect(errors).toEqual([]);
      expect(consultPending).toEqual([{ runId, prompt: "q" }]);

      // The waiting_consult state and pending consult survive a disk round-trip.
      const persisted = manager.getPersistence().load(runId);
      expect(persisted?.status).toBe("waiting_consult");
      expect(persisted?.pendingConsult).toEqual({
        journalPrefix: `${runId}:`,
        callIndex: 0,
        prompt: "q",
        opts: { to: "agent" },
        generation: 0,
      });
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("stop in the catch-tail window wins: aborted is not overwritten by CONSULT_PENDING", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-race-"));
    let runId = "";
    const manager = new WorkflowManager({
      cwd,
      agent: {
        run(_prompt: string, _options?: AgentRunOptions<never>) {
          // stop() lands first (aborts the controller and sets aborted), THEN
          // the CONSULT_PENDING error surfaces at the catch tail — the tail
          // must keep the already-aborted status, not overwrite it with
          // waiting_consult.
          manager.stop(runId);
          return Promise.reject(
            new WorkflowError("consult pending", WorkflowErrorCode.CONSULT_PENDING, {
              recoverable: false,
              payload: { journalPrefix: `${runId}:`, callIndex: 0, prompt: "q", opts: { to: "agent" } },
            }),
          );
        },
      } as unknown as WorkflowManagerOptions["agent"],
    });
    const errors: unknown[] = [];
    const consultPending: unknown[] = [];
    manager.on("error", (e) => errors.push(e));
    manager.on("consult-pending", (e) => consultPending.push(e));

    const RACE_SCRIPT =
      'export const meta = { name: "race", description: "stop window" };\n' +
      'return await agent("go", { label: "worker" });';
    const { runId: id, promise } = manager.startInBackground(RACE_SCRIPT);
    runId = id;
    await promise.catch(() => {});

    expect(manager.getRun(runId)?.status).toBe("aborted");
    expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
    expect(manager.getPersistence().load(runId)?.status).toBe("aborted");
    expect(errors).toEqual([]);
    expect(consultPending).toEqual([]);
  });

  test("malformed CONSULT_PENDING payload fails loudly instead of parking on waiting_consult", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-consult-malformed-"));
    try {
      const manager = new WorkflowManager({
        cwd,
        agent: {
          run(_prompt: string, _options?: AgentRunOptions<never>) {
            // A CONSULT_PENDING whose payload is missing the prompt identity —
            // consult()'s contract never raises this, but another path might.
            // The manager must not silently park on a degenerate waiting_consult
            // (task 3's hashConsult would recompute from an empty identity and
            // the user's reply would never match the call).
            return Promise.reject(
              new WorkflowError("consult pending", WorkflowErrorCode.CONSULT_PENDING, {
                recoverable: false,
                payload: { journalPrefix: "malformed:", callIndex: 0, opts: { to: "agent" } },
              }),
            );
          },
        } as unknown as WorkflowManagerOptions["agent"],
      });
      const errors: unknown[] = [];
      const consultPending: unknown[] = [];
      manager.on("error", (e) => errors.push(e));
      manager.on("consult-pending", (e) => consultPending.push(e));

      const MALFORMED_SCRIPT =
        'export const meta = { name: "malformed", description: "bad payload" };\n' +
        'return await agent("go", { label: "worker" });';
      const { runId, promise } = manager.startInBackground(MALFORMED_SCRIPT);
      const rejected = await promise.catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(WorkflowError);

      // Loud failure: failed status + error event, no waiting_consult state,
      // nothing persisted as a pending intervention.
      expect(manager.getRun(runId)?.status).toBe("failed");
      expect(manager.getRun(runId)?.pendingConsult).toBeUndefined();
      expect(manager.getPersistence().load(runId)?.status).toBe("failed");
      expect(manager.getPersistence().load(runId)?.pendingConsult).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(consultPending).toEqual([]);
    } finally {
      rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
