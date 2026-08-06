import { describe, expect, test } from "bun:test";
import {
  BUILTIN_WORKFLOWS,
  findBuiltinWorkflow,
} from "../src/builtin-workflows.js";
import { parseWorkflowScript } from "../src/workflow.js";

describe("built-in workflow preview scripts", () => {
  test("every descriptor exposes a parseable previewScript", () => {
    expect(BUILTIN_WORKFLOWS.length).toBe(5);
    for (const builtin of BUILTIN_WORKFLOWS) {
      expect(builtin.previewScript, `${builtin.name} previewScript empty`).not.toBe("");
      const parsed = parseWorkflowScript(builtin.previewScript);
      expect(parsed.meta.name, `${builtin.name} meta`).toBeTruthy();
      expect(parsed.meta.description, `${builtin.name} meta description`).toBeTruthy();
    }
  });

  test("parameter-free generators produce identical resolve and preview scripts", () => {
    for (const name of ["deep-research", "adversarial-review", "code-review"] as const) {
      const builtin = findBuiltinWorkflow(name)!;
      const resolved = builtin.resolve("/tmp", { question: "q", task: "t", diff: "d" });
      expect(resolved.script, `${name} resolve/preview drift`).toBe(builtin.previewScript);
    }
  });

  test("parameterized generators mark placeholders in the preview", () => {
    const multi = findBuiltinWorkflow("multi-perspective")!;
    expect(multi.previewScript).toContain("<topic>");
    const audit = findBuiltinWorkflow("codebase-audit")!;
    expect(audit.previewScript).toContain("<scope>");
    expect(audit.previewScript).toContain("<check 1>");
  });
});
