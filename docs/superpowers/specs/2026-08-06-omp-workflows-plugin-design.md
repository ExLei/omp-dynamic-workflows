# omp-dynamic-workflows 改造设计：ACP 桥 + 子代理能力同步 + 配置重构

日期：2026-08-06
状态：已批准（分节审查通过）

> **执行状态（2026-08-06 补记）**：M1–M5 全部实现并验收。测试 93 个全绿；
> ACP 相关验证分布在 `workflow-tool-sync.test.ts` / `workflow-watch.test.ts`（无独立
> `acp-bridge.test.ts`，见计划文档对应说明）；另增 `subagent-sync.test.ts`。
> 2026-08-06 晚些时候修复 omp 17.2.9 加载崩溃（`workflow` 工具 args schema 改用
> `Type.Object` 构造，见 `src/workflow-tool.ts` 注释），修复后 17.2.9 实测兼容。

## 背景

`zerx-lab/omp-dynamic-workflows` 是 Claude Code dynamic workflows 的 omp 移植版。评估发现三个能力缺口：

1. **ACP 显示缺失**：后台 run 的进度只走 TUI 面板 / TUI 导航器 / Web 控制台三条通道，ACP 客户端（Zed 等）在整个 run 生命周期看不到任何进度。omp 的 ACP 层只转发会话事件（`tool_execution_start/update/end → tool_call_started / tool_call_update(in_progress) / tool_call_update(completed)`，见 `@oh-my-pi/pi-coding-agent/src/modes/acp/acp-event-mapper.ts:211-280`），后台 run 不产生这些事件。
2. **子代理能力受限**：`agent.ts:837-843` 创建子代理会话时 `disableExtensionDiscovery: true`、`extensions: []`、`enableMCP: false`、`enableIrc: false`——其他插件的工具、MCP 工具、技能全部不可用。
3. **配置不易读**：saved workflows 是 JSON 容器包脚本字符串；settings 是无注释扁平 JSON；配置分散在多个文件和多个命令。

## 决策记录

| 决策 | 结论 |
|---|---|
| 插件形态 | fork 改造（同名 `omp-dynamic-workflows`，用户自己的 fork） |
| ACP 显示 | 纯插件层（不动 omp 核心）：ACP 会话默认同步模式 + 结构化 ASCII 进度帧 |
| 子代理工具 | 全量同步主代理（`syncHostTools` 开关，默认开），无注册表（YAGNI） |
| MCP | 白名单（`settings.mcpServers`），不用全量透传 |
| 技能 | 技能清单随会话注入（omp 原生 `skills` 参数，模型按需 `read skill://<name>`） |
| 工作流保存 | CC 原版 `.js` 纯脚本格式，**不兼容旧 `.json`**（旧文件留在磁盘，不读不写） |
| settings/model-tiers | **保持 JSON 不变**，不引入 YAML/Lua |
| Web/命令文案 | Web 控制台 UI、命令 description/USAGE、工具描述全中文化（命令名/参数保持英文） |

## 架构

```
fork 仓库 omp-dynamic-workflows
├─ extensions/workflow.ts      入口（manager 构造）
├─ src/workflow.ts             VM 沙箱运行时（不动）
├─ src/workflow-manager.ts     事件模型
├─ src/agent.ts                子代理会话（syncHostTools 改造）
├─ src/acp-bridge.ts           [新] ACP 会话检测 + 进度帧
├─ src/workflow-tool.ts        ACP 会话默认同步 + onUpdate 节流
├─ src/workflow-commands.ts    /workflows ACP 文本退化 + watch 文本流 + 中文文案
├─ src/*-commands.ts           命令 description/USAGE 中文化
├─ src/workflow-saved.ts       .js 保存/加载（无兼容层）
├─ web/src/**                  Web 控制台 UI 中文化
└─ tests/                      新增测试 + 隔离修复
```

## 第 2 节：ACP 桥（纯插件层）

- **会话检测（V1）**：`workflow-tool.ts` execute 的 `ctx` 上探测 ACP 会话（`ctx.hasUI` 值；若无可辨标记，用设置 `syncMode: "auto" | "always" | "never"` 兜底，默认 auto）。
- **默认同步**：ACP 会话下 `background` 参数翻转为 `false`——工具调用阻塞执行，`onUpdate` 每 ≤1s 推一帧进度快照（`createToolUpdateWorkflowDisplay` 已接通，`streamToolUpdates: true`）。omp ACP 层映射为 `tool_call_update(in_progress)`，客户端实时可见。
- **进度帧**：结构化 ASCII 流程图（阶段/agent 数/token/下一阶段），紧凑单帧：
  ```
  Workflow: codebase-audit · run r7x2
  ── Phase 1/3: Fan out  ▸ 6/8 agents done · 12.4k tokens
  ── Phase 2/3: Cross-check  ◐ 2 running
  ── Phase 3/3: Synthesize  ⏳ next
  ```
- **结束结果**：完整 JSON 快照（phases 数组：状态/agent 数/耗时/结果）。
- **`/workflows` 退化**：无参导航器依赖 `ctx.hasUI`（`workflow-commands.ts:250,254`），ACP 下自动走文本列表；补 `watch` 文本流（`sendMessage` 定期推进度）。
- **checkpoint 保留**：`ctx.ui.confirm` 走 ACP elicitation。
- **结果投递不变**：`installResultDelivery` 兼容。

已知边界：ACP 的 `plan` 面板更新只从 `todo` 工具触发（`acp-event-mapper.ts:413-417`），扩展工具无法触达——结构化流程图以文本帧呈现，非原生 plan 面板。可选后续：向 omp 提 PR 放开 plan 映射（不在本设计内）。

## 第 3 节：子代理工具同步（syncHostTools）

- settings 新增 `syncHostTools: boolean`（默认 `true`）。
- `agent.ts` 子代理创建：开启时移除 `disableExtensionDiscovery: true` / `extensions: []` 隔离，改为：
  ```ts
  preloadedExtensionPaths: await discoverSessionExtensionPaths(...)  // 官方父→子通道
  skills: getActiveSkills()
  ```
  子代理自己 `loadExtensions`，扩展绑定子会话自己的 `ExtensionAPI`（官方保证工具执行不回流父会话，V6 验证）。
- denylist 照旧：`workflow` / `workflow_control` / `excludeSubagentTools` 过滤。
- IRC：settings `enableIrc`（默认 `false`）→ 子代理会话 `enableIrc: true`（开启后子代理可经 omp IRC bridge 互发消息；默认关避免打扰）。
- 不做额外工具注册表：全量同步已覆盖宿主全部扩展工具，`registerWorkflowTool` 无存在必要（YAGNI）。

## 第 4 节：MCP 白名单

- settings 新增 `mcpServers: string[]`（默认 `[]` = 不启用 MCP）。
- 子代理会话 `enableMCP: true`；会话创建后 `refreshMCPTools` 只挂白名单服务器（V8 验证过滤链路）。

## 第 5 节：技能注入

- `skills: getActiveSkills()`（`@oh-my-pi/pi-coding-agent/dist/types/extensibility/skills.d.ts` 公开函数）——技能名+描述进子代理 system prompt，模型按需 `read skill://<name>`（V7 验证可用性）。
- 零额外代码：omp 原生会话装配行为。

## 第 6 节：配置与持久化

- **settings/model-tiers 保持 JSON 不变**（`settings.json` / `model-tiers.json`，不引入 YAML/Lua，避免无谓迁移）。
- saved workflows → CC 原版 `.js`：
  ```js
  export const meta = {
    name: "audit-routes",
    description: "Audit every route handler for missing auth checks",
    parameters: { ... },  // 可选
  }

  const found = await agent('...', { schema: ... })
  ```
  `parseWorkflowScript` 已有 meta+body 解析，load 复用；**不兼容旧 `.json`**（旧文件留在磁盘，不读不写不列）。
- 新增配置项（写进现有 `settings.json`）：
  ```json
  { "syncHostTools": true, "mcpServers": [], "enableIrc": false }
  ```

## 第 8 节：Web 控制台与命令文案中文化

- **Web 控制台**（`web/src/`，约 1413 行）：全部 UI 文案中文化——App、RunList、AgentDrawer、OutlineFlow、RuntimeFlow、SaveDialog、Authoring、ui 组件；`index.html` 标题；空态/错误态提示。
- **命令介绍**：`registerCommand` 的 `description` 与 USAGE/帮助文案中文化——`/workflows`（含 list/status/watch/pause/resume/stop/rm/run/save/web 子命令）、`/workflows-trigger`、`/workflows-progress`、`/workflows-models`、`/effort`、`/ultracode`、五个内置模式命令（deep-research/adversarial-review/code-review/multi-perspective/codebase-audit）。
- **工具描述**：`workflow` / `workflow_control` 工具的 `description`、`promptSnippet`、`promptGuidelines` 中文化（含 `WORKFLOW_GATE_GUIDELINE`）；内置模式的工具侧 description（`builtin-workflows.ts` 的 name 解析文案）一并中文化——模型为中文模型，中文描述更优。
- **边界**：命令名与参数保持英文（slash 命令不能改）；运行时动态文案（进度帧、投递结果、子代理指令）保持英文（结构化内容，后续按需再议）。
- Web 构建产物 `web/dist` 需重建提交（CI 工作流 `.github/workflows/web-dist.yml` 已存在）。

## 第 7 节：验证点与里程碑

验证点：V1 ACP 会话检测 · V2 onUpdate→ACP 链路 · V3 checkpoint elicitation · V6 子代理扩展自绑定 · V7 `getActiveSkills()` 可用性 · V8 MCP 白名单过滤链路。

| M | 内容 | 验收 |
|---|---|---|
| M1 | fork 基线 | 现有测试全绿（save-location 测试改 tmp HOME 隔离） |
| M2 | 保存格式 | saved workflows 改 `.js`（无兼容层） |
| M3 | 子代理能力同步 | syncHostTools/skills/MCP 白名单/IRC 开关，V6–V8 实测 |
| M4 | ACP 桥 | V1–V3 实测，ACP 测试客户端冒烟 |
| M5 | 中文化 + 回归 | Web UI/命令文案中文，`web/dist` 重建，全量回归 + 真实 omp 会话冒烟 |

新增测试：`js-save.test.ts`（`.js` 保存/加载）、`acp-bridge.test.ts`（进度帧/节流/检测）、`zh-copy.test.ts`（命令 description、工具 description、web 关键文案无英文残留，防回归）；现有 56 个回归（其中 3 个 save-location 失败源于测试读真实 HOME 被用户数据污染，随 M1 修复；中文化可能影响部分文案断言测试，随 M5 同步修）。
