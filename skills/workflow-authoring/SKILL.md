---
name: workflow-authoring
description: 关于为 omp-dynamic-workflows 编写、编辑、审阅与调试 JavaScript 工作流代码的指南。适用于 编写或修改工作流脚本；仅运行已有工作流时无需使用。
metadata:
  version: "0.1.0"
---

# 工作流编写

当工作流 JavaScript 代码发生变更时加载本技能。仅运行已有工作流无需编写参考。

## 选择分支

只阅读任务所需的内容：

- **编写或编辑：** 从[运行时](references/runtime.md)开始。拓扑参考[模式选择](references/pattern-selection.md)，限制或恢复参考[生命周期](references/lifecycle.md)，对应场景参考[场景配方](references/focused-recipes.md)。
- **helper 任务：** 仅用于 `verify` 或 `judgePanel` 时阅读[质量 helper](references/quality-helpers.md)，仅用于 `retry` 时阅读[重试 helper](references/retry-helper.md)，仅用于 `completenessCheck`、`loopUntilDry`、`gate` 或 `checkpoint` 时阅读[专用 helper](references/specialized-helpers.md)。**需要运行中人工/代理干预（`consult`）时**阅读[运行时](references/runtime.md)的「咨询」小节。
- **审阅：** 使用[审阅清单](references/review.md)，外加仅匹配的[质量](references/quality-helpers.md)或[专用](references/specialized-helpers.md) helper 契约。
- **调试：** 使用[调试地图](references/debugging.md)。
- **路由：** 使用 `model`、`tier`、阶段模型或 `agentType` 之前，先阅读[注册表归属](references/registry-ownership.md)；仅当上下文提供环境专用名称时才使用它们。
- **精确查询或可移植性：** 从生成的[能力索引](references/capabilities.md)开始。仅当涉及约束或支持边界时，再跟随其穷尽事实指针。在安装之间迁移脚本时使用[版本](references/versions.md)。

## 不变量

- 以字面量 `export const meta = { name, description }` 开头；将阶段声明为所用 `{ title }` 对象的数组，并进入每个具名阶段。
- 至少调用一次 `agent()`，为每次调用赋予简短唯一的 `label`，并显式返回纯 JSON 数据。
- 在过滤之前，将有序结果与稳定的工作 ID 配对。当一个智能体消费另一个智能体已选中的结果时，在下游提示中同时包含其稳定 ID 与实际数据。将可恢复的 `null` 视为缺失覆盖并报告。
- 将扇出、循环、重试、智能体与并发限制在与任务相符的范围内。将调用级 token 与时间上限视为可选加入的用户约束，而非默认值。
- 新代码使用 `log()`；`console` 仅用于兼容。
- 需要人工/代理干预时用 `consult()`：live 执行在该行中断并挂起运行，重放命中时返回已决结果（live 抛、replay 返回是同一 API 的两种行为）。
- 编写不含导入或文件系统模块的纯 JavaScript。通过 `args` 传递不确定性；`Date.now()`、`Math.random()` 与无参 `new Date()` 不可用。
