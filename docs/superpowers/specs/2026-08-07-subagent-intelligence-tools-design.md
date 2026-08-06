# 子代理代码智能工具（codegraph / lsp / ast）可用性与约束设计

日期：2026-08-07
状态：待用户审查

## 背景与问题

用户观察到动态编排工作流（`omp-dynamic-workflows` 的 `WorkflowAgent` 子代理）没有使用
`codegraph`、`lsp`、`ast` 等代码智能工具。最初怀疑工具缺失，实测后修正：

| 工具 | 子代理会话实测 | 说明 |
| --- | --- | --- |
| `codegraph_explore` | ✅ 存在 | `~/.omp/agent/extensions/codegraph.ts` 经 `preloadedExtensionPaths` 注入 |
| `ast_edit` | ✅ 存在 | SDK 在工具面含 `edit` 且 `astEdit.enabled` 时自动加入 |
| LSP（`lsp` 设备） | ❌ 缺失 | `src/agent.ts:942` 硬编码 `enableLsp: false` |

**根因**：子代理未用 codegraph 不是工具缺失，而是：

1. **codegraph 技能无强制约束**：`SKILL.md` 只有调用判定表（"命中时应调用"），
   没有不可协商的强约束条款，也没有对抗合理化借口的红线。子代理/主代理都可能在
   "先 grep 看看" 的借口中绕过。
2. **内置工作流 prompt 无引导**：`generateCodebaseAuditWorkflow` 等生成的子代理
   prompt 只要求 read/grep，不引导 codegraph/lsp/ast 的用法顺序。
3. **LSP 被硬关**：`agent.ts:942` `enableLsp: false`，SDK 默认
   `enableLsp = options.enableLsp ?? !restrictToolNames`（子代理
   `restrictToolNames=false` 时默认开），是显式传 `false` 关掉的。

## 设计

### 1. codegraph skill 强约束化

更新 `~/dev/omp-codegraph/skills/codegraph/SKILL.md`，同步
`~/.claude/skills/codegraph/SKILL.md`（两者当前字节一致）。

新增内容：

- **`<EXTREMELY-IMPORTANT>` 强约束块**（仿 superpowers:using-superpowers）：
  - 判定命中（探索/理解结构、关系影响、定位实现、编辑重构删除）时**必须**调用
    `codegraph_explore`，不可协商。
  - 子代理场景声明：`codegraph_explore` 在 omp 动态编排子代理会话中**可用**
    （经扩展 preload）；若工具缺失，用 `bash: codegraph explore "<查询>"` 回退。
- **合理化借口红线表**：列出并反驳常见绕过借口：
  - "先 grep 看看有没有这个符号" → grep 给不了调用关系/影响面
  - "代码量小，直接读就行" → 小代码库也有跨文件调用链
  - "我记得这个代码库的结构" → 记忆会过期，索引是当前的
  - "codegraph 没索引/太慢" → 先 `codegraph init` 再查询，一次性成本
  - "这个改动只碰一个文件" → 一个文件的改动也影响调用方
- **工具分工矩阵**：结构探索/影响面 → `codegraph_explore`；
  符号精确定位、跨文件重命名、类型 → `lsp`（子代理开启后）；机械/结构性改写 →
  `ast_edit`。三者互补，不是替代关系。
- 保留现有调用判定表与 no-index 初始化指引。

### 2. 动态编排工作流修复（omp-dynamic-workflows）

**B1：LSP 可配置，默认开启**
- `src/agent.ts`：`WorkflowAgentOptions` 增加 `enableLsp?: boolean`；
  `createAgentSession` 的 `enableLsp` 由硬编码 `false` 改为
  `options.enableLsp ?? this.sessionOptions.enableLsp ?? true`（默认开，用户决策）。
- `src/workflow-settings.ts`：`WorkflowSettings` 增加 `enableLsp?: boolean`，
  `normalizeSettings` 解析（与 `enableIrc` 同模式，`?? true`）。
- `src/workflow-manager.ts`：`WorkflowManagerOptions` 增加 `enableLsp` 透传。
- 所有子代理默认获得 LSP；`~/.omp/workflows/settings.json` 设 `enableLsp: false`
  可关闭（无语言服务器的环境）。
- 备注：SDK 在 `enableLsp && !options.hasUI` 时不启动惰性 LSP（`lsp.lazy` 分支），
  子代理 `hasUI: false` 走非惰性路径——需在实现时验证子代理会话 LSP 可用性。

**B2：内置工作流 prompt 引导**
- `src/code-review.ts` / `src/deep-research.ts`（含 codebase-audit，已加 CLI 引导）：
  在子代理 prompt 中注入统一方法段：
  ```
  Method (use in order):
  1. codegraph_explore "<针对本任务区域的查询>"（或 bash: codegraph explore）建立符号与影响面
  2. read/grep 验证具体实现
  3. 机械/结构性改写用 ast_edit；符号精确定位用 lsp（若可用）
  ```
- 推广到 `adversarial-review.ts` / `multi-perspective`（若涉及代码库场景）。

### 3. codegraph 插件修复（~/dev/omp-codegraph）

- **文案矛盾**：扩展描述 "NEVER run the codegraph CLI directly instead of this tool"
  与 skill 的 CLI 回退冲突。统一为：工具存在时用工具；工具缺失（如某些子代理
  环境）时用 CLI，两者输出相同。
- **无索引引导**：保留手动 init 指令（子代理场景下模型用 bash 执行），
  `run()` 超时 90s 对 `codegraph init` 可能不够——init 引导文案中提示
  `codegraph index` 可后台运行（`bash: codegraph index ... &` 或分步 sync）。
  仅改引导文案，不改超时逻辑（explore/query 本身 90s 充足）。

## 错误处理与边界

- LSP 默认开启（用户决策）；无语言服务器环境的用户可显式 `enableLsp: false` 关闭。
- 子代理会话 `hasUI: false`，SDK 的 `lsp.lazy` 惰性启动分支（`enableLsp && options.hasUI`）
  不适用——需实测非惰性路径下子代理 LSP 可用性。
- skill 强约束只影响提示词内容，不改变工具注册 → 无运行期风险。
- 工作流 prompt 引导是生成器文本改动，`builtin-preview.test.ts` 断言脚本形状
  （若断言 prompt 全文则需同步更新）。

## 测试

- 单元：`workflow-settings` 的 `enableLsp` 解析与 `?? false` 语义。
- 生成器：断言 code-review/codebase-audit 生成的脚本含 codegraph 方法段。
- 集成（手工）：settings.json 开 `enableLsp: true` 后跑一次迷你工作流，确认
  子代理 `getAllToolNames()` 含 `lsp`；skill 强约束经子代理会话实测生效。
- skill 验证：`~/dev/omp-codegraph` 内跑一个子代理压力场景（探索任务），确认
  调用 `codegraph_explore` 而非直接 grep（红→绿验证）。

## 范围外（YAGNI）

- 不新增 codegraph 扩展工具（node/callers 等单独暴露）——CLI 已覆盖，子代理有 bash。
- 不做 MCP 版 codegraph 传输迁移——现有 CLI-wrapper 扩展工作正常。
- 不批量重写全部内置工作流 prompt——只改涉及代码库场景的生成器。
