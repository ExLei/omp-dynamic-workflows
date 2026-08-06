# omp-dynamic-workflows 改造实现计划（ACP 桥 + 子代理能力同步 + 中文化）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

> **执行状态（2026-08-06 补记）**：任务 1–10 全部实现（分支 `feat/omp-workflows-rework`，
> 后续合并至 main）。回归：`bunx tsc --noEmit` 干净 + `bun test` 93 个全绿。清单见
> `README.md`「开发与验证」。下文复选框是计划期的原始勾选记录，未逐项回填；
> 具体实现以源码与测试为准。

**目标：** fork 改造 omp-dynamic-workflows：补 ACP 会话的 workflow 进 度显示、子代理全量同步主代理工具/技能、MCP 白名单、saved workflows 改 `.js`、Web 与命令/工具文案中文化。

**架构：** 纯插件层改造（不动 omp 核心）。ACP 显示走「无 UI 会话默认同步 + onUpdate 1s 节流 ASCII 帧」（omp ACP 层已把 tool_execution_update 映射为 tool_call_update）；子代理能力用 omp 官方通道（preloadedExtensionPaths/skills/enableMCP 参数 + 创建后 applyActiveToolsByName 过滤 MCP）；配置保持 JSON；saved workflows 用 CC 原版 `.js` 格式（无兼容层）。

**技术栈：** bun、TypeScript、@oh-my-pi/pi-coding-agent（17.2.4，已装全局）、React（web 控制台）。

**规格：** `docs/superpowers/specs/2026-08-06-omp-workflows-plugin-design.md`

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/workflow-paths.ts` | 路径解析 | M1：加 homedir 测试注入 |
| `tests/setup.ts` | 测试预载 | M1：隔离 HOME |
| `tests/save-location.test.ts` | 保存位置 | M1/M2：适配 |
| `src/workflow-saved.ts` | 保存/加载 | M2：`.js` 格式，无兼容 |
| `tests/js-save.test.ts` | `.js` 保存测试 | M2：新增 |
| `src/workflow-settings.ts` | 设置读写 | M3a：新字段 |
| `tests/schema-coercion.test.ts` | 设置校验 | M3a：适配 |
| `src/agent.ts` | 子代理会话 | M3b/M3c：同步分支 + MCP 过滤 |
| `src/acp-bridge.ts` | ACP 检测/帧/节流 | M4a：新增 |
| `src/workflow-tool.ts` | workflow 工具 | M4a：无 UI 默认同步；M5a：描述中文 |
| `src/workflow-commands.ts` | /workflows | M4b：文本退化 + watch 流；M5a：中文 |
| `src/workflow-control-tool.ts` | 控制工具 | M5a：描述中文 |
| `src/*-commands.ts`、`src/builtin-*.ts`、`src/effort-command.ts`、`src/deep-research.ts` 等 | 命令/描述 | M5a：中文 |
| `web/src/**`、`web/index.html` | Web 控制台 | M5b：中文化 |
| `web/dist/` | 构建产物 | M5c：重建提交 |
| `tests/acp-bridge.test.ts` | ACP 帧测试 | M4a：新增 |
| `tests/zh-copy.test.ts` | 文案防回归 | M5c：新增 |

---

### 任务 1（M1）：测试 HOME 隔离

**文件：** 修改 `src/workflow-paths.ts`、`tests/setup.ts`；回归 `tests/save-location.test.ts`

- [ ] **步骤 1：读现状**——`tests/save-location.test.ts` 已隔离 cwd 但 `workflowUserSavedDir()`/`homeSavedDir` 读真实 `homedir()`，被用户真实保存文件污染（本机实测：`mini-test`/`仓库准备`/`仓库重写` 导致 3 个测试失败）。`tests/setup.ts` 当前 637B，内容先读再改。

- [ ] **步骤 2：加注入点**——`src/workflow-paths.ts` 顶部：

```ts
import { homedir } from "node:os";
// ...
/** Test-only: override the machine home for path resolution (bun test isolation). */
let homedirOverride: string | undefined;
export function setHomedirForTests(dir: string | undefined): void {
  homedirOverride = dir;
}
export function workflowHomeDir(): string {
  return join(homedirOverride ?? homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}
```

- [ ] **步骤 3：setup 隔离**——`tests/setup.ts` 追加（保持既有内容）：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHomedirForTests } from "../src/workflow-paths.js";

const testHome = mkdtempSync(join(tmpdir(), "omp-test-home-"));
setHomedirForTests(testHome);
// 进程结束时清理
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
```

- [ ] **步骤 4：回归**——`bun test` 预期：56 个全绿（含之前失败的 3 个 save-location）。

- [ ] **步骤 5：Commit** —— `git commit -m "test: 隔离测试 HOME，修复 save-location 被真实用户数据污染"`

---

### 任务 2（M2）：saved workflows 改 `.js`

**文件：** 修改 `src/workflow-saved.ts`、`tests/save-location.test.ts`；新增 `tests/js-save.test.ts`

- [ ] **步骤 1：写失败测试**——`tests/js-save.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowStorage } from "../src/workflow-saved.js";

const SCRIPT = `const found = await agent("list files", { schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] } });\nreturn { found };`;

describe("saved workflow js format", () => {
  test("save writes a plain .js file with a readable meta block", () => {
    const cwd = mkdtempSync(join(tmpdir(), "omp-js-save-"));
    try {
      const storage = createWorkflowStorage(cwd);
      storage.save({ name: "audit", description: "审计路由", script: SCRIPT, location: "project" }, "project");
      const raw = readFileSync(join(cwd, ".omp", "workflows", "saved", "audit.js"), "utf8");
      expect(raw).toContain('export const meta = {\n  name: "audit"');
      expect(raw).toContain('description: "审计路由"');
      expect(raw).toContain(SCRIPT);
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
      expect(loaded?.script).toBe(SCRIPT);
      expect(loaded?.location).toBe("project");
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
});
```

- [ ] **步骤 2：运行确认失败**——`bun test tests/js-save.test.ts` 预期：FAIL（当前写 `.json`）。

- [ ] **步骤 3：实现 `.js` 格式**——`src/workflow-saved.ts` 改造：

```ts
// workflowPath：`${name}.js`（不再 .json）
const workflowPath = (name: string, location: "project" | "user") => {
  assertSafeSavedWorkflowName(name);
  const dir = location === "project" ? projectDir : userDir;
  return join(dir, `${name}.js`);
};
```

save 落盘内容（meta 块 + 脚本体）：

```ts
save(workflow, location = "project") {
  assertSafeSavedWorkflowName(workflow.name);
  const dir = location === "project" ? projectDir : userDir;
  ensureDir(dir);
  const path = workflowPath(workflow.name, location);
  const metaLines = [`export const meta = {`, `  name: ${JSON.stringify(workflow.name)},`];
  if (workflow.description) metaLines.push(`  description: ${JSON.stringify(workflow.description)},`);
  if (workflow.parameters) metaLines.push(`  parameters: ${JSON.stringify(workflow.parameters, null, 2)},`);
  metaLines.push("}");
  const js = `${metaLines.join("\n")}\n\n${workflow.script}\n`;
  writeFileSync(path, js); // 经 fs 层：fs.writeFile
  return { ...workflow, location, path, savedAt: new Date().toISOString() };
}
```

load 用 `parseWorkflowScript`（`src/workflow.js` 导出）解析 meta+body：

```ts
const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
  const raw = readFileSyncSafe(path); // fs 层读取；不存在返回 null
  if (raw == null) return null;
  const parsed = parseWorkflowScript(raw); // { meta, body }
  if (!parsed?.meta?.name || !isSafeSavedWorkflowName(parsed.meta.name)) return null;
  return {
    name: parsed.meta.name,
    description: typeof parsed.meta.description === "string" ? parsed.meta.description : undefined,
    parameters: parsed.meta.parameters,
    script: parsed.body,
    location,
    path,
    savedAt: undefined, // .js 无元数据，缺省
  };
};
```

`list()` 改为扫 `.js`（去掉 `.json` 扫描）；`homeProjectWorkflowPath` 同步改 `.js`（该兼容路径仅保留读取同名新格式）；`locationsOf` 相应更新。

- [ ] **步骤 4：适配旧测试**——`tests/save-location.test.ts` 中写 `.json` 字面量的用例改为 `.js`（legacy 读取用例删除——无兼容层）；`tests/run-persistence.test.ts` 若引用 saved 路径同步适配（先跑全量看失败）。

- [ ] **步骤 5：全量回归**——`bun test` 预期：全绿。

- [ ] **步骤 6：Commit** —— `git commit -m "feat: saved workflows 改用 CC 原版 .js 格式，移除 .json 兼容"`

---

### 任务 3（M3a）：settings 新增 syncHostTools / mcpServers / enableIrc

**文件：** 修改 `src/workflow-settings.ts`、`tests/schema-coercion.test.ts`

- [ ] **步骤 1：接口与归一化**——`src/workflow-settings.ts` 的 `WorkflowSettings` 加字段并在 `normalizeSettings` 里归一：

```ts
/** 子代理会话全量同步主代理扩展工具/技能（默认 true）。 */
syncHostTools?: boolean;
/** MCP 白名单：只在这些服务器的工具进子代理；空数组 = 不启用 MCP。 */
mcpServers?: string[];
/** 子代理会话启用 IRC 通信（默认 false）。 */
enableIrc?: boolean;
```

normalize 逻辑（复用文件内已有模式）：

```ts
syncHostTools: typeof value.syncHostTools === "boolean" ? value.syncHostTools : true,
mcpServers: Array.isArray(value.mcpServers)
  ? value.mcpServers.filter((s): s is string => typeof s === "string" && s.length > 0)
  : [],
enableIrc: value.enableIrc === true,
```

- [ ] **步骤 2：测试**——`tests/schema-coercion.test.ts` 追加用例：`{ syncHostTools: false, mcpServers: ["a", 3, ""], enableIrc: true }` → 归一为 `{ syncHostTools: false, mcpServers: ["a"], enableIrc: true }`；缺省 → `true` / `[]` / `false`。

- [ ] **步骤 3：回归 + Commit** —— `bun test tests/schema-coercion.test.ts` 通过后 `git commit -m "feat: settings 新增 syncHostTools/mcpServers/enableIrc"`

---

### 任务 4（M3b）：子代理会话同步分支

**文件：** 修改 `src/agent.ts`（`run()` 内 `createAgentSession` 调用处 ~814-850）

- [ ] **步骤 1：读现状并确认宿主 API**——`agent.ts` 814-850 现有参数（`disableExtensionDiscovery: true, extensions: [], enableMCP: false, enableIrc: false`）。确认 `host()` 命名空间含 `getActiveSkills`（`index.d.ts` 导出 `./extensibility/skills.js`，已核实）。

- [ ] **步骤 2：加同步选项**——`WorkflowAgentOptions` 与 `AgentRunOptions` 加：

```ts
/** 子代理全量同步主代理扩展工具/技能（对应 settings.syncHostTools，默认 true）。 */
syncHostTools?: boolean;
/** MCP 白名单服务器名；undefined/[] = 不启用 MCP。 */
mcpServers?: string[];
/** 子代理启用 IRC（对应 settings.enableIrc）。 */
enableIrc?: boolean;
```

`WorkflowAgent` 构造器存为私有字段（默认 `syncHostTools ?? true`、`mcpServers ?? []`、`enableIrc ?? false`）。

- [ ] **步骤 3：改造 createAgentSession 调用**——`run()` 内：

```ts
const { session } = await host().createAgentSession({
  ...this.sessionOptions,
  cwd: runCwd,
  agentDir,
  sessionManager,
  agentId: this.sessionOptions.agentId ?? workflowAgentIdentity(options.label),
  agentDisplayName: this.sessionOptions.agentDisplayName ?? "sub",
  taskDepth: this.sessionOptions.taskDepth ?? 1,
  settings: this.sessionOptions.settings ?? (await this.getSharedSettings(agentDir)),
  modelRegistry,
  customTools: allCustomTools,
  // syncHostTools：走 omp 官方父→子通道——子代理自己 loadExtensions 绑定本会话。
  // 关闭时保持移植版原有隔离（extensions: [], disableExtensionDiscovery: true）。
  ...(this.syncHostTools
    ? {
        skills: host().getActiveSkills(),
        disableExtensionDiscovery: false,
        extensions: [] as never[],
        enableMCP: this.mcpServers.length > 0,
        enableIrc: this.enableIrc,
      }
    : {
        disableExtensionDiscovery: true,
        extensions: [] as never[],
        enableMCP: false,
        enableIrc: false,
      }),
  toolNames,
  restrictToolNames: true,
  allowRestrictedCustomTools: allCustomTools.length > 0,
  ...(resolvedModel ? { model: resolvedModel } : {}),
  ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
});
```

同步模式下 `toolNames` 保持现状（native + customTools 名）。MCP 工具过滤在任务 5（创建后 `applyActiveToolsByName`）。

- [ ] **步骤 4：接线 settings**——`workflow.ts` 的 `runWorkflow` 构造 `WorkflowAgent` 处（`new WorkflowAgent(options)`）与 `workflow-manager.ts` 传给 `runWorkflow` 的 options 链路上，把 `syncHostTools`/`mcpServers`/`enableIrc` 从 `WorkflowManagerOptions` 透传（`WorkflowManagerOptions` 加同名字段，`extensions/workflow.ts` 构造 manager 时从 `loadWorkflowSettings` 取值）。

- [ ] **步骤 5：单测**——`tests/omp-integration.test.ts` 或新增 `tests/subagent-sync.test.ts`：用注入的假 `host()`/假 `createAgentSession` 断言——`syncHostTools: true` 时调用参数含 `skills` 且 `enableMCP: mcpServers.length > 0` 且 `disableExtensionDiscovery: false`；`false` 时恢复 `disableExtensionDiscovery: true`、`enableMCP: false`、无 `skills` 字段。复用 `tests/setup.ts` 的 host 安装模式（读 setup 后按现有 mock 风格写）。

- [ ] **步骤 6：验证点 V6/V7 实测**——真实环境冒烟：`omp` 会话中跑一个最小 workflow（`agent("pwd")`），确认：子代理能看到宿主插件工具（V6：扩展工具名出现在子代理 tool list——通过脚本 `agent("list your tools", {schema})` 返回工具名验证）；技能清单出现在子代理 system prompt（V7：`agent("你有哪些可用技能？read skill://xxx")` 可读到内容）。

- [ ] **步骤 7：回归 + Commit** —— `bun test` 全绿后 `git commit -m "feat: 子代理会话 syncHostTools 全量同步扩展工具/技能（omp 官方通道）"`

---

### 任务 5（M3c）：MCP 白名单过滤

**文件：** 修改 `src/agent.ts`（任务 4 的会话创建后）

- [ ] **步骤 1：确认枚举 API**——`session-tools.d.ts` 已核实：`collectMountedMCPToolRoutes(tools)` 导出公开函数（含 serverName 路由元数据）、`SessionTools.applyActiveToolsByName(toolNames)`、`registry: Map<string, AgentTool>`。`AgentSession` 暴露 `tools: SessionTools`（`agent.ts` 中 `session` 变量）。

- [ ] **步骤 2：实现过滤**——`createAgentSession` 返回后、`session.prompt` 前：

```ts
if (this.syncHostTools && this.mcpServers.length > 0) {
  try {
    const routes = [...collectMountedMCPToolRoutes(session.tools.registry.values())];
    const keep = routes.filter((r) => this.mcpServers.includes(r.serverName)).map((r) => r.toolName);
    const base = session.tools.getActiveToolNames().filter((n) => !routes.some((r) => r.toolName === n));
    await session.tools.applyActiveToolsByName([...base, ...keep]);
  } catch (error) {
    // 白名单过滤失败只告警：MCP 工具不可用不阻塞 run
    console.warn(`[workflow] mcp whitelist filter failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

（`r.serverName`/`r.toolName` 字段名以 `MountedMCPToolRoute` 实际类型为准，实现时按编译器提示微调。）

- [ ] **步骤 3：单测**——`tests/subagent-sync.test.ts` 追加：假 session 的 `tools` mock 含 3 个 MCP 路由（serverA/serverB），`mcpServers: ["serverA"]` → `applyActiveToolsByName` 收到只含 serverA 工具 + 非 MCP 工具名的集合；`mcpServers: []` → 不调用 `applyActiveToolsByName`。

- [ ] **步骤 4：验证点 V8 实测**——真实 omp 会话：配置 `.mcp.json`（两服务器）+ settings `mcpServers: ["serverA"]`，跑 workflow 让子代理 `agent("list your tools")`——只出现 serverA 的 `mcp__serverA__*` 工具。

- [ ] **步骤 5：回归 + Commit** —— `git commit -m "feat: MCP 白名单——子代理只挂载 mcpServers 声明服务器"`

---

### 任务 6（M4a）：ACP 桥——检测 + 默认同步 + 节流帧

**文件：** 新增 `src/acp-bridge.ts`；修改 `src/workflow-tool.ts`；新增 `tests/acp-bridge.test.ts`

- [ ] **步骤 1：写失败测试**——`tests/acp-bridge.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { isAcpOrHeadlessSession, throttleFrames, renderProgressFrame } from "../src/acp-bridge.js";
import { createWorkflowSnapshot, recomputeWorkflowSnapshot } from "../src/display.js";
import { parseWorkflowScript } from "../src/workflow.js";

const meta = { name: "codebase-audit", description: "d", phases: [{ title: "Fan out" }, { title: "Synthesize" }] };

describe("acp-bridge", () => {
  test("session detection: no-UI ctx is treated as ACP/headless", () => {
    expect(isAcpOrHeadlessSession({ hasUI: false } as never)).toBe(true);
    expect(isAcpOrHeadlessSession({ hasUI: true } as never)).toBe(false);
    expect(isAcpOrHeadlessSession({} as never)).toBe(true); // 缺省视为无 UI
  });

  test("progress frame renders phase, agent counts, and next phase", () => {
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(meta)) as typeof meta extends never ? never : WorkflowSnapshot & { phaseIndex: number; runId: string; tokenTotal: number };
    snap.phaseIndex = 0;
    snap.runId = "r1";
    snap.tokenTotal = 12400;
    snap.agents = [
      { id: "a1", label: "fanout:0:1", phase: "Fan out", status: "done" },
      { id: "a2", label: "fanout:0:2", phase: "Fan out", status: "running" },
    ];
    snap.doneCount = 1;
    snap.runningCount = 1;
    snap.agentCount = 2;
    const frame = renderProgressFrame(snap);
    expect(frame).toContain("Phase 1/2: Fan out");
    expect(frame).toContain("1/2 agents");
    expect(frame).toContain("next: Synthesize");
    expect(frame).toContain("12.4k");
  });

  test("frame throttle: at most one emit per interval", () => {
    let emits = 0;
    const throttled = throttleFrames(() => { emits += 1; }, 50);
    throttled(); throttled(); throttled();
    expect(emits).toBe(1);
    return new Promise((resolve) => setTimeout(() => { throttled(); resolve(undefined); }, 60)).then(() => {
      expect(emits).toBe(2);
    });
  });
});
```

- [ ] **步骤 2：运行确认失败**——`bun test tests/acp-bridge.test.ts` 预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `src/acp-bridge.ts`**：

```ts
import type { ExtensionContext } from "./omp-api.js";
import type { WorkflowSnapshot } from "./display.js";

/**
 * ACP 会话（或任何无 TUI 的 headless 会话）检测。TUI 模式 hasUI=true；
 * ACP 的 ExtensionUIContext 无组件面，hasUI=false。缺省视为无 UI（headless 安全默认）。
 */
export function isAcpOrHeadlessSession(ctx: Pick<ExtensionContext, "hasUI"> | undefined): boolean {
  return ctx?.hasUI !== true;
}

/** 进度帧：结构化 ASCII 流程图，ACP 客户端 tool 面板内滚动可见。 */
export function renderProgressFrame(snapshot: WorkflowSnapshot): string {
  // phaseIndex/runId/tokenTotal 为快照上的可选扩展字段，用局部断言类型访问
  const ext = snapshot as WorkflowSnapshot & { phaseIndex?: number; runId?: string; tokenTotal?: number };
  const lines = [`Workflow: ${snapshot.name} · run ${ext.runId ?? "-"}`];
  const phases = (snapshot as { phases?: Array<{ title: string }> }).phases ?? [];
  phases.forEach((phase, i) => {
    const agents = snapshot.agents.filter((a) => a.phase === phase.title);
    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const icon = i < (ext.phaseIndex ?? 0) ? "✓" : i === ext.phaseIndex ? "◐" : "⏳";
    let line = `${icon} Phase ${i + 1}/${phases.length}: ${phase.title}`;
    if (agents.length > 0) line += `  ▸ ${done}/${agents.length} agents${running > 0 ? ` · ${running} running` : ""}`;
    if (i === ext.phaseIndex && phases[i + 1]) line += `  · next: ${phases[i + 1].title}`;
    lines.push(line);
  });
  if (ext.tokenTotal) lines.push(`Tokens: ${(ext.tokenTotal / 1000).toFixed(1)}k`);
  return lines.join("\n");
}

/** 1s 节流包装：ACP 进度帧每秒至多一帧，避免消息风暴。 */
export function throttleFrames(emit: () => void, intervalMs = 1000): () => void {
  let last = 0;
  let pending = false;
  return () => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      emit();
      return;
    }
    pending = true;
    setTimeout(() => {
      if (!pending) return;
      pending = false;
      last = Date.now();
      emit();
    }, intervalMs - (now - last));
  };
}
```

- [ ] **步骤 4：接入 `workflow-tool.ts`**——`execute` 中：

```ts
// ACP/headless 会话（无 TUI）：默认同步执行，进度经 onUpdate 流式推送（ACP tool_call_update）。
const acpSession = isAcpOrHeadlessSession(uiCtx);
const backgroundDefault = acpSession ? false : true;
if (params.background ?? backgroundDefault) { /* 后台分支不变 */ }
```

同步分支**不复用** `createToolUpdateWorkflowDisplay`（其 emit 固定用 `renderWorkflowText`，无法输出 ACP 进度帧），自管帧输出 + 节流：

```ts
import { isAcpOrHeadlessSession, throttleFrames, renderProgressFrame } from "./acp-bridge.js";

let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
const emitFrame = (done = false) => {
  onUpdate?.({
    content: [{ type: "text", text: renderProgressFrame(snapshot) }],
    details: snapshot,
  });
  if (done && ctx?.hasUI) { /* 原 widget 更新路径保留给 TUI 场景（若有） */ }
};
const throttled = throttleFrames(() => emitFrame(false), 1000);

try {
  result = await manager.runSync(script, params.args, {
    /* 原参数不变 */
    onProgress(live) {
      snapshot = recomputeWorkflowSnapshot(live);
      throttled();
    },
  });
} catch (error) { /* 原错误处理不变 */ }

snapshot.result = result.result;
snapshot.durationMs = result.durationMs;
snapshot = recomputeWorkflowSnapshot(snapshot);
emitFrame(true); // 结束时无条件发最终帧
```

返回内容保持原样（完整结果 + token 信息 + reviseHint）。

- [ ] **步骤 5：验证点 V1–V3 实测**——真实 ACP 客户端（`@agentclientprotocol/sdk` 起 omp `--mode acp` 或用 Zed）：
  - V1：ACP 会话中 `ctx.hasUI === false`（debug 打印验证，若为 true 则改用 `syncMode` 设置兜底）；
  - V2：调用 workflow 工具期间客户端收到连续 `tool_call_update(in_progress)` 帧；
  - V3：`checkpoint()` 触发的 `ui.confirm` 走 ACP elicitation 可应答。

- [ ] **步骤 6：回归 + Commit** —— `bun test` 全绿后 `git commit -m "feat: ACP 桥——无 UI 会话默认同步 + 1s 节流进度帧"`

---

### 任务 7（M4b）：`/workflows` ACP 文本退化 + watch 文本流

**文件：** 修改 `src/workflow-commands.ts`

- [ ] **步骤 1：读现状**——`registerWorkflowCommands` 已有 `ctx.hasUI` 分支（无参导航器 vs 文本）；确认 `watchRun` 走 status bar（`ctx.ui.setStatus`）——ACP 下无 status bar。

- [ ] **步骤 2：watch 文本流**——`watchRun` 改为：`ctx.hasUI` 时保持 status bar；无 UI 时用 `pi.sendMessage({ customType: "workflow-watch", content, display: true })` 每秒推一行进度（事件订阅已存在，仅换输出通道）：

```ts
function watchRun(manager: WorkflowManager, pi: ExtensionAPI, ctx: ExtensionCommandContext, id: string): boolean {
  const run = manager.getRun(id);
  if (!run) return false;
  if (!ctx.hasUI) {
    const emit = () => {
      const snap = manager.snapshotOf(id);
      if (!snap) return;
      pi.sendMessage({ customType: "workflow-watch", content: oneLineProgress(snap), display: true });
    };
    emit();
    const timer = setInterval(emit, 1000);
    manager.once(`${id}:settled`, () => clearInterval(timer));
    return true;
  }
  // 原 status bar 路径保留
  // ...
}
```

（`manager.snapshotOf`/事件名以 `workflow-manager.ts` 现有 API 为准，实现时核对。）

- [ ] **步骤 3：测试**——`tests/omp-integration.test.ts` 追加（若有 command ctx mock 模式）或 `tests/acp-bridge.test.ts` 追加：无 UI ctx 调用 watch 路径 → sendMessage 被调用且定时器在 settled 后清理。若无现成 mock，跳过单测、以 M5 端到端冒烟覆盖（在测试文件中注明）。

- [ ] **步骤 4：回归 + Commit** —— `git commit -m "feat: /workflows watch 在无 UI 会话走文本消息流"`

---

### 任务 8（M5a）：命令与工具描述中文化

**文件：** 修改（逐个）`src/workflow-commands.ts`、`src/workflow-editor.ts`、`src/effort-command.ts`、`src/workflows-models-command.ts`、`src/builtin-commands.ts`、`src/builtin-workflows.ts`、`src/workflow-tool.ts`、`src/workflow-control-tool.ts`、`src/adversarial-review.ts`、`src/code-review.ts`、`src/deep-research.ts`

- [ ] **步骤 1：命令 description/USAGE**——上述 `-commands.ts`/`effort-command.ts`/`builtin-commands.ts` 中所有 `registerCommand` 的 `description`、`USAGE`/`RUN_USAGE`/`SAVE_USAGE` 常量、`say()` 帮助文案中文化。示例：

```ts
// workflow-commands.ts
const USAGE = "用法: /workflows [list] | run <提示> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | rm <id> | save <名称> [runId]";
// registerCommand description
description: "工作流运行列表与控制：list/status/watch/pause/resume/stop/rm/run/save/web",
// effort-command.ts
description: "常驻工作流档位: off | high | ultra —— 对实质消息自动启用工作流编排",
```

- [ ] **步骤 2：工具描述**——`workflow-tool.ts` 的 `description`/`promptSnippet`/`promptGuidelines`（含 `WORKFLOW_GATE_GUIDELINE`）、`workflow-control-tool.ts` 的 description 中文化：

```ts
description: "运行一个以 JavaScript 编写的动态工作流：通过 agent() 把任务委派给子代理，可组合 parallel()/pipeline() 编排。",
promptSnippet: "适合把可拆分的独立任务或分阶段任务委派给子代理时，用 JavaScript 工作流编排 agent()、parallel()、pipeline() 调用",
// GATE_GUIDELINE 全文中文化（保持语义：仅在用户显式 opt-in 时调用 workflow 工具）
```

- [ ] **步骤 3：内置模式**——`builtin-commands.ts`/`builtin-workflows.ts` 的 5 个模式 description 与 `adversarial-review.ts`/`code-review.ts`/`deep-research.ts` 内部 description 中文化（这些是工具 name 解析文案，模型可见——中文模型友好）。

- [ ] **步骤 4：回归**——`bun test`；中文化影响的文案断言测试同步更新（`web-server.test.ts` 等若断言英文文案）。

- [ ] **步骤 5：Commit** —— `git commit -m "i18n: 命令描述/USAGE 与工具描述中文化"`

---

### 任务 9（M5b）：Web 控制台中文化

**文件：** 修改 `web/src/**`（App.tsx、components/{RunList,AgentDrawer,OutlineFlow,RuntimeFlow,SaveDialog,Authoring,ui,Split}.tsx、store.ts、lib/）、`web/index.html`

- [ ] **步骤 1：盘点英文文案**——`grep -rn '"[A-Z][a-z]' web/src --include=*.tsx --include=*.ts` 收集全部 UI 字符串（Run/Stop/Pause/Resume/Open console/Save/Status 等）。

- [ ] **步骤 2：逐组件中文化**——App.tsx（标题/导航/空态）、RunList.tsx（列表表头/状态标签 running→运行中、completed→已完成、failed→失败、aborted→已中止、paused→已暂停）、AgentDrawer.tsx（agent 详情/提示/工具调用/结果标签）、OutlineFlow.tsx + RuntimeFlow.tsx（阶段图例/拓扑标签）、SaveDialog.tsx（保存对话框文案）、Authoring.tsx（编辑界面文案）、ui.tsx（通用按钮/输入占位符）、Split.tsx（面板分隔提示）、store.ts（默认消息文案）、lib/（错误消息）、index.html（`<title>` → `工作流控制台`）。

- [ ] **步骤 3：Web 构建**——`cd web && bun install && bun run build`（沿用现有 vite 配置），`web/dist` 产物更新。

- [ ] **步骤 4：Commit** —— `git add web/src web/dist web/index.html && git commit -m "i18n: Web 控制台界面中文化（含构建产物）"`

---

### 任务 10（M5c）：文案防回归测试 + 全量回归 + 端到端冒烟

**文件：** 新增 `tests/zh-copy.test.ts`

- [ ] **步骤 1：写防回归测试**——`tests/zh-copy.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcFiles = readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "omp-api.ts" && f !== "omp-host.ts" && f !== "omp-typebox.ts" && f !== "omp-lazy.ts");
const hasCJK = (s: string) => /[\u4e00-\u9fff]/.test(s);

describe("zh copy", () => {
  test("every registerCommand description is Chinese", () => {
    for (const file of srcFiles) {
      const text = readFileSync(join("src", file), "utf8");
      for (const m of text.matchAll(/description:\s*"([^"]+)"/g)) {
        expect(hasCJK(m[1]), `${file}: ${m[1]}`).toBe(true);
      }
    }
  });

  test("workflow tool descriptions are Chinese", () => {
    const tool = readFileSync("src/workflow-tool.ts", "utf8");
    expect(hasCJK(tool)).toBe(true);
    const control = readFileSync("src/workflow-control-tool.ts", "utf8");
    expect(hasCJK(control)).toBe(true);
  });

  test("web console has no residual English UI strings", () => {
    const webFiles = ["App.tsx", "RunList.tsx", "AgentDrawer.tsx", "SaveDialog.tsx", "index.html"];
    for (const f of webFiles) {
      const p = f === "index.html" ? join("web", f) : join("web/src", f);
      const text = readFileSync(p, "utf8");
      for (const word of ["Running", "Paused", "Failed", "Completed", "Save workflow", "Open console", "Stop", "Resume"]) {
        expect(text, `${f} contains ${word}`).not.toContain(word);
      }
    }
  });
});
```

- [ ] **步骤 2：运行并修残留**——`bun test tests/zh-copy.test.ts`；修复测试暴露的遗漏文案（回到任务 8/9 对应文件）。

- [ ] **步骤 3：全量回归**——`bun test` 全绿（现有 56 + 新增）。

- [ ] **步骤 4：端到端冒烟**——真实 omp 会话验证：
  1. `omp plugin link .` 加载本插件；
  2. TUI 下 `/workflows run 列出 src 下的文件` → 后台运行 → `/workflows status <id>` → 结果投递；
  3. 保存：`/workflows save demo` → `.omp/workflows/saved/demo.js` 可读；
  4. ACP 模式（`omp --mode acp` + sdk 测试客户端）→ 调用 workflow 工具收到连续进度帧（V2 复验）；
  5. 子代理能力：workflow 里 `agent("list your tools")` 返回含宿主扩展工具名（V6 复验）；
  6. `/workflows`、`/effort` 等命令帮助为中文。

- [ ] **步骤 5：Commit + 收尾** —— `git add -A && git commit -m "test: 中文文案防回归测试；全量回归与端到端冒烟"`

---

## 验证点汇总

| 验证点 | 内容 | 位置 |
|---|---|---|
| V1 | ACP 会话 `ctx.hasUI === false` | 任务 6 步骤 5 |
| V2 | onUpdate → ACP `tool_call_update(in_progress)` 流 | 任务 6 步骤 5 / 任务 10 步骤 4 |
| V3 | checkpoint elicitation 可应答 | 任务 6 步骤 5 |
| V6 | 子代理 `loadExtensions` 自绑定，工具不回流父会话 | 任务 4 步骤 6 |
| V7 | `getActiveSkills()` 可用，子代理可 `read skill://` | 任务 4 步骤 6 |
| V8 | MCP 白名单过滤链路 | 任务 5 步骤 4 |

## 风险与回退

- **V1 若 hasUI 为 true**（ACP 也有 UI 标记）：改用 settings `syncMode: "auto"|"always"|"never"` 兜底，`always` 强制同步（任务 6 已预留设计，实现时若需要则补该设置项）。
- **`collectMountedMCPToolRoutes` 字段名差异**：以 `MountedMCPToolRoute` 实际类型为准微调（任务 5 已注明）。
- **`getActiveSkills()` 在扩展运行时不可用**：改为 `host().loadSkills?.()` 或从技能目录扫描（任务 4 步骤 1 已注明确认方式，若两者都不可行则退化为清单注入 buildAgentInstructions——规格第 5 节 B 方案兜底）。
- **中文化影响模型面**：仅 description/prompt 文案；命令名、参数、脚本运行时文案保持英文——若某模型对中文 description 表现异常，可单独回退该文件。
