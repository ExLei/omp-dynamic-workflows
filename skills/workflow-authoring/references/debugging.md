# 工作流调试地图

从症状出发，然后通过真实的工作流运行时与确定性的假智能体复现问题。

| 症状 | 可能的编写原因 | 检查 |
| --- | --- | --- |
| 解析器提示元数据缺失 | `export const meta` 不是第一条语句或非字面量 | [运行时](runtime.md#script-envelope) |
| `parallel()` 拒绝输入 | 传入的是 Promise 而非 thunk | [运行时](runtime.md#topology) |
| 综合过早开始 | 扇出结果未作为一整个完整结果集 await | [模式选择](pattern-selection.md#fan-out-and-synthesize) |
| 覆盖静默消失 | `null` 结果在 ID 记账之前被过滤 | [生命周期](lifecycle.md#retry-and-recoverable-failure) |
| 使用了错误的模型 | 更高优先级的选择器覆盖了预期路由 | [注册表归属](registry-ownership.md#priority) |
| 出现未知 `agentType` 日志 | 猜测了实时注册表名称或该名称不可用 | [注册表归属](registry-ownership.md#agent-types) |
| 预算超出显示的数字 | 预算是调用前的软门禁，且工作仍在进行中 | [生命周期](lifecycle.md#bounds-and-budget) |
| 后续调用在恢复时重新执行 | 较早的调用缺失或变更，导致可重放前缀终止 | [生命周期](lifecycle.md#resume) |
| 恢复时重新执行已「成功」过的调用 | 其仅有的先前尝试以可恢复失败（如 `AGENT_EMPTY_OUTPUT`）结束，且从未记账 | [生命周期](lifecycle.md#resume) |
| 从 `agent()` 结果读取的字段为 `undefined` | 未设置 `schema`；提示要求返回 JSON 并不会改变 `agent()` 返回原始文本这一事实 | [生命周期](lifecycle.md#serialization) |
| 嵌套工作流失败 | 嵌套超过一层或共享限制耗尽 | [生命周期](lifecycle.md#nesting-and-shared-state) |
| 检查点不显示表单 | 输入/选择/超时行为仅声明而未实现 | [生命周期](lifecycle.md#checkpoints) |
| 返回的结果无法跨越边界 | 其中包含函数、Promise、循环引用、`BigInt` 或运行时对象 | [生命周期](lifecycle.md#serialization) |
| `Date.now()`/随机性被拒绝 | 恢复要求确定性的调用结构 | [生命周期](lifecycle.md#resume) |

## 调试流程

1. 缩减到保留元数据、标签、工作 ID 与失败拓扑的最小脚本。
2. 用确定性、schema 感知的假智能体替换提供商调用。
3. 记录调用顺序、标签、阶段、提示、结果与 `null` 条目。
4. 当失败涉及有争议的签名或默认值时，与紧凑的[能力索引](capabilities.md)对照；仅在必要时跟随其穷尽事实指针。
5. 区分运行时缺陷与不受支持的编写假设及兼容性专属行为。
6. 只修复已证实的编写问题；不要依赖已知超出范围的缺口，如嵌套持久化、恢复记账、检查点表单/超时、元数据校验或预算超支。
