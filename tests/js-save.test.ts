import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { parseWorkflowScript } from "../src/workflow.js";

const BODY = `const found = await agent("list files", { schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] } });\nreturn { found };`;
// save() requires a real runnable module (meta header first, exactly what
// parseWorkflowScript validates), so the fixture is a complete script.
const SCRIPT = `export const meta = { name: "audit", description: "审计路由" }\n${BODY}`;

describe("saved workflow js format", () => {
  test("save writes a plain .js file with a readable meta block", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-save-"));
    try {
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "audit", description: "审计路由", script: SCRIPT, location: "project" }, "project");
      const raw = readFileSync(join(cwd, ".omp", "workflows", "saved", "audit.js"), "utf8");
      expect(raw).toContain('export const meta = {\n  name: "audit"');
      expect(raw).toContain('description: "审计路由"');
      expect(raw).toContain(BODY);
      expect(raw).not.toContain('"script"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("load parses meta + body back into a SavedWorkflow", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-load-"));
    try {
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "audit", description: "审计路由", script: SCRIPT, location: "project" }, "project");
      const loaded = storage.load("audit");
      expect(loaded?.name).toBe("audit");
      expect(loaded?.description).toBe("审计路由");
      expect(loaded?.location).toBe("project");
      // `script` is the complete runnable module (meta header + body) — the
      // execution path (registerSavedWorkflow / loadSavedWorkflow) feeds it
      // straight into parseWorkflowScript, so body-only would break running.
      // parseWorkflowScript's body keeps the newline that follows the meta
      // statement, so the file carries two blank lines before the body — the
      // established task-2 format (verified in the web-server save path too).
      const expectedScript = `export const meta = {\n  name: "audit",\n  description: "审计路由",\n}\n\n\n${BODY}\n`;
      expect(loaded?.script).toBe(expectedScript);
      // Proof the execution path works: the loaded script parses back to a
      // meta whose name matches the loaded workflow.
      if (loaded) {
        expect(parseWorkflowScript(loaded.script).meta.name).toBe(loaded.name);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("list only sees .js files — legacy .json is ignored", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-list-"));
    try {
      const { writeFileSync, mkdirSync } = require("node:fs");
      mkdirSync(join(cwd, ".omp", "workflows", "saved"), { recursive: true });
      writeFileSync(join(cwd, ".omp", "workflows", "saved", "legacy.json"), '{"name":"legacy","script":"x"}');
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "fresh", description: "新", script: SCRIPT, location: "project" }, "project");
      expect(storage.list().map((w) => w.name)).toEqual(["fresh"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("round-trip preserves meta phases and model", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-phases-"));
    try {
      const storage = createWorkflowStorage(cwd);
      const phased = `export const meta = { name: "staged", description: "分阶段", phases: [{ title: "A" }, { title: "B" }], model: "x" }\nawait phase("A");\nawait phase("B");\n`;
      storage.save({ name: "staged", description: "分阶段", script: phased, location: "project" }, "project");
      const loaded = storage.load("staged");
      expect(loaded).not.toBeNull();
      if (loaded) {
        const parsed = parseWorkflowScript(loaded.script);
        expect(parsed.meta.phases).toHaveLength(2);
        expect(parsed.meta.phases?.[0]?.title).toBe("A");
        expect(parsed.meta.phases?.[1]?.title).toBe("B");
        expect(parsed.meta.model).toBe("x");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an empty description still round-trips (falls back to the name)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-empty-desc-"));
    try {
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "bare", description: "", script: SCRIPT, location: "project" }, "project");
      const loaded = storage.load("bare");
      expect(loaded).not.toBeNull();
      expect(loaded?.name).toBe("bare");
      // validateMeta on load rejects an empty description, so save() writes
      // the name instead — the file stays readable (no dead artifact).
      expect(loaded?.description).toBe("bare");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("save rejects a script that fails validation (Date.now in body)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-bad-"));
    try {
      const storage = createWorkflowStorage(cwd);
      const bad = `export const meta = { name: "bad", description: "d" }\nconst t = Date.now();\n`;
      expect(() =>
        storage.save({ name: "bad", description: "d", script: bad, location: "project" }, "project"),
      ).toThrow();
      // The save was rejected, not silently mangled into a double-meta file.
      expect(storage.load("bad")).toBeNull();
      expect(storage.list()).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
