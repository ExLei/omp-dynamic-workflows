import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_INDEX_PATH,
  checkWorkflowCapabilityPublications,
} from "../src/workflow-authoring-reference.js";

describe("capability publications", () => {
  test("generated capability publications are in sync with the contract (no drift)", () => {
    // 能力文档（capabilities.md / capability-details.md）必须与 WORKFLOW_CAPABILITY_CONTRACT
    // 字节级一致，防止改动能力契约后忘记重新生成。
    expect(checkWorkflowCapabilityPublications(process.cwd())).toEqual([]);
  });

  test("stale overrides are detected (non-vacuous proof)", () => {
    // overrides 注入陈旧 capabilities.md 内容，走 actual !== renderWorkflowCapabilityReference()
    // 分支（src/workflow-authoring-reference.ts:107-112）。若检测逻辑日后退化
    // （比较反置 / 恒返回 []），此断言 FAIL，空断言不会静默全绿。
    const stale = checkWorkflowCapabilityPublications(process.cwd(), {
      [CAPABILITY_INDEX_PATH]: "stale capabilities.md content",
    });
    expect(stale).toEqual(["skills/workflow-authoring/references/capabilities.md"]);
  });
});
