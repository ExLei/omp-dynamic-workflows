# omp-dynamic-workflows 改造设计：移除子代理 MCP 白名单（默认全量）

日期：2026-08-06
状态：已批准（独立子代理对抗审查修订后批准）

> **决策反转声明**：本设计**反转** `2026-08-06-omp-workflows-plugin-design.md` 决策记录第 4 节
> 「MCP | 白名单（`settings.mcpServers`），不用全量透传」。历史规格/账本保持原样（历史档案），
> 后续读者以本设计为准。

## 背景

- 上一轮改造（2026-08-06-omp-workflows-plugin-design.md）为子代理 MCP 引入白名单：`settings.mcpServers`
  非空才 `enableMCP: true`（`src/agent.ts:945`），会话创建后按服务器名过滤 MCP 工具
  （`src/agent.ts:978-1025` 收敛，枚举失败时保守降级为不给任何 MCP 工具）。
- 用户需求（2026-08-06）：**去掉白名单，子代理默认能调用 MCP**——已选择方案 A：彻底移除
  `mcpServers` 设置与过滤机制，不保留可选收紧手段，不新增总开关（YAGNI）。

## 决策记录

| 决策 | 结论 |
|---|---|
| MCP 默认 | 反转上一轮决策：子代理默认全量（`enableMCP: true`，无按服务器过滤） |
| `mcpServers` 设置 | 彻底移除（类型、normalize、消费方、透传全清）；不保留可选收紧、不新增 `enableMCP` 用户开关 |
| 保留项 | `syncHostTools: false` 隔离路径仍无 MCP；denylist（workflow / workflow_control / excludeTools / goal）不变 |
| 历史文件 | 旧规格、账本、评审记录不改写（历史档案），本文档头部标注反转 |
| 设置迁移 | 旧设置文件残留 `mcpServers` 键在下次保存时被显式剔除（见第 2 节第 3 条） |

## 第 1 节：行为

- 子代理（`WorkflowAgent`——工作流 `agent()` 调用 + 自动审阅链，唯一关卡 `src/agent.ts:915`
  `createAgentSession`）默认 `enableMCP: true`，挂载主代理的全部 MCP 服务器工具。
- SDK 行为（已核验 `node_modules/@oh-my-pi/pi-coding-agent/src/sdk.ts:1849-1930`）：未传
  `mcpManager` 时自建 `MCPManager`，`discoverAndLoadMCPTools(cwd)` 按 `.mcp.json` 项目 + 用户配置
  全量发现并连接，与主会话同一发现源（`filterExa` 恒滤、`filterBrowser` 按设置、`mcp.enableProjectConfig`
  默认 true）。插件路径不传 `mcpManager` → **每个子代理会话独立拉起全部 MCP 服务器子进程/连接**，
  不共享主会话连接；并发 N 个子代理 × M 个服务器的资源开销与副作用面写入 README 行为说明
  （见第 4 节）。
- 收敛（`setActiveToolsByName`）仅剩 denylist + goal 排除；MCP 归属枚举、枚举失败保守降级整体删除。

## 第 2 节：代码改动

行号均为 `1555202`（main）时点。

1. **`src/agent.ts`**
   - `945`：`enableMCP: this.mcpServers.length > 0` → `enableMCP: true`（syncHostTools 分支内）。
   - `978-1025` 收敛：删除 `mcpServerByTool` 归属枚举（`990-1018`）、keep 计算中的白名单分支
     （`1020-1023`）与枚举失败降级（`1022-1023`）；保留 denied + goal 排除。
   - 删除 `WorkflowAgentOptions.mcpServers`（`287-288`）、私有字段（`619-621`）、构造器初始化
     （`653-654`）。
   - 注释同步：`283-284`（「MCP 工具白名单过滤在任务 5」）、`930-932`（「MCP 按白名单开关」）、
     `978-986` 收敛块注释（保留 goal 部分改写）、`620` 字段 doc。
   - 死代码清理：`MountedMCPToolRouteSource` 类型及 import（仅被枚举块使用，若 `bun run check`
     报未用即删）。
2. **`src/workflow-manager.ts`**
   - 删除 `WorkflowManagerOptions.mcpServers`（`367-368`）、`WorkflowManagerReloadOptions` Pick
     联合中的 `| "mcpServers"`（`395`）、私有字段声明（`492`）、两处构造器初始化（`511`、`564`）、
     装配透传（`819-820` executeRun、`2048-2049` 审阅链）。
   - 注释同步：`365-366`（syncHostTools doc 尾部）、`2000`（review agent doc 选项列表）。
3. **`src/workflow-settings.ts`**
   - 删除 `WorkflowSettings.mcpServers`（`54-55`）、normalize 分支（`267-272`）；「缺省即省略」
     不变量不变。
   - `saveWorkflowSettings`（`184-186`）显式剔除历史残留键：合并时解构丢弃 `mcpServers`
     （`const { mcpServers: _legacy, ...cleanExisting } = existing`）——旧设置文件中的该键在下次
     保存时真正消失（clean cutover，不留永久死键）；其余未知键保留行为不变。
4. **`extensions/workflow.ts`**
   - 删除 `65` `mcpServers: settings.mcpServers ?? []`；`61-63` 注释（「syncHostTools 缺省 true、
     mcpServers 缺省 []、enableIrc 缺省 false」）同步去掉 mcpServers 措辞。

## 第 3 节：测试

1. **`tests/subagent-sync.test.ts`**
   - 默认（无选项）用例 `217-227`：`opts.enableMCP` 断言 `false` → `true`；`220` 精确集合
     `["my-tool", "read", "bash"]` → 追加 `mcp__servera_a1`、`mcp__servera_a2`、`mcp__serverb_b1`
     （新语义正向断言：全部 MCP 工具保留）。
   - 「on:」用例 `163-175`：删 `mcpServers: ["a"]` 传参（enableMCP 仍断言 true）。
   - 删除用例：`230-234`（显式空列表禁用）、`236-255`（按服务器过滤）、`257-267`（空列表无 MCP
     工具）、`269-277`（枚举失败降级）。
   - 夹具清理：`FakeToolEntry.mcpServerName` / `mcpToolName`（`55-57`）、fake session 的
     `getToolByName` 与 `getToolByNameThrows` 标志（归属枚举删除后成死代码）；`fakeRegistry`
     三条 MCP 路由（`81-83`）保留——作为「全部保留」断言对象。
   - 注释同步：`2-4`、`19-22`、`60-66` 白名单描述。
   - manager 级用例 `284-285`：删 `mcpServers: ["a"]` 传参。
2. **`tests/schema-coercion.test.ts`**
   - `81-88`「coerces syncHostTools / mcpServers / enableIrc」用例改为断言 `mcpServers` 键被忽略
     （normalize 输出不含该键）。
   - `90-104` 稀疏断言删除 `mcpServers` 引用（仅 syncHostTools / enableIrc）。

## 第 4 节：文档

- `README.md`「子智能体会话」节（`283-290`）：补一句行为说明——子代理会话默认挂载主代理的
  全部 MCP 服务器（`.mcp.json` 项目 + 用户配置发现源），每个子代理独立拉起服务器连接/子进程，
  不共享主会话连接（并发开销提示）。
- `README.md` 测试表 `484`：`subagent-sync.test.ts` 行描述「MCP 白名单收窄与降级」→「MCP 默认
  全量继承」。
- `README.md` 配置表（`403-422`）无需操作（本无 `mcpServers` 行）。

## 第 5 节：验证

- `bun test` 全绿（基线 175 pass；删 4 用例、改约 8 处断言、夹具精简后计数以实测为准）。
- `bunx tsc --noEmit` + `bun run check` 干净（无 TS2339 / TS2344 / strictPropertyInitialization /
  未用 import）。
- 无 UI 变更，无 `web/dist` 重建需求。
