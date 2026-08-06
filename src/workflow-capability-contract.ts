import packageJson from "../package.json" with { type: "json" };
import {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  DiagnosticSeverity,
  DiscoveryPlacement,
} from "./enums.js";
import { WorkflowCapabilityContractError } from "./errors.js";

/** Re-exported capability domains used by contract consumers. */
export {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  DiagnosticSeverity,
  DiscoveryPlacement,
} from "./enums.js";

/** Version marker for behavior present at or after a release. */
export interface PresentAtVersion {
  kind: "present-at";
  version: string;
}

/** One named option and the facts safe to publish about it. */
export interface OptionDescriptor {
  name: string;
  type: string;
  optional: boolean;
  default: string | null;
  constraints: readonly string[];
  dynamicReference: "model-routes" | "agent-types" | null;
}

/** Reusable option group referenced by capability descriptors. */
export interface OptionShape {
  id:
    | "agent-options"
    | "checkpoint-options"
    | "consult-options"
    | "phase-options"
    | "verify-options"
    | "judge-panel-options"
    | "loop-until-dry-options"
    | "retry-options"
    | "gate-options";
  options: readonly OptionDescriptor[];
}

/** Authoritative declaration of one workflow capability and its evidence. */
export interface CapabilityDescriptor {
  id: `workflow.${string}`;
  label: string;
  classification: CapabilityClassification;
  support: CapabilitySupport;
  discovery: DiscoveryPlacement;
  origin: CapabilityOrigin;
  lifecycle: PresentAtVersion;
  signature: string | null;
  optionShape: OptionShape["id"] | null;
  constraints: readonly string[];
  enforcementOwner: string;
  runtimeBinding: { global: string; implementation: string; allowsUndefined?: true } | null;
  behaviorEvidence: readonly string[];
  staticReference: { path: string; anchor: string } | null;
  dynamicReference: "model-routes" | "agent-types" | null;
}

/** Ownership and item shape for a live catalogue that static docs must not embed. */
export interface DynamicReferenceDescriptor {
  id: "model-routes" | "agent-types";
  owner: "model-tier-config" | "agent-registry";
  itemShape: string;
  connection: string;
  items?: never;
}

/** Versioned plain-data source for runtime assembly and generated documentation. */
export interface WorkflowCapabilityDefinition {
  versions: {
    extension: string;
    format: PresentAtVersion;
    content: PresentAtVersion;
  };
  optionShapes: readonly OptionShape[];
  capabilities: readonly CapabilityDescriptor[];
  dynamicReferences: readonly DynamicReferenceDescriptor[];
}

/** Machine-readable disagreement between the contract and an observed surface. */
export interface CapabilityDiagnostic {
  code:
    | "MISSING_RUNTIME_IMPLEMENTATION"
    | "UNDECLARED_RUNTIME_IMPLEMENTATION"
    | "DECLARED_GLOBAL_UNOBSERVED"
    | "OBSERVED_GLOBAL_UNDECLARED"
    | "INVALID_CAPABILITY_DEFINITION";
  severity: DiagnosticSeverity;
  subject: string;
  message: string;
}

/** Re-exported contract failure type retained for existing consumers. */
export { WorkflowCapabilityContractError } from "./errors.js";

/** Runtime globals assembled from declared implementations plus non-fatal diagnostics. */
export interface RuntimeBindingAssembly {
  globals: Readonly<Record<string, unknown>>;
  diagnostics: readonly CapabilityDiagnostic[];
}

/** Project-owned implementations required to assemble the workflow VM context. */
export interface WorkflowRuntimeImplementations {
  agent: unknown;
  parallel: unknown;
  pipeline: unknown;
  workflow: unknown;
  verify: unknown;
  judgePanel: unknown;
  loopUntilDry: unknown;
  completenessCheck: unknown;
  retry: unknown;
  gate: unknown;
  checkpoint: unknown;
  consult: unknown;
  log: unknown;
  phase: unknown;
  args: unknown;
  cwd: unknown;
  process: unknown;
  budget: unknown;
  console: unknown;
}

/** Exact static projection of one capability for generated references. */
export interface StaticCapabilityFact {
  id: string;
  label: string;
  classification: CapabilityClassification;
  support: CapabilitySupport;
  signature: string | null;
  options: OptionShape | null;
  constraints: readonly string[];
  reference: string | null;
  dynamicReference: DynamicReferenceDescriptor | null;
}

/** Runtime implementations or observed globals used for drift diagnostics. */
export interface AlignmentEvidence {
  suppliedImplementations?: Readonly<Record<string, unknown>>;
  observedProjectGlobals?: readonly string[];
}

/** Validated capability contract with runtime, publication, and alignment projections. */
export interface WorkflowCapabilityContract {
  readonly definition: WorkflowCapabilityDefinition;
  assembleRuntimeBindings(implementations: Readonly<Record<string, unknown>>): RuntimeBindingAssembly;
  projectStaticReferenceFacts(): readonly StaticCapabilityFact[];
  diagnoseAlignment(evidence: AlignmentEvidence): readonly CapabilityDiagnostic[];
}

const REFERENCE_PATH = "skills/workflow-authoring/references/capability-details.md";
const PRESENT_AT: PresentAtVersion = { kind: "present-at", version: packageJson.version };
const noOptions = [] as const;

const option = (
  name: string,
  type: string,
  optional: boolean,
  defaultValue: string | null = null,
  constraints: readonly string[] = noOptions,
  dynamicReference: OptionDescriptor["dynamicReference"] = null,
): OptionDescriptor => ({ name, type, optional, default: defaultValue, constraints, dynamicReference });

const AGENT_OPTIONS: OptionShape = {
  id: "agent-options",
  options: [
    option("label", "string", true, "由阶段与调用次数推导"),
    option("phase", "string", true, "当前阶段"),
    option("schema", "plain JSON Schema", true),
    option("model", "string", true, null, ["优先级最高的精确模型选择器"]),
    option("tier", "string", true, null, ["已配置的路由名"], "model-routes"),
    option("isolation", '"worktree"', true),
    option("agentType", "string", true, null, ["必须来自给定上下文"], "agent-types"),
    option("timeoutMs", "number | null", true, "运行超时；null 表示禁用"),
    option("retries", "number", true, "运行重试次数", ["有限值向下取整并限制在 0..3"]),
  ],
};
const CHECKPOINT_OPTIONS: OptionShape = {
  id: "checkpoint-options",
  options: [
    option("default", "unknown", true, "无 UI 且省略时为 true"),
    option("headless", '"default" | "abort"', true, '"default"'),
    option("kind", '"confirm" | "input" | "select"', true, '"confirm"'),
    option("choices", "string[]", true),
    option("timeoutMs", "number", true),
  ],
};
const CONSULT_OPTIONS: OptionShape = {
  id: "consult-options",
  options: [
    option("to", '"agent" | "main"', true, '"agent"'),
    option("agent", "string", true),
    option("apply", '"auto" | "confirm"', true, '"auto"'),
    option("timeoutMs", "number", true),
  ],
};
const PHASE_OPTIONS: OptionShape = {
  id: "phase-options",
  options: [option("budget", "number", true, null, ["调用前的正向软性 token 门"])],
};
const VERIFY_OPTIONS: OptionShape = {
  id: "verify-options",
  options: [
    option("reviewers", "number", true, "2", ["作者应提供有限整数；运行时将低于 1 的值限制为 1"]),
    option("threshold", "number", true, "0.5"),
    option("lens", "string | string[]", true),
  ],
};
const JUDGE_PANEL_OPTIONS: OptionShape = {
  id: "judge-panel-options",
  options: [
    option("judges", "number", true, "3", ["作者应提供有限整数；运行时将低于 1 的值限制为 1"]),
    option("rubric", "string", true, '"overall quality and correctness"'),
  ],
};
const LOOP_UNTIL_DRY_OPTIONS: OptionShape = {
  id: "loop-until-dry-options",
  options: [
    option("round", "(roundIndex: number) => unknown[] | Promise<unknown[]>", false),
    option("key", "(item: unknown) => string", true, "JSON.stringify"),
    option("consecutiveEmpty", "number", true, "2", [
      "作者应提供有限整数；运行时将低于 1 的值限制为 1",
    ]),
    option("maxRounds", "number", true, "50", ["作者应提供有限正整数"]),
  ],
};
const RETRY_OPTIONS: OptionShape = {
  id: "retry-options",
  options: [
    option("attempts", "number", true, "3", [
      "作者必须提供有限整数；运行时将低于 1 的值限制为 1",
    ]),
    option("until", "(result: unknown) => boolean", true, "省略时接受第一个结果", [
      "必须为同步；异步校验请使用 gate",
    ]),
  ],
};
const GATE_OPTIONS: OptionShape = {
  id: "gate-options",
  options: [
    option("attempts", "number", true, "3", [
      "作者必须提供有限整数；运行时将低于 1 的值限制为 1",
    ]),
  ],
};

interface RuntimeDescriptorOptions {
  signature?: string;
  discovery?: DiscoveryPlacement;
  support?: CapabilitySupport;
  optionShape?: OptionShape["id"];
  constraints?: readonly string[];
  evidence?: readonly string[];
  allowsUndefined?: true;
}

const runtimeGlobal = (name: string, options: RuntimeDescriptorOptions = {}): CapabilityDescriptor => ({
  id: `workflow.runtime.${name}`,
  label: name,
  classification: CapabilityClassification.RUNTIME_GLOBAL,
  support: options.support ?? CapabilitySupport.SUPPORTED,
  discovery: options.discovery ?? DiscoveryPlacement.COMPACT_GUIDANCE,
  origin: CapabilityOrigin.PROJECT,
  lifecycle: PRESENT_AT,
  signature: options.signature ?? name,
  optionShape: options.optionShape ?? null,
  constraints: options.constraints ?? noOptions,
  enforcementOwner: "runWorkflow context assembly",
  runtimeBinding: {
    global: name,
    implementation: name,
    ...(options.allowsUndefined ? { allowsUndefined: true as const } : {}),
  },
  behaviorEvidence: options.evidence ?? ["tests/workflow-runtime.test.ts"],
  staticReference: { path: REFERENCE_PATH, anchor: name.toLowerCase() },
  dynamicReference: null,
});

const toolInput = (
  name: string,
  signature: string,
  constraints: readonly string[] = noOptions,
): CapabilityDescriptor => ({
  id: `workflow.tool-input.${name}`,
  label: name,
  classification: CapabilityClassification.WORKFLOW_TOOL_INPUT,
  support: CapabilitySupport.SUPPORTED,
  discovery: DiscoveryPlacement.COMPACT_GUIDANCE,
  origin: CapabilityOrigin.TOOL_ADAPTER,
  lifecycle: PRESENT_AT,
  signature,
  optionShape: null,
  constraints,
  enforcementOwner: "workflowToolSchema and createWorkflowTool",
  runtimeBinding: null,
  behaviorEvidence: ["tests/workflow-tool.test.ts"],
  staticReference: { path: REFERENCE_PATH, anchor: `tool-input-${name.toLowerCase()}` },
  dynamicReference: null,
});

const capabilities: readonly CapabilityDescriptor[] = [
  runtimeGlobal("agent", {
    signature: "agent(prompt, options?) => Promise<string | structured value | null>",
    optionShape: "agent-options",
    constraints: [
      "可恢复失败在重试后返回 null；不可恢复失败抛出异常",
      "有界结构化输出修复后仍不符合 schema 属不可恢复，绕过智能体重试",
      "单智能体重试覆盖调用级重试；重试次数向下取整并限制在 0..3",
      "恢复（resume）只重放最长未变化前缀；第一个失配点及之后的每次调用都实时执行",
      "选择器优先级为 显式 model > agentType model > tier > phase model > metadata model > 隐式中档 > 会话默认",
      "显式 model、agentType model、tier 或 phase model 解析到不可用模型时抛出 MODEL_NOT_FOUND 并指明来源（例如 tier 及其解析结果），而不是回退",
      "只有隐式默认中档（未显式请求 model、tier、agentType 或 phase model）在不可用时降级到会话默认，并记录一次运行可见的警告而非抛出异常",
      "worktree 隔离为尽力而为；失败时记录隔离被忽略并继续运行，不使用隔离工作目录",
    ],
    evidence: ["tests/workflow-runtime.test.ts", "tests/agent-registry.test.ts", "tests/structured-output.test.ts"],
  }),
  runtimeGlobal("parallel", {
    signature: "parallel(thunks) => Promise<Array<unknown | null>>",
    constraints: [
      "要求传入函数而非 Promise",
      "结果顺序与输入顺序一致",
      "可恢复的 thunk 失败变为 null；不可恢复失败抛出异常",
    ],
  }),
  runtimeGlobal("pipeline", {
    signature: "pipeline(items, ...stages) => Promise<Array<unknown | null>>",
    constraints: [
      "items 并发运行，每个 item 的各阶段串行",
      "每个阶段接收 previousValue、originalItem 和从零开始的索引",
      "null 阶段结果会传给下一阶段；作者必须显式防护缺失覆盖",
      "可恢复的阶段失败变为 null；不可恢复失败抛出异常",
    ],
  }),
  runtimeGlobal("workflow", {
    signature: "workflow(savedName, childArgs?) => Promise<unknown>",
    constraints: [
      "只允许一层嵌套",
      "共享限流器、计数器、token 记账与 store",
      "嵌套工作流不复用父级的恢复日志",
    ],
    evidence: ["tests/workflow-saved.test.ts", "tests/shared-store.test.ts"],
  }),
  runtimeGlobal("verify", {
    signature:
      "verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string | string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "verify-options",
    constraints: [
      "审阅者失败被省略；成功投票构成 realCount / total 的分母",
      "阈值比较为包含式；无审阅者成功时 real 为 false",
      "多个视角在审阅者之间轮转",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("judgePanel", {
    signature:
      "judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } | undefined>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "judge-panel-options",
    constraints: [
      "失败判定被省略；每个候选分数只对成功判定取平均",
      "无成功判定的候选得 0 分",
      "最高平均分胜出，以稳定输入索引作为平局裁决；空输入返回 undefined",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("loopUntilDry", {
    signature:
      "loopUntilDry(options: { round: (roundIndex: number) => unknown[] | Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "loop-until-dry-options",
    constraints: [
      "roundIndex 从零开始；null、非数组或只含重复项的轮次结果视为空",
      "token 预算或智能体上限耗尽时返回已积累的部分数组，而不是抛出异常",
      "返回数组不报告终止原因是耗尽、maxRounds 还是容量不足",
      "作者必须在辅助函数之外保留失败轮次身份与真实的终止状态",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("completenessCheck", {
    signature:
      "completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } | null>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: [
      "序列化结果证据的前 4,000 个字符才会发送给评判模型",
      "missing 为可选；可恢复的评判模型失败返回 null",
      "依赖咨询性结论前，大型证据集必须分块或摘要",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("retry", {
    signature:
      "retry(thunk: (attempt: number) => unknown | Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "retry-options",
    constraints: [
      "attempt 从零开始，attempts 计 thunk 总调用次数",
      "until 必须同步；返回 Promise 视为真值并接受第一个结果",
      "省略 until 时无论 attempts 多少都接受第一个结果",
      "until(result) 为 true 时停止；耗尽时只返回最后一个结果，不带尝试元数据",
      "覆盖默认值时作者必须提供有限的 attempts 上限",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("gate", {
    signature:
      "gate(thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "gate-options",
    constraints: [
      "首次 thunk 调用时 feedback 为 undefined，之后接收上一次 validator 的 feedback 字符串",
      "thunk 的 attempt 从零开始，返回的 attempts 计数从一开始",
      "validator 返回带真值 ok 属性的对象时接受该值；裸布尔不接受",
      "耗尽时返回 ok false，附带最后一个值与受限的 attempts 计数",
      "覆盖默认值时作者必须提供有限的 attempts 上限",
    ],
    evidence: ["tests/quality-stdlib.test.ts"],
  }),
  runtimeGlobal("checkpoint", {
    signature: "checkpoint(prompt, options?) => Promise<unknown>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "checkpoint-options",
    constraints: [
      "前台 confirm 与 headless 行为已实现；input/select/timeout 仅声明未接通",
      "消耗一个智能体槽位且不消耗 token",
      "记录的答案只在未变化的恢复前缀内重放",
    ],
    evidence: ["tests/checkpoint.test.ts"],
  }),
  runtimeGlobal("consult", {
    signature: "consult(prompt, options?) => Promise<ConsultOutcome>",
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    optionShape: "consult-options",
    constraints: [
      "live 执行抛 CONSULT_PENDING 中断脚本；重放命中返回 journaled 结果",
      "settled:false 结果重放视为 miss，重新挂起",
      "消耗 1 个 agent 槽位且不消耗 token（同 checkpoint）",
      "to: agent 默认 apply: auto（审阅链直接应用）；to: main 或 apply: confirm 走主代理",
    ],
    evidence: ["tests/consult-vm.test.ts", "tests/consult-review-chain.test.ts"],
  }),
  runtimeGlobal("log", { signature: "log(message) => void" }),
  runtimeGlobal("phase", {
    signature: "phase(title, options?) => void",
    optionShape: "phase-options",
    constraints: ["阶段预算为调用前的软性门"],
  }),
  runtimeGlobal("args", { signature: "args: unknown", allowsUndefined: true }),
  runtimeGlobal("cwd", { signature: "cwd: string" }),
  runtimeGlobal("process", { signature: "process: { cwd(): string }" }),
  runtimeGlobal("budget", {
    signature: "budget: { total, spent(), remaining() }",
    constraints: [
      "共享软 token 记账的冻结视图",
      "花费在智能体结束后才累计，因此进行中的工作可能超支",
      "嵌套工作流共享同一记账",
    ],
  }),
  runtimeGlobal("console", {
    signature: "console: { log, info, warn, error }",
    support: CapabilitySupport.COMPATIBILITY,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    constraints: ["新工作流应使用 log()"],
  }),
  toolInput("script", "script?: string", ["未提供 `name` 时必须为原始 JavaScript 工作流源码"]),
  toolInput("name", "name?: string", [
    "先解析项目/用户的已保存工作流，再解析 5 个内置模式之一",
    "与 resumeFromRunId 互斥",
  ]),
  toolInput("args", "args?: unknown"),
  toolInput("background", "background?: boolean = true", [
    "后台工作流为无头模式；需要 checkpoint 显示前台确认时请使用 background false",
  ]),
  toolInput("maxAgents", "maxAgents?: number = 1000", ["默认值，不是产品硬上限"]),
  toolInput("concurrency", "concurrency?: number", ["运行时限制在 1..16"]),
  toolInput("agentRetries", "agentRetries?: number = configured value or 0", ["向下取整并限制在 0..3"]),
  toolInput("agentTimeoutMs", "agentTimeoutMs?: number = configured default or unbounded"),
  toolInput("tokenBudget", "tokenBudget?: number = configured default or unlimited", [
    "调用前的软性门；进行中的工作可能超支",
  ]),
  toolInput("resumeFromRunId", "resumeFromRunId?: string", [
    "用编辑过的脚本恢复此前未完成的运行",
    "未变化的位置调用从缓存重放，直到第一个变化或插入的调用",
    "始终在后台运行",
  ]),
  {
    id: "workflow.script.metadata",
    label: "export const meta",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature:
      "export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, model?: string }",
    optionShape: null,
    constraints: [
      "必须是首条语句",
      "name 与 description 必须为非空字符串",
      "元数据必须使用字面量；字符串拼接与模板插值等表达式会被拒绝",
      "meta 声明是唯一合法的导出，因为其余函数体在 async 函数内执行",
    ],
    enforcementOwner: "parseWorkflowScript",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-parser.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "metadata" },
    dynamicReference: null,
  },
  {
    id: "workflow.script.return-value",
    label: "工作流返回值",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature: "return JSON-serializable data",
    optionShape: null,
    constraints: ["不要返回函数、Promise、循环引用对象、BigInt 或运行时句柄"],
    enforcementOwner: "workflow tool result boundary",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-tool.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "return-value" },
    dynamicReference: null,
  },
  {
    id: "workflow.script.determinism",
    label: "确定性脚本执行",
    classification: CapabilityClassification.SCRIPT_CONTRACT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: [
      "Date.now()、Math.random() 与无参 new Date() 不可用",
      "时间戳与随机性经 args 传入",
    ],
    enforcementOwner: "parseWorkflowScript and VM determinism prelude",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-parser.test.ts", "tests/workflow-runtime.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "determinism" },
    dynamicReference: null,
  },
  {
    id: "workflow.compat.markdown-fences",
    label: "整脚本 Markdown 围栏剥离",
    classification: CapabilityClassification.COMPATIBILITY_BEHAVIOR,
    support: CapabilitySupport.COMPATIBILITY,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.TOOL_ADAPTER,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["为兼容而接受，但不推荐"],
    enforcementOwner: "normalizeWorkflowScript",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-tool.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "compatibility" },
    dynamicReference: null,
  },
  {
    id: "workflow.vm.realm-substrate",
    label: "VM realm JavaScript 基座",
    classification: CapabilityClassification.INTERNAL_SUBSTRATE,
    support: CapabilitySupport.INTERNAL,
    discovery: DiscoveryPlacement.NONE,
    origin: CapabilityOrigin.VM_REALM,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["依赖 Node 版本的全局对象不属于项目持有的工作流 API", "VM 不是安全沙箱"],
    enforcementOwner: "node:vm",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-runtime.test.ts"],
    staticReference: null,
    dynamicReference: null,
  },
  {
    id: "workflow.dynamic.model-routes",
    label: "模型路由",
    classification: CapabilityClassification.DYNAMIC_REFERENCE,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.LIVE_CONFIGURATION,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["动态值不得复制进静态契约数据"],
    enforcementOwner: "model-tier-config",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflows-models-command.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "model-routes" },
    dynamicReference: "model-routes",
  },
  {
    id: "workflow.dynamic.agent-types",
    label: "智能体类型",
    classification: CapabilityClassification.DYNAMIC_REFERENCE,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
    origin: CapabilityOrigin.LIVE_CONFIGURATION,
    lifecycle: PRESENT_AT,
    signature: null,
    optionShape: null,
    constraints: ["动态值不得复制进静态契约数据"],
    enforcementOwner: "agent-registry",
    runtimeBinding: null,
    behaviorEvidence: ["tests/agent-registry.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: "agent-types" },
    dynamicReference: "agent-types",
  },
];

/** Authoritative versioned inventory used by runtime assembly and every static projection. */
export const WORKFLOW_CAPABILITY_DEFINITION: WorkflowCapabilityDefinition = {
  versions: {
    extension: packageJson.version,
    format: { kind: "present-at", version: "1.0.0" },
    content: PRESENT_AT,
  },
  optionShapes: [
    AGENT_OPTIONS,
    CHECKPOINT_OPTIONS,
    CONSULT_OPTIONS,
    PHASE_OPTIONS,
    VERIFY_OPTIONS,
    JUDGE_PANEL_OPTIONS,
    LOOP_UNTIL_DRY_OPTIONS,
    RETRY_OPTIONS,
    GATE_OPTIONS,
  ],
  capabilities,
  dynamicReferences: [
    {
      id: "model-routes",
      owner: "model-tier-config",
      itemShape: "{ name: string; description?: string }",
      connection: "loadModelTierConfig",
    },
    {
      id: "agent-types",
      owner: "agent-registry",
      itemShape: "{ name: string; description?: string }",
      connection: "loadAgentRegistry",
    },
  ],
};

/** Validate and freeze a definition, throwing with diagnostics when its identities or references conflict. */
export function defineWorkflowCapabilityContract(definition: WorkflowCapabilityDefinition): WorkflowCapabilityContract {
  deepFreeze(definition);
  const definitionDiagnostics = validateDefinition(definition);
  if (definitionDiagnostics.length > 0) {
    throw new WorkflowCapabilityContractError("invalid workflow capability definition", definitionDiagnostics);
  }

  const optionShapes = new Map(definition.optionShapes.map((shape) => [shape.id, shape]));
  const dynamicReferences = new Map(definition.dynamicReferences.map((reference) => [reference.id, reference]));
  const bindings = definition.capabilities.flatMap((capability) =>
    capability.runtimeBinding ? [{ ...capability.runtimeBinding }] : [],
  );
  const implementations = new Set(bindings.map((binding) => binding.implementation));
  const globals = new Set(bindings.map((binding) => binding.global));

  const diagnoseAlignment = (evidence: AlignmentEvidence): readonly CapabilityDiagnostic[] => {
    const diagnostics: CapabilityDiagnostic[] = [];
    if (evidence.suppliedImplementations) {
      for (const binding of bindings) {
        if (
          !Object.hasOwn(evidence.suppliedImplementations, binding.implementation) ||
          (evidence.suppliedImplementations[binding.implementation] === undefined && !binding.allowsUndefined)
        ) {
          diagnostics.push({
            code: "MISSING_RUNTIME_IMPLEMENTATION",
            severity: DiagnosticSeverity.ERROR,
            subject: binding.implementation,
            message: `Declared workflow global "${binding.global}" has no supplied implementation "${binding.implementation}".`,
          });
        }
      }
      for (const name of Object.keys(evidence.suppliedImplementations)) {
        if (!implementations.has(name)) {
          diagnostics.push({
            code: "UNDECLARED_RUNTIME_IMPLEMENTATION",
            severity: DiagnosticSeverity.WARNING,
            subject: name,
            message: `Supplied runtime implementation "${name}" is undeclared and was ignored.`,
          });
        }
      }
    }
    if (evidence.observedProjectGlobals) {
      const observed = new Set(evidence.observedProjectGlobals);
      for (const name of globals) {
        if (!observed.has(name)) {
          diagnostics.push({
            code: "DECLARED_GLOBAL_UNOBSERVED",
            severity: DiagnosticSeverity.ERROR,
            subject: name,
            message: `Declared workflow global "${name}" was not observed in the assembled context.`,
          });
        }
      }
      for (const name of observed) {
        if (!globals.has(name)) {
          diagnostics.push({
            code: "OBSERVED_GLOBAL_UNDECLARED",
            severity: DiagnosticSeverity.ERROR,
            subject: name,
            message: `Observed project-owned workflow global "${name}" is undeclared.`,
          });
        }
      }
    }
    return diagnostics;
  };

  return {
    definition,
    assembleRuntimeBindings(supplied) {
      const diagnostics = diagnoseAlignment({ suppliedImplementations: supplied });
      const missing = diagnostics.filter((diagnostic) => diagnostic.code === "MISSING_RUNTIME_IMPLEMENTATION");
      if (missing.length > 0) {
        throw new WorkflowCapabilityContractError(
          `missing declared runtime implementation: ${missing.map((diagnostic) => diagnostic.subject).join(", ")}`,
          diagnostics,
        );
      }
      const assembled: Record<string, unknown> = {};
      for (const binding of bindings) assembled[binding.global] = supplied[binding.implementation];
      return { globals: assembled, diagnostics };
    },
    projectStaticReferenceFacts() {
      return definition.capabilities
        .filter((capability) => capability.staticReference !== null)
        .map((capability) => ({
          id: capability.id,
          label: capability.label,
          classification: capability.classification,
          support: capability.support,
          signature: capability.signature,
          options: capability.optionShape ? (optionShapes.get(capability.optionShape) ?? null) : null,
          constraints: capability.constraints,
          reference: capability.staticReference
            ? `${capability.staticReference.path}#${capability.staticReference.anchor}`
            : null,
          dynamicReference: capability.dynamicReference
            ? (dynamicReferences.get(capability.dynamicReference) ?? null)
            : null,
        }));
    },
    diagnoseAlignment,
  };
}

function validateDefinition(definition: WorkflowCapabilityDefinition): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  const ids = new Set<string>();
  const globals = new Set<string>();
  const runtimeImplementations = new Set<string>();
  const optionShapes = new Set<string>();
  const dynamicReferences = new Set<string>();
  const invalid = (subject: string, message: string) =>
    diagnostics.push({ code: "INVALID_CAPABILITY_DEFINITION", severity: DiagnosticSeverity.ERROR, subject, message });
  for (const shape of definition.optionShapes) {
    if (optionShapes.has(shape.id)) invalid(shape.id, `Duplicate option shape "${shape.id}".`);
    optionShapes.add(shape.id);
  }
  for (const reference of definition.dynamicReferences) {
    if (dynamicReferences.has(reference.id)) invalid(reference.id, `Duplicate dynamic reference "${reference.id}".`);
    dynamicReferences.add(reference.id);
  }
  for (const capability of definition.capabilities) {
    if (ids.has(capability.id)) invalid(capability.id, `Duplicate capability id "${capability.id}".`);
    ids.add(capability.id);
    if (capability.classification === CapabilityClassification.RUNTIME_GLOBAL && !capability.runtimeBinding) {
      invalid(capability.id, "Runtime-global capabilities require a runtime binding.");
    }
    if (capability.runtimeBinding) {
      if (globals.has(capability.runtimeBinding.global)) {
        invalid(capability.runtimeBinding.global, `Duplicate runtime global "${capability.runtimeBinding.global}".`);
      }
      globals.add(capability.runtimeBinding.global);
      if (runtimeImplementations.has(capability.runtimeBinding.implementation)) {
        invalid(
          capability.runtimeBinding.implementation,
          `Duplicate runtime implementation identity "${capability.runtimeBinding.implementation}".`,
        );
      }
      runtimeImplementations.add(capability.runtimeBinding.implementation);
      if (
        capability.classification !== CapabilityClassification.RUNTIME_GLOBAL ||
        capability.origin !== CapabilityOrigin.PROJECT
      ) {
        invalid(capability.id, "Runtime bindings require runtime-global classification and project origin.");
      }
    }
    if (capability.optionShape && !optionShapes.has(capability.optionShape)) {
      invalid(capability.id, `Unknown option shape "${capability.optionShape}".`);
    }
    if (capability.dynamicReference && !dynamicReferences.has(capability.dynamicReference)) {
      invalid(capability.id, `Unknown dynamic reference "${capability.dynamicReference}".`);
    }
  }
  return diagnostics;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Installed validated workflow capability contract. */
export const WORKFLOW_CAPABILITY_CONTRACT = defineWorkflowCapabilityContract(WORKFLOW_CAPABILITY_DEFINITION);
