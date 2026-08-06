import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowStorage, saveLocationOptions } from "../src/workflow-saved.js";
import { workflowProjectPaths, workflowUserSavedDir } from "../src/workflow-paths.js";

const projectDir = (cwd: string) => join(cwd, ".omp", "workflows", "saved");
// save() validates its input as a runnable workflow module (meta header
// required), so location-focused tests pass a real script.
const SCRIPT = `export const meta = { name: "demo", description: "d" }\nconst x = 1;\n`;

describe("saved workflow locations", () => {
  test("a project save lands inside the project, not the home namespace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-"));
    try {
      const storage = createWorkflowStorage(cwd);
      const saved = storage.save({ name: "demo", description: "d", script: SCRIPT, location: "project" }, "project");

      expect(saved.path).toBe(join(projectDir(cwd), "demo.js"));
      expect(existsSync(saved.path)).toBe(true);
      // The old home-namespaced project directory must stay untouched.
      expect(existsSync(join(workflowProjectPaths(cwd).homeSavedDir, "demo.js"))).toBe(false);
      expect(storage.load("demo")?.location).toBe("project");
      expect(storage.list().map((w) => w.name)).toEqual(["demo"]);
      expect(storage.delete("demo", "project")).toBe(true);
      expect(storage.load("demo")).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an in-project workflow shadows a same-named home-namespaced one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-shadow-"));
    const paths = workflowProjectPaths(cwd);
    try {
      mkdirSync(paths.homeSavedDir, { recursive: true });
      writeFileSync(
        join(paths.homeSavedDir, "dup.js"),
        'export const meta = {\n  name: "dup",\n  description: "stale",\n}\n\nconst body = "x";\n',
      );
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "dup", description: "fresh", script: SCRIPT, location: "project" }, "project");

      expect(storage.load("dup")?.description).toBe("fresh");
      expect(storage.list()).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(paths.rootDir, { recursive: true, force: true });
    }
  });

  test("locationsOf reports every destination holding the name, home-namespaced included", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-save-where-"));
    const paths = workflowProjectPaths(cwd);
    try {
      const storage = createWorkflowStorage(cwd);
      expect(storage.locationsOf("nope")).toEqual([]);

      storage.save({ name: "here", description: "d", script: SCRIPT, location: "project" }, "project");
      expect(storage.locationsOf("here")).toEqual(["project"]);

      storage.save({ name: "here", description: "d", script: SCRIPT, location: "user" }, "user");
      expect(storage.locationsOf("here")).toEqual(["project", "user"]);
      storage.delete("here");

      // A home-namespaced copy still counts as occupying "project".
      mkdirSync(paths.homeSavedDir, { recursive: true });
      writeFileSync(
        join(paths.homeSavedDir, "legacy.js"),
        'export const meta = {\n  name: "legacy",\n  description: "d",\n}\n\nconst body = "s";\n',
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
