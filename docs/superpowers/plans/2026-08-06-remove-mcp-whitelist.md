# 移除子代理 MCP 白名单（默认全量）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除 `settings.mcpServers` 白名单机制，子代理（WorkflowAgent——工作流 `agent()` 调用 + 自动审阅链）默认启用 MCP 并全量挂载主代理的 MCP 服务器工具。

**架构：** 三层层叠移除——设置层（workflow-settings 类型/normalize/保存剔除 + 唯一消费点 extensions/workflow.ts）→ 传递链（workflow-manager 选项/字段/装配）→ 行为核心（agent.ts `enableMCP: true` + 收敛简化 + 选项移除 + 测试重写）。每层保持编译干净、可独立提交。行为层用 TDD 先行。

**技术栈：** TypeScript、Bun（`bun test` / `bunx tsc --noEmit`）、omp SDK（`createAgentSession`）。

**规格：** `docs/superpowers/specs/2026-08-06-remove-mcp-whitelist-design.md`（已批准，独立子代理对抗审查修订）。本计划反转 2026-08-06-omp-workflows-plugin-design.md 决策记录第 4 节。

---

## 执行约定（仓库惯例，沿用 consult 计划）

- 直接工作在 `main` 分支（本仓库前次 10+9 任务 SDD 惯例，账本 `.superpowers/sdd/progress.md` 已记录）。
- 每任务 1 个实现子代理 + 2 个独立对抗审查子代理（reviewer 类型，并行、互不可见），审查-修改循环直至无关键/重要问题。
- 实现子代理**跳过**全量验证（`bun test` 全量 / tsc 全量）——每任务只跑其声明的作用域内验证命令；全量验证在任务 5 统一执行一次。
- 一律不碰用户未跟踪/并行文件（`src/acp-plan.ts`、`src/todo-hint.ts`、`tests/acp-plan.test.ts`、`tests/todo-hint.test.ts`、`.superpowers/`）。
- 提交遵循 Conventional Commits（`type(scope): subject` + 中文 body，方案 + 影响范围）。

**行号均为 `b43c422`（HEAD，含规格文档）时点**；实现时以实际内容为准（编辑会移动行号）。

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `src/workflow-settings.ts` | 类型删 `mcpServers`（54-55）、normalize 删分支（267-272）、save 合并显式剔除残留键（184-186） | 1 |
| `tests/schema-coercion.test.ts` | normalize 用例改「mcpServers 被忽略」+ 新增保存剔除测试 | 1 |
| `extensions/workflow.ts` | 删 `settings.mcpServers ?? []` 消费（61-66） | 1 |
| `src/workflow-manager.ts` | 选项/字段/ReloadOptions Pick/两处装配透传删除 + 注释 | 2 |
| `src/agent.ts` | `enableMCP: true`、收敛简化、选项/字段/初始化删除、注释清理、死类型删除 | 3 |
| `tests/subagent-sync.test.ts` | 行为断言重写、删 4 个白名单用例、夹具精简 | 3 |
| `README.md` | 「子智能体会话」节 MCP 行为说明 + 测试表行描述 | 4 |

---

### 任务 1：设置层移除（workflow-settings + extensions/workflow + schema-coercion）

**文件：**
- 修改：`src/workflow-settings.ts:54-55,184-186,267-272`
- 修改：`extensions/workflow.ts:61-66`
- 测试：`tests/schema-coercion.test.ts:75-104`（+ 新增 1 用例）

- [ ] **步骤 1：改写失败的测试**

`tests/schema-coercion.test.ts`：

```ts
test("coerces syncHostTools / enableIrc; legacy mcpServers is ignored", () => {
  // mcpServers 白名单已于 2026-08-06 移除：normalize 不再产出该键。
  expect(normalizeSettings({ syncHostTools: false, mcpServers: ["a", 3, " "], enableIrc: true })).toEqual({
    syncHostTools: false,
    enableIrc: true,
  });
});

test("keeps syncHostTools / enableIrc sparse when omitted", () => {
  // 缺省即省略：不物化缺省键，否则项目覆盖文件会经 { ...global, ...project }
  // merge 静默覆盖全局显式设置。缺省语义由消费端 ?? 兜底。
  const normalized = normalizeSettings({});
  expect(normalized.syncHostTools).toBeUndefined();
  expect(normalized.enableIrc).toBeUndefined();
});

test("does not materialize defaults for type-invalid values", () => {
  const normalized = normalizeSettings({ syncHostTools: 1, mcpServers: "x", enableIrc: "yes" });
  expect(normalized.syncHostTools).toBeUndefined();
  expect(normalized.enableIrc).toBeUndefined();
});
```

导入区新增（沿用仓库测试的 node 风格）：

```ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
```

新增用例（追加到 `normalizeSettings` describe 之后）：

```ts
describe("saveWorkflowSettings legacy cleanup", () => {
  test("drops the removed mcpServers key when saving over an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-settings-strip-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify({ mcpServers: ["old"], enableIrc: true }));
      saveWorkflowSettings({ enableIrc: false }, { settingsPath: path });
      const saved = JSON.parse(readFileSync(path, "utf-8"));
      expect(saved.mcpServers).toBeUndefined();
      expect(saved.enableIrc).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test tests/schema-coercion.test.ts`
预期：FAIL——「coerces」用例 toEqual 多出 `mcpServers: ["a"]` 实为键被忽略失败；新增用例报「saveWorkflowSettings legacy cleanup」未定义（normalize 仍产出键 / save 仍保留键）。

- [ ] **步骤 3：实现最少代码**

`src/workflow-settings.ts`：

```ts
// 删除（54-55）：
//   /** MCP 白名单：只在这些服务器的工具进子代理；空数组 = 不启用 MCP。 */
//   mcpServers?: string[];
```

```ts
// 删除（267-272）：
//   if (Array.isArray(raw.mcpServers)) {
//     const names = raw.mcpServers
//       .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
//       .map((s) => s.trim());
//     if (names.length) settings.mcpServers = names;
//   }
```

`saveWorkflowSettings`（184-186）——合并前显式剔除历史残留键：

```ts
  const existing = readObject(path);
  // mcpServers 白名单已于 2026-08-06 移除：保存时剔除历史残留键（clean cutover，
  // 不留永久死键）；其余未知键保留行为不变。
  const { mcpServers: _legacy, ...cleanExisting } = existing;
  writeFileSync(path, `${JSON.stringify({ ...cleanExisting, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
```

`extensions/workflow.ts`（61-66）：

```ts
    // 稀疏归一化后必须 ?? 兜底：syncHostTools 缺省 true、enableIrc 缺省 false
    // （见 workflow-settings.ts normalizeSettings）。
    syncHostTools: settings.syncHostTools ?? true,
    enableIrc: settings.enableIrc ?? false,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/schema-coercion.test.ts && bunx tsc --noEmit`
预期：PASS（schema-coercion 全绿）；tsc 无错误（TS2339 `settings.mcpServers` 已随 61-66 删除消除）。

- [ ] **步骤 5：Commit**

```bash
git add src/workflow-settings.ts extensions/workflow.ts tests/schema-coercion.test.ts
git commit -m "refactor(settings): 移除 mcpServers 白名单字段

- 类型与 normalize 删除 mcpServers（缺省即省略不变量不变）
- saveWorkflowSettings 合并前剔除历史残留键，旧设置文件下次保存时真正消失
- extensions/workflow.ts 删除唯一外部消费点"
```

---

### 任务 2：传递链移除（workflow-manager）

**文件：**
- 修改：`src/workflow-manager.ts:365-368,388-397,491-493,511,564,819-820,2000,2048-2049`

- [ ] **步骤 1：实现删除**

删除以下内容（编译驱动，无独立新测试）：

```ts
// 365-368：syncHostTools 字段 doc 中提及「MCP 白名单」的措辞同步删除；
// 删除 mcpServers 字段及其 doc：
//   /** MCP 白名单服务器名；undefined/[] = 不启用 MCP（enableMCP: length > 0）。 */
//   mcpServers?: string[];

// 388-397：WorkflowManagerReloadOptions Pick 联合中删除一行：
//   | "mcpServers"

// 491-493：删除私有字段声明：
//   private mcpServers: string[];

// 511、564：两处构造器初始化删除：
//   this.mcpServers = options.mcpServers ?? [];

// 819-820：executeRun 的 runWorkflow 选项删除：
//   mcpServers: this.mcpServers,

// 2000：审阅链 WorkflowAgent 选项 doc（「syncHostTools/mcpServers/enableIrc/…」）去掉 mcpServers 措辞。

// 2048-2049：审阅链 WorkflowAgent 构造删除：
//   mcpServers: this.mcpServers,
```

- [ ] **步骤 2：验证编译与相关测试**

运行：`bunx tsc --noEmit && bun test tests/subagent-sync.test.ts tests/workflow-tool-sync.test.ts tests/run-persistence.test.ts`
预期：tsc 无错误（注意 `tests/subagent-sync.test.ts:283-285` 的 `mcpServers: ["a"]` 传给的是 runSync exec 选项——`WorkflowRunOptions extends WorkflowAgentOptions`，任务 3 才删该选项，此处仍编译通过，**不要**在本任务动该测试）；三个测试文件全绿。

- [ ] **步骤 3：Commit**

```bash
git add src/workflow-manager.ts
git commit -m "refactor(workflow-manager): 移除 mcpServers 选项透传

- WorkflowManagerOptions/ReloadOptions/私有字段/两处构造器初始化删除
- executeRun 与自动审阅链装配点不再透传 mcpServers"
```

---

### 任务 3：行为核心翻转（agent.ts + subagent-sync.test.ts）——TDD

**文件：**
- 修改：`src/agent.ts:283-288,619-621,653-654,930-946,978-1025`（+ 顶部 import 检查）
- 测试：`tests/subagent-sync.test.ts`（多处）

- [ ] **步骤 1：改写失败的测试**

`tests/subagent-sync.test.ts`：

(a) 「on:」用例（约 163-201）：删除 `mcpServers: ["a"],` 传参；精确集合断言改为全量保留：

```ts
    // Denylist convergence restores the full deny surface as an exact set:
    // every registered name minus the always-on workflow/workflow_control
    // defaults, the caller-denied excludeTools entry, and the SDK's hidden
    // `goal` tool (which getAllToolNames() includes even though the SDK's own
    // assembly filters it from the requested names). MCP tools pass through
    // untouched — subagents default to the full host MCP surface.
    const applied = lastAppliedTools();
    expect(applied).toEqual([
      "my-tool",
      "read",
      "bash",
      "mcp__servera_a1",
      "mcp__servera_a2",
      "mcp__serverb_b1",
    ]);
```

(b) 「default」用例（约 217-227）：断言与注释改为默认开启：

```ts
    // MCP 默认全量（白名单已于 2026-08-06 移除）；enableIrc ?? false 保持 IRC 关。
    expect(opts.enableMCP).toBe(true);
    expect(opts.enableIrc).toBe(false);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test tests/subagent-sync.test.ts`
预期：FAIL——「on:」断言 applied 集合缺三个 `mcp__` 工具（白名单 `["a"]` 过滤掉全部 MCP）；「default」断言 `opts.enableMCP` 得 false 期望 true。

- [ ] **步骤 3：实现最少代码**

`src/agent.ts`：

```ts
// 945：enableMCP: this.mcpServers.length > 0  →  enableMCP: true
```

收敛块（978-1025）整体替换为（删 MCP 归属枚举 `mcpServerByTool`、白名单分支、枚举失败降级；保留 denylist + goal；注释同步改写）：

```ts
    // Denylist convergence: with restrictToolNames: false the SDK no longer
    // filters workflow/workflow_control/excludeTools out of the session's tool
    // set. Restore the previous semantics here, before the first prompt, by
    // dropping the denied names from the active set — and also the SDK's
    // hidden `goal` tool (registered whenever restrictToolNames is false, yet
    // its own assembly filters it out of the requested names and it only
    // activates in goal mode; resurrecting it via getAllToolNames() would
    // advertise an invoke that always throws "Goal mode is not active").
    // MCP tools pass through untouched — since 2026-08-06 subagents default to
    // the full host MCP surface (no whitelist). Best-effort — a failure must
    // never abort the run.
    if (this.syncHostTools) {
      try {
        const toolNames = session.getAllToolNames();
        const denied = new Set(subagentExcludedTools(this.excludeTools));
        const keep = toolNames.filter((name) => !denied.has(name) && name !== "goal");
        await session.setActiveToolsByName(keep);
      } catch (error) {
        console.warn(
          `[workflow] subagent tool convergence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
```

删除（选项/字段/初始化 + 注释同步）：

```ts
// 287-288：WorkflowAgentOptions 删除：
//   /** MCP 白名单服务器名；undefined/[] = 不启用 MCP（enableMCP: length > 0）。 */
//   mcpServers?: string[];

// 283-284：syncHostTools 选项 doc 中「MCP 工具白名单过滤在任务 5（createAgentSession
//   后 applyActiveToolsByName）」措辞改为「MCP 默认全量（移除白名单后恒开）」。

// 619-621：删除私有字段及其 doc：
//   /** MCP 白名单服务器名；空/缺省 = 不启用 MCP（enableMCP: length > 0）。 */
//   private readonly mcpServers: string[];

// 653-654：删除构造器初始化：
//   this.mcpServers = options.mcpServers ?? [];

// 930-932：注释「MCP 按白名单开关」改为「MCP 默认全量」。
```

顶部 import 检查：`MountedMCPToolRouteSource`（含其引入来源）若仅被已删除的枚举块使用，一并删除；`bunx tsc --noEmit` 的 noUnusedLocals 会兜底。

`tests/subagent-sync.test.ts` 同步清理：

```ts
// 删除 4 个白名单用例：
//   test("explicit empty mcpServers keeps enableMCP false", ...)           （约 230-234）
//   test("mcp whitelist: keeps only tools from mcpServers-declared servers", ...)（约 236-255）
//   test("mcp whitelist: empty mcpServers keeps no MCP tools", ...)         （约 257-267）
//   test("mcp whitelist: enumeration failure degrades to deny-all-MCP (conservative)", ...)（约 269-277）

// manager 级用例（约 284-285）：删除 `mcpServers: ["a"],` 传参。

// 夹具精简（死代码）：
//   - FakeToolEntry 删除 mcpServerName?: string; / mcpToolName?: string;（约 55-57）
//   - defaultFakeRegistry 三条 MCP 路由（约 81-83）改为纯 name 条目：
//       { name: "mcp__servera_a1" }, { name: "mcp__servera_a2" }, { name: "mcp__serverb_b1" }
//   - fake session 的 getToolByName 与 getToolByNameThrows 标志删除（仅被已删除的
//     归属枚举使用）；beforeEach 中的 getToolByNameThrows = false 一并删除。
//   - 文件头注释（约 2-4、19-22）与 fakeRegistry doc（约 60-66）中白名单描述同步改写：
//     「MCP whitelist that only mounts tools from mcpServers-declared servers」→
//     「MCP default-on: every mounted host MCP tool passes the convergence untouched」。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/subagent-sync.test.ts && bunx tsc --noEmit`
预期：PASS（on/off/default/manager 四个用例全绿）；tsc 无错误（TS2339/TS2344/未用 import 均已清）。

- [ ] **步骤 5：Commit**

```bash
git add src/agent.ts tests/subagent-sync.test.ts
git commit -m "feat(agent): 子代理默认全量挂载主代理 MCP（移除白名单）

- enableMCP 恒 true；收敛仅保留 denylist + goal 排除，MCP 工具全部保留
- WorkflowAgentOptions 移除 mcpServers；死代码（归属枚举/降级）清理
- 行为 TDD：默认用例断言全量保留（serverA×2 + serverB×1）"
```

---

### 任务 4：README 文档

**文件：**
- 修改：`README.md`（「子智能体会话」节约 283-290；测试表约 484）

- [ ] **步骤 1：编辑文档**

「### 子智能体会话」节首段后补一句（MCP 默认全量 + 独立拉起的资源代价）：

```markdown
子代理会话默认挂载主代理的全部 MCP 服务器（`.mcp.json` 项目 + 用户配置发现源，
`enableMCP: true`）——每个子代理独立拉起服务器连接/子进程，不共享主会话连接；
并发 N 个子代理 × M 个服务器对应 N×M 份启动与资源开销。
```

测试表行（约 484）：

```markdown
| `subagent-sync.test.ts` | 子智能体会话同步：`syncHostTools` 三选项、MCP 默认全量继承 |
```

- [ ] **步骤 2：验证**

运行：`bunx tsc --noEmit`（README 改动不影响编译，此步仅确认工作区干净）
预期：无错误。

- [ ] **步骤 3：Commit**

```bash
git add README.md
git commit -m "docs: 子代理 MCP 默认全量行为说明

- 子智能体会话节补充 MCP 继承行为与独立拉起服务器的资源代价
- 测试表 subagent-sync 行描述改为默认全量继承"
```

---

### 任务 5：全量验证

**文件：** 无（验证任务）

- [ ] **步骤 1：全量测试**

运行：`bun test`
预期：全绿。基线 175 pass；任务 3 删除 4 用例、新增 1 用例（save 剔除）后约 172 pass / 0 fail（以实测为准）。

- [ ] **步骤 2：类型检查**

运行：`bun run check`（= `tsc --noEmit`）
预期：无错误。

- [ ] **步骤 3：Web 启动预算回归**

运行：`bun test tests/web-startup-budget.test.ts`
预期：PASS（web 未改动，确认无连带影响）。

- [ ] **步骤 4：真实宿主冒烟（可选）**

前置：本地 `bun link` 安装 + 宿主环境存在 `.mcp.json`（项目或用户级）配置的 MCP 服务器。
步骤：`omp -p` 启动插件，运行一个含 `agent()` 的工作流，观察子代理会话日志出现 MCP 工具装载（`discoverAndLoadMCPTools` / `mcp__*` 工具）。
若环境无 MCP 服务器配置，跳过并在任务报告注明原因——全量测试 + check 即验收下限。

---

## 自检

**1. 规格覆盖度**（对照 `2026-08-06-remove-mcp-whitelist-design.md`）：
- 第 1 节行为（enableMCP:true、收敛仅 denylist+goal、隔离路径不动）→ 任务 3 ✅
- 第 2 节代码改动：agent.ts（945/978-1025/选项字段初始化/注释/死类型）→ 任务 3；workflow-manager.ts（367-368/395/492/511/564/819-820/2048-2049/注释）→ 任务 2；workflow-settings.ts（54-55/267-272/184-186 剔除）→ 任务 1；extensions/workflow.ts（61-66）→ 任务 1 ✅
- 第 3 节测试：subagent-sync（默认全量断言/on 精确集合/删 4 用例/夹具精简/manager 用例参数）→ 任务 3；schema-coercion（81-88 改断言/90-104 清理）→ 任务 1 ✅
- 第 4 节文档：README 子智能体会话节 + 测试表行 → 任务 4 ✅
- 第 5 节验证：bun test / tsc / check → 任务 5 ✅

**2. 占位符扫描**：无「待定/TODO/类似任务 N」；每步含完整代码或精确删除清单。

**3. 类型一致性**：
- `WorkflowRunOptions extends WorkflowAgentOptions`（workflow.ts:158）——任务 2 删 manager 层时 runSync exec 选项仍含 mcpServers（编译通过），任务 3 删 agent 选项后该继承关系自动清空，两任务无冲突 ✅
- `saveWorkflowSettings(settings, { settingsPath })` 签名——`WorkflowSettingsOptions.settingsPath` 存在（normalizeOptions 分支已核验）✅
- 测试导入 `saveWorkflowSettings` 自 `../src/workflow-settings.js`（export 已核验）✅
- 任务 3 删除 `getToolByName` 前需确认 fake session 无其他调用方（真实 agent.ts 中 `session.getToolByName` 仅存在于被删的枚举块）✅
