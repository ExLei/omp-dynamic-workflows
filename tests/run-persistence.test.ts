import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

const cwds: string[] = [];

function tempProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "omp-runs-"));
  cwds.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of cwds.splice(0)) {
    rmSync(workflowProjectPaths(cwd).rootDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

function runState(runId: string, status: PersistedRunState["status"] = "running"): PersistedRunState {
  return {
    runId,
    workflowName: "demo_flow",
    script: "return 1;",
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("run persistence", () => {
  test("save/load/list/delete round-trip against the machine-local runs dir", () => {
    const cwd = tempProject();
    const store = createRunPersistence(cwd);

    store.save(runState("run-1"));
    store.save(runState("run-2", "completed"));

    expect(store.load("run-1")?.workflowName).toBe("demo_flow");
    expect(store.list().map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);

    expect(store.delete("run-1")).toBe(true);
    expect(store.load("run-1")).toBeNull();
    expect(store.delete("run-1")).toBe(false);
    expect(store.list().map((r) => r.runId)).toEqual(["run-2"]);
  });

  test("runs never land in the project tree", () => {
    const cwd = tempProject();
    const store = createRunPersistence(cwd);
    store.save(runState("run-1"));

    expect(store.getRunsDir().startsWith(cwd)).toBe(false);
    expect(existsSync(join(cwd, ".omp"))).toBe(false);
  });

  test("a lease is exclusive until released, and delete clears the lock", () => {
    const cwd = tempProject();
    const store = createRunPersistence(cwd);
    store.save(runState("run-1"));

    const lease = store.acquireRunLease("run-1");
    expect(lease).not.toBeNull();
    expect(store.acquireRunLease("run-1")).toBeNull();

    store.releaseRunLease(lease!);
    const again = store.acquireRunLease("run-1");
    expect(again).not.toBeNull();

    store.delete("run-1");
    expect(existsSync(join(store.getRunsDir(), "run-1.lock"))).toBe(false);
  });

  test("terminal runs are capped, live runs are never evicted", () => {
    const cwd = tempProject();
    const store = createRunPersistence(cwd, undefined, { maxTerminalRunsOnDisk: 2 });

    store.save(runState("live"));
    for (const id of ["t1", "t2", "t3"]) {
      const state = runState(id, "completed");
      // Distinct updatedAt so eviction order is deterministic (oldest first).
      state.updatedAt = new Date(Date.parse("2026-01-01T00:00:00Z") + id.charCodeAt(1) * 1000).toISOString();
      store.save(state);
    }

    const ids = store.list().map((r) => r.runId).sort();
    expect(ids).toContain("live");
    expect(ids).not.toContain("t1");
    expect(ids.filter((id) => id.startsWith("t"))).toEqual(["t2", "t3"]);
  });
});
