import {
  CapabilityClassification,
  CapabilitySupport,
  DiscoveryPlacement,
  WorkflowAuthoringProtection,
} from "./enums.js";
import { WORKFLOW_CAPABILITY_DEFINITION } from "./workflow-capability-contract.js";
import { COMPREHENSION_SCENARIOS } from "./workflow-comprehension.js";

/** Exact installed guidance location retained for an authoring surface without model evidence. */
export interface ProtectedGuidanceSurface {
  path: string;
  anchor?: string;
  requiredText?: string;
}

/** Evidence and optimization policy for one stable workflow authoring surface. */
export interface WorkflowAuthoringCoverageEntry {
  id: string;
  kind: string;
  reference: { path: string; anchor?: string };
  example?: string;
  behaviorEvidence: readonly string[];
  comprehensionScenarios: readonly string[];
  protection: WorkflowAuthoringProtection;
  protectedGuidance: readonly ProtectedGuidanceSurface[];
}

/** Scenario identifiers that release checks may accept as provider-backed evidence. */
export const WORKFLOW_COMPREHENSION_SCENARIO_IDS = COMPREHENSION_SCENARIOS.map(({ id }) => id);

/** Mixed guidance files that require explicit acceptance while behavioral coverage remains partial. */
export const WORKFLOW_AUTHORING_FROZEN_FILES = [
  {
    path: "skills/workflow-authoring/SKILL.md",
    sha256: "45a21c3f4685715fb14d42698e0c64633bd03723fcc6cfc65b00ea5d58c1c540",
  },
  {
    path: "skills/workflow-authoring/references/runtime.md",
    sha256: "7fe6f4779dcfcf35c8f180fcec2b59b1767b6a8fd7a418f38127c80a82f61d3a",
  },
  {
    path: "skills/workflow-authoring/references/helpers.md",
    sha256: "d8a4b6020e3a94e3f1d47fb7d79f7cf217ca9c025e2e447acce4f42bbb79f524",
  },
  {
    path: "skills/workflow-authoring/references/specialized-helpers.md",
    sha256: "4c188cc8e687b8262c66ff1f1db18d457230dfef29a1f5b57c368b8403d7f0d3",
  },
  {
    path: "skills/workflow-authoring/references/lifecycle.md",
    sha256: "1eca3de7104308df890c268953cb25728ba2d20c0d3f0a17c1e568cafa6477c0",
  },
  {
    path: "skills/workflow-authoring/references/pattern-selection.md",
    sha256: "c417cfb9400634acf11814e5b4dcc0d9ab4c8a5748a52adde793d9037417997a",
  },
  {
    path: "skills/workflow-authoring/references/focused-recipes.md",
    sha256: "30ee538f6897636937af7e226f47b4861c356fc514bcc5cd4caa34e1c12b9e16",
  },
  {
    path: "skills/workflow-authoring/references/registry-ownership.md",
    sha256: "38d7ccff706f635fa047b5f90efd6636946310e03f577159547f751e19ed0a2f",
  },
  {
    path: "skills/workflow-authoring/references/review.md",
    sha256: "92fd2c90a6763e32dec6a460e99da9f22bd49ef53d50bdd8e2aeb2356b57b86b",
  },
  {
    path: "skills/workflow-authoring/references/debugging.md",
    sha256: "4df93d8722606960686f22d89ba88672300ae1e962176606840ec7362de32c0f",
  },
  {
    path: "skills/workflow-authoring/examples/classify-and-act.js",
    sha256: "41e9c66bb5a83bc4d48d745c7069ba11458a45a91d634d27f1b225a5e4732ef4",
  },
  {
    path: "skills/workflow-authoring/examples/tournament.js",
    sha256: "2b48f6311c776f1e2eb2e479d143c31556831f1aa30400a057feee2c871e9622",
  },
  {
    path: "skills/workflow-authoring/examples/validated-gate.js",
    sha256: "0d93911fe0db0d2eb4619220a59f7d68f12ea86673d6394b03596425a7899830",
  },
] as const;

const RUNTIME_PATH = "skills/workflow-authoring/references/runtime.md";
const SPECIALIZED_HELPERS_PATH = "skills/workflow-authoring/references/specialized-helpers.md";
const LIFECYCLE_PATH = "skills/workflow-authoring/references/lifecycle.md";
const PATTERN_PATH = "skills/workflow-authoring/references/pattern-selection.md";
const RECIPE_PATH = "skills/workflow-authoring/references/focused-recipes.md";
const SKILL_PATH = "skills/workflow-authoring/SKILL.md";
const WRITE_EDIT_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **编写或编辑：** 从[运行时](references/runtime.md)开始。拓扑参考[模式选择](references/pattern-selection.md)，限制或恢复参考[生命周期](references/lifecycle.md)，对应场景参考[场景配方](references/focused-recipes.md)。",
};
const HELPER_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **helper 任务：** 仅用于 `verify` 或 `judgePanel` 时阅读[质量 helper](references/quality-helpers.md)，仅用于 `retry` 时阅读[重试 helper](references/retry-helper.md)，仅用于 `completenessCheck`、`loopUntilDry`、`gate` 或 `checkpoint` 时阅读[专用 helper](references/specialized-helpers.md)。",
};
const ROUTING_ROUTE: ProtectedGuidanceSurface = {
  path: SKILL_PATH,
  requiredText:
    "- **路由：** 使用 `model`、`tier`、阶段模型或 `agentType` 之前，先阅读[注册表归属](references/registry-ownership.md)；仅当上下文提供环境专用名称时才使用它们。",
};

const CAPABILITY_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  "workflow.runtime.agent": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
  "workflow.runtime.parallel": [
    "quick-write",
    "full-write",
    "coverage-fan-out-synthesize",
    "coverage-generate-filter",
    "coverage-judge-panel",
  ],
  "workflow.runtime.workflow": ["full-edit"],
  "workflow.runtime.verify": ["full-review"],
  "workflow.runtime.judgePanel": ["coverage-judge-panel"],
  "workflow.runtime.retry": ["full-retry"],
  "workflow.runtime.phase": ["full-edit"],
  "workflow.script.metadata": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
  "workflow.script.return-value": WORKFLOW_COMPREHENSION_SCENARIO_IDS,
};

const FROZEN_GUIDANCE_BY_CAPABILITY: Readonly<Record<string, readonly ProtectedGuidanceSurface[]>> = {
  "workflow.runtime.pipeline": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "`pipeline()` 对每条目按顺序运行阶段，同时条目并发推进。每个阶段接收 `(previousValue, originalItem, index)`，并把 `null` 转发给下一阶段，因此先防护缺失覆盖。",
    },
  ],
  "workflow.runtime.loopUntilDry": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` 从零开始。默认值：`JSON.stringify` 键、两轮干轮、50 轮。null、非数组与仅重复的轮次计为干轮。token 预算或智能体上限耗尽时，返回部分数组而不带终止原因；在 helper 之外保留失败轮次的身份与停止状态。",
    },
  ],
  "workflow.runtime.completenessCheck": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`completenessCheck(args, results)` | 返回 `{ complete, missing? }` 或可恢复的 `null`。评审者只看到前 4,000 个序列化字符，因此更大的证据要分块或摘要。把裁决视为建议性的。",
    },
  ],
  "workflow.runtime.gate": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`gate(thunk, validator, { attempts })` | 以初始 `undefined` 反馈与从零开始的尝试次数调用 `thunk(feedback, attempt)`。`validator(value)` 同步或异步返回 `{ ok, feedback? }`；不接受裸布尔值。默认三次尝试。返回 `{ ok, value, attempts }`，耗尽时包含最后的值。",
    },
  ],
  "workflow.runtime.checkpoint": [
    {
      path: SPECIALIZED_HELPERS_PATH,
      requiredText:
        "`checkpoint(prompt, options?)` | 记账人类/默认决策。只有前台确认与有文档的无头行为可用；输入、选择与超时仅为声明。",
    },
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "工作流调用默认在后台运行，而后台工作流是无头的：它们无法显示检查点确认。",
    },
  ],
  "workflow.runtime.consult": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "自动应用上限 5 次：超限回落 `waiting_consult` 等人工答复。",
    },
  ],
  "workflow.runtime.log": [
    { path: SKILL_PATH, requiredText: "新代码使用 `log()`；`console` 仅用于兼容。" },
  ],
  "workflow.runtime.args": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "运行时提供 `agent`、`parallel`、`pipeline`、`workflow`、质量/控制 helper、`consult`、`phase`、`log`、`args`、`cwd`、受限的 `process.cwd()` 与 `budget`。",
    },
  ],
  "workflow.runtime.cwd": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "运行时提供 `agent`、`parallel`、`pipeline`、`workflow`、质量/控制 helper、`consult`、`phase`、`log`、`args`、`cwd`、受限的 `process.cwd()` 与 `budget`。",
    },
  ],
  "workflow.runtime.process": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "运行时提供 `agent`、`parallel`、`pipeline`、`workflow`、质量/控制 helper、`consult`、`phase`、`log`、`args`、`cwd`、受限的 `process.cwd()` 与 `budget`。",
    },
  ],
  "workflow.runtime.budget": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "token 与阶段预算是调用前的软门禁。花费在智能体结束后才落账，因此并发工作可能超支。",
    },
  ],
  "workflow.runtime.console": [
    { path: SKILL_PATH, requiredText: "新代码使用 `log()`；`console` 仅用于兼容。" },
  ],
  "workflow.tool-input.script": [{ path: RUNTIME_PATH, anchor: "script-envelope" }],
  "workflow.tool-input.args": [
    {
      path: LIFECYCLE_PATH,
      requiredText: "时间戳、随机性与外部决策通过 `args` 传递。",
    },
  ],
  "workflow.tool-input.background": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "工作流调用默认在后台运行，而后台工作流是无头的：它们无法显示检查点确认。",
    },
  ],
  "workflow.tool-input.maxAgents": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "为 `maxAgents`、`concurrency` 与 `agentRetries` 设置与工作匹配的有限界限；在脚本内限制循环与语义重试。",
    },
  ],
  "workflow.tool-input.concurrency": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "为 `maxAgents`、`concurrency` 与 `agentRetries` 设置与工作匹配的有限界限；在脚本内限制循环与语义重试。",
    },
  ],
  "workflow.tool-input.agentRetries": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "为 `maxAgents`、`concurrency` 与 `agentRetries` 设置与工作匹配的有限界限；在脚本内限制循环与语义重试。",
    },
  ],
  "workflow.tool-input.agentTimeoutMs": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "将调用级 `agentTimeoutMs` 与 `tokenBudget` 视为可选加入的用户约束，而非预防性默认值。",
    },
  ],
  "workflow.tool-input.tokenBudget": [
    {
      path: LIFECYCLE_PATH,
      requiredText: "除非用户提供了上限或明确要求你选择，否则省略 `tokenBudget`。",
    },
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "token 与阶段预算是调用前的软门禁。花费在智能体结束后才落账，因此并发工作可能超支。",
    },
  ],
  "workflow.tool-input.resumeFromRunId": [
    {
      path: LIFECYCLE_PATH,
      requiredText:
        "恢复只重放已记账调用中最长的不变前缀。一旦某个调用是新的、已变更或不可用，该调用与其后的所有调用都会实时执行。",
    },
  ],
  "workflow.script.determinism": [
    {
      path: SKILL_PATH,
      requiredText:
        "编写不含导入或文件系统模块的纯 JavaScript。通过 `args` 传递不确定性；`Date.now()`、`Math.random()` 与无参 `new Date()` 不可用。",
    },
  ],
  "workflow.compat.markdown-fences": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "标记为 `supported` 的生成条目是编写 API。`console` 与整篇脚本的 Markdown 围栏仅用于兼容。",
    },
  ],
  "workflow.dynamic.model-routes": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "仅在上下文提供名称与用途时才使用精确 `model`、非标准 `tier` 或 `agentType`。",
    },
  ],
  "workflow.dynamic.agent-types": [
    {
      path: RUNTIME_PATH,
      requiredText:
        "仅在上下文提供名称与用途时才使用精确 `model`、非标准 `tier` 或 `agentType`。",
    },
  ],
};

/** Stable orchestration-pattern identifiers covered by the authoring inventory. */
export const WORKFLOW_AUTHORING_PATTERN_IDS = [
  "workflow.pattern.classify-and-act",
  "workflow.pattern.fan-out-and-synthesize",
  "workflow.pattern.adversarial-verification",
  "workflow.pattern.generate-and-filter",
  "workflow.pattern.tournament",
  "workflow.pattern.loop-until-done",
] as const;

/** Stable focused-recipe identifiers covered by the authoring inventory. */
export const WORKFLOW_AUTHORING_RECIPE_IDS = [
  "workflow.recipe.phased-budgets",
  "workflow.recipe.saved-nested-workflows",
  "workflow.recipe.bounded-semantic-retry",
  "workflow.recipe.validator-feedback",
  "workflow.recipe.structured-output",
] as const;

const PATTERN_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  {
    id: "workflow.pattern.classify-and-act",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/classify-and-act.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: PATTERN_PATH,
        requiredText:
          "| 异构条目需要不同处理 | 分类后行动 | 先完成全部分类再做路由行动；按条目 ID 记录分类与行动失败 | [改编](../examples/classify-and-act.js) |",
      },
    ],
  },
  {
    id: "workflow.pattern.fan-out-and-synthesize",
    kind: "pattern",
    reference: { path: PATTERN_PATH, anchor: "fan-out-and-synthesize" },
    example: "skills/workflow-authoring/examples/fan-out-and-synthesize.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["coverage-fan-out-synthesize"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.adversarial-verification",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/adversarial-verification.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-review"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.generate-and-filter",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/generate-and-filter.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["coverage-generate-filter"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.pattern.tournament",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/tournament.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: PATTERN_PATH,
        requiredText:
          "| 两两比较优于绝对评分 | 锦标赛 | 让 JavaScript 运行有界的括号与轮空；智能体只比较一对；记录比赛失败 | [改编](../examples/tournament.js) |",
      },
    ],
  },
  {
    id: "workflow.pattern.loop-until-done",
    kind: "pattern",
    reference: { path: PATTERN_PATH },
    example: "skills/workflow-authoring/examples/loop-until-done.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-loop"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
];

const RECIPE_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  {
    id: "workflow.recipe.phased-budgets",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/phased-budgets.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-edit"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.saved-nested-workflows",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/saved-nested-workflows.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-edit"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.bounded-semantic-retry",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/bounded-semantic-retry.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-retry"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
  {
    id: "workflow.recipe.validator-feedback",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/validated-gate.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts"],
    comprehensionScenarios: [],
    protection: WorkflowAuthoringProtection.GUIDANCE_FROZEN,
    protectedGuidance: [
      WRITE_EDIT_ROUTE,
      {
        path: RECIPE_PATH,
        requiredText:
          "| 校验器反馈 | 遵循[专用 helper](specialized-helpers.md)中 `gate()` 的精确回调。返回门禁结果与尝试账本，使反馈与耗尽保持可见。 | [已验证门禁](../examples/validated-gate.js) |",
      },
    ],
  },
  {
    id: "workflow.recipe.structured-output",
    kind: "recipe",
    reference: { path: RECIPE_PATH },
    example: "skills/workflow-authoring/examples/structured-output.js",
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-comprehension.test.ts"],
    comprehensionScenarios: ["full-write", "full-debug", "full-loop", "full-retry"],
    protection: WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
    protectedGuidance: [],
  },
];

const HELPER_CAPABILITY_IDS = new Set([
  "workflow.runtime.verify",
  "workflow.runtime.judgePanel",
  "workflow.runtime.completenessCheck",
  "workflow.runtime.loopUntilDry",
  "workflow.runtime.retry",
  "workflow.runtime.gate",
  "workflow.runtime.checkpoint",
]);

const CONTRACT_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = WORKFLOW_CAPABILITY_DEFINITION.capabilities
  .filter(({ discovery, support }) => discovery !== DiscoveryPlacement.NONE && support !== CapabilitySupport.INTERNAL)
  .map((capability) => {
    const comprehensionScenarios = CAPABILITY_SCENARIOS[capability.id] ?? [];
    const frozenGuidance = FROZEN_GUIDANCE_BY_CAPABILITY[capability.id] ?? [];
    const route =
      capability.classification === CapabilityClassification.DYNAMIC_REFERENCE
        ? ROUTING_ROUTE
        : HELPER_CAPABILITY_IDS.has(capability.id)
          ? HELPER_ROUTE
          : WRITE_EDIT_ROUTE;
    const protectedGuidance = comprehensionScenarios.length > 0 ? [] : [...frozenGuidance, route];
    return {
      id: capability.id,
      kind: capability.classification,
      reference: capability.staticReference ?? { path: "skills/workflow-authoring/references/capabilities.md" },
      behaviorEvidence: capability.behaviorEvidence,
      comprehensionScenarios,
      protection:
        comprehensionScenarios.length > 0
          ? WorkflowAuthoringProtection.BEHAVIORALLY_COVERED
          : WorkflowAuthoringProtection.GUIDANCE_FROZEN,
      protectedGuidance,
    };
  });

/** Complete release-gated inventory of behavioral coverage and frozen authoring guidance. */
export const WORKFLOW_AUTHORING_COVERAGE: readonly WorkflowAuthoringCoverageEntry[] = [
  ...CONTRACT_COVERAGE,
  ...PATTERN_COVERAGE,
  ...RECIPE_COVERAGE,
];
