import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowStorage, saveLocationOptions } from "../src/workflow-saved.js";
import { workflowProjectPaths, workflowUserSavedDir } from "../src/workflow-paths.js";

const projectDir = (cwd: string) => join(cwd, ".omp", "workflows", "saved");

describe("saved workflow locations", () => {
  test("a project save lands inside the project, not the home namespace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-"));
    try {
      const storage = createWorkflowStorage(cwd);
      const saved = storage.save({ name: "demo", description: "d", script: "s", location: "project" }, "project");

      expect(saved.path).toBe(join(projectDir(cwd), "demo.json"));
      expect(existsSync(saved.path)).toBe(true);
      // The old home-namespaced project directory must stay untouched.
      expect(existsSync(join(workflowProjectPaths(cwd).homeSavedDir, "demo.json"))).toBe(false);
      expect(storage.load("demo")?.location).toBe("project");
      expect(storage.list().map((w) => w.name)).toEqual(["demo"]);
      expect(storage.delete("demo", "project")).toBe(true);
      expect(storage.load("demo")).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("project workflows written by an older build are still readable", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-legacy-"));
    const paths = workflowProjectPaths(cwd);
    try {
      mkdirSync(paths.homeSavedDir, { recursive: true });
      writeFileSync(
        join(paths.homeSavedDir, "old.json"),
        JSON.stringify({ name: "old", description: "legacy", script: "x", savedAt: "2024-01-01T00:00:00.000Z" }),
      );
      const storage = createWorkflowStorage(cwd);

      expect(storage.load("old")?.description).toBe("legacy");
      expect(storage.list().map((w) => w.name)).toEqual(["old"]);
      // Deleting cleans up the legacy copy too, so it can't resurrect.
      expect(storage.delete("old")).toBe(true);
      expect(storage.load("old")).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paths.rootDir, { recursive: true, force: true });
    }
  });

  test("an in-project workflow shadows a same-named home-namespaced one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-shadow-"));
    const paths = workflowProjectPaths(cwd);
    try {
      mkdirSync(paths.homeSavedDir, { recursive: true });
      writeFileSync(
        join(paths.homeSavedDir, "dup.json"),
        JSON.stringify({ name: "dup", description: "stale", script: "x", savedAt: "2024-01-01T00:00:00.000Z" }),
      );
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "dup", description: "fresh", script: "y", location: "project" }, "project");

      expect(storage.load("dup")?.description).toBe("fresh");
      expect(storage.list()).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paths.rootDir, { recursive: true, force: true });
    }
  });

  test("locationsOf reports every destination holding the name, legacy included", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-where-"));
    const paths = workflowProjectPaths(cwd);
    try {
      const storage = createWorkflowStorage(cwd);
      expect(storage.locationsOf("nope")).toEqual([]);

      storage.save({ name: "here", description: "d", script: "s", location: "project" }, "project");
      expect(storage.locationsOf("here")).toEqual(["project"]);

      storage.save({ name: "here", description: "d", script: "s", location: "user" }, "user");
      expect(storage.locationsOf("here")).toEqual(["project", "user"]);
      storage.delete("here");

      // A legacy home-namespaced copy still counts as occupying "project".
      mkdirSync(paths.homeSavedDir, { recursive: true });
      writeFileSync(
        join(paths.homeSavedDir, "legacy.json"),
        JSON.stringify({ name: "legacy", description: "d", script: "s", savedAt: "2024-01-01T00:00:00.000Z" }),
      );
      expect(storage.locationsOf("legacy")).toEqual(["project"]);
      storage.delete("legacy");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paths.rootDir, { recursive: true, force: true });
    }
  });

  test("the offered destinations are project-first and name their real directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-opts-"));
    try {
      const options = saveLocationOptions(cwd);
      expect(options.map((o) => o.location)).toEqual(["project", "user"]);
      expect(options[0].dir).toBe(projectDir(cwd));
      expect(options[1].dir).toBe(workflowUserSavedDir());
      expect(options[0].display).toBe(".omp/workflows/saved");
      expect(options[1].display).toBe("~/.omp/workflows/saved");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
