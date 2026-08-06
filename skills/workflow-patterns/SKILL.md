---
name: workflow-patterns
description: 5 个内置工作流模式（deep-research、adversarial-review、code-review、multi-perspective、codebase-audit）的参数形态，可通过 `workflow` 工具的 `name` 输入直接运行，无需斜杠命令语法。适用于「研究 X」「对这份内容做事实核查或对抗性审查」「审查这个 diff/PR」「从多个视角分析」「审计代码库中的 Y」等请求。若需编写新的工作流脚本，见 workflow-authoring。
metadata:
  version: "0.1.0"
---

# 内置工作流模式

omp-dynamic-workflows 内置 5 个经过筛选和测试的工作流模式。每个模式同时也是
斜杠命令（`/deep-research`、`/adversarial-review`、`/code-review`、
`/multi-perspective`、`/codebase-audit`），但也可以直接从 `workflow` 工具
调用：把 `name` 设为下面的模式名、`args` 按对应形态传入即可，而不必从头编写
等价脚本。只要请求符合其中某一种形态，就优先这样做而不是新写脚本：这些精选
版本已经过审查与测试。

同名项目级或用户级已保存工作流总是优先于同名内置工作流，斜杠命令也一样。

这 5 个名称只能在 `workflow` 工具的顶层 `name` 输入中使用，不能通过脚本内的
`await workflow(savedName, childArgs)` 辅助函数调用；该辅助函数只解析已保存
工作流。在脚本内部调用 `workflow('deep-research')` 会因已保存工作流未知而
失败；请改用顶层 `name` 输入。

## 模式

| `name` | 适用场景 | `args` |
| --- | --- | --- |
| `deep-research` | 通过交叉核验的资料来源，在网络上研究一个问题 | `{ question: string, angles?: number, minSupport?: number }`；`angles`（默认 4）是不同搜索查询的数量；`minSupport`（默认 2）是一条论断要经受住交叉核验所需的最少不同来源数 |
| `adversarial-review` | 调查某个任务或论断，再由持怀疑态度的审阅者交叉核验每一条发现 | `{ task: string, reviewers?: number, threshold?: number }` |
| `code-review` | 对 diff 进行多角度审查（正确性、复用、简化、效率、抽象层次） | `{ diff: string, diffSource?: string }`；先自行获取 `diff`（例如 `git diff`、`gh pr diff <n>`），该路径不会替你抓取 |
| `multi-perspective` | 从多个独立视角并行分析一个主题，再综合成结论 | `{ topic: string, perspectives?: string[] }`；省略或少于 2 个时使用默认视角集（技术、产品、安全、用户体验、可维护性） |
| `codebase-audit` | 针对代码库范围运行并行检查，再交叉验证并报告 | `{ scope: string, checks: string[] }` |

## 示例

```json
{ "name": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

这是一次 `workflow` 工具调用，不是脚本，请完全省略 `script`。启动模式由 `syncMode`
决定：TUI 会话默认后台，无 UI 会话默认同步；`background`、`maxAgents`、`concurrency`、
`agentRetries`、`agentTimeoutMs`、`tokenBudget` 这些参数仍然全部生效。

## 需要时编写新的工作流

如果请求不符合这 5 种形态中的任何一种，照常使用 `script` 编写脚本，参见
workflow-authoring 技能。
