import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "../src/omp-api.js";
import { fmtElapsed, renderPanel, SPINNER_FRAME_MS, spinnerFrame } from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { NavigatorModel, NavigatorState, renderNavigator } from "../src/workflow-ui.js";
import { saveLocationOptions } from "../src/workflow-saved.js";

/** Identity theme: renders plain text so assertions read the real content. */
const THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

/** Start a run that never settles, so the panel has a live row to render. */
function startStuckRun(cwd: string) {
  const manager = new WorkflowManager({
    cwd,
    agent: {
      run: () => new Promise<string>(() => {}),
    } as never,
  });
  const { runId } = manager.startInBackground(
    `export const meta = { name: "demo_flow", description: "d", phases: [{ title: "work" }] };
await phase("work");
return await agent("go", { label: "w" });`,
  );
  return { manager, runId };
}

describe("compact task panel", () => {
  test("spinner cycles with wall-clock time and elapsed reads like Claude's", () => {
    const first = spinnerFrame(0);
    const second = spinnerFrame(SPINNER_FRAME_MS);
    expect(first).not.toBe(second);
    // Slow enough to read as motion, not a strobe.
    expect(SPINNER_FRAME_MS).toBeGreaterThanOrEqual(150);
    // Uniform-width, non-pictographic glyphs only: no emoji, no starbursts.
    for (let i = 0; i < 12; i++) expect(spinnerFrame(i * SPINNER_FRAME_MS)).toMatch(/^[\u2800-\u28FF]$/);
    expect(spinnerFrame(0, true)).toMatch(/^[|/\-\\]$/);
    // Same instant -> same frame, so every run in the panel animates in sync.
    expect(spinnerFrame(1000)).toBe(spinnerFrame(1000));
    expect(fmtElapsed(45_000)).toBe("45s");
    expect(fmtElapsed(134_000)).toBe("2m14s");
    expect(fmtElapsed(3_780_000)).toBe("1h03m");
  });

  test("renders one animated run line with no list title", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-panel-"));
    try {
      const { manager, runId } = startStuckRun(cwd);
      // Let the run register and reach its first phase.
      await new Promise((r) => setTimeout(r, 50));

      const lines = renderPanel(manager, THEME, 200, Date.parse("2026-01-01T00:00:00Z") + 134_000);
      expect(lines.some((l) => l.includes("Workflows running"))).toBe(false);
      const row = lines[0];
      expect(row).toContain("demo_flow");
      expect(row).toContain("0/1 agents");
      expect(lines[lines.length - 1]).toContain("/workflows");

      manager.stop(runId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("navigator save-location picker", () => {
  test("an open prompt renders both destinations and its own footer", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-nav-"));
    try {
      const manager = new WorkflowManager({ cwd });
      const state = new NavigatorState();
      state.prompt = {
        kind: "saveLocation",
        runId: "run-1",
        name: "demo_flow",
        cursor: 1,
        options: saveLocationOptions(cwd),
        existing: ["project"],
      };

      const out = renderNavigator(state, new NavigatorModel(manager), 100, undefined, 24).join("\n");

      expect(out).toContain("Save /demo_flow to:");
      expect(out).toContain(".omp/workflows/saved");
      expect(out).toContain("~/.omp/workflows/saved");
      // The cursor marks the second option, and the footer is the prompt's own.
      expect(out).toMatch(/›\s+Personal/);
      // Only the destination that already holds this name is flagged.
      expect(out).toMatch(/Project\s+\.omp\/workflows\/saved\s+\(overwrite\)/);
      expect(out).not.toMatch(/Personal.*\(overwrite\)/);
      expect(out).not.toContain("s save");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
