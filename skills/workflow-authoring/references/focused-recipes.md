# 场景配方

只阅读与场景匹配的配方。修改任务提示、schema、界限与上下文提供的输入；保留列出的契约。

| 场景 | 改编时保留 | 已验证配方 |
| --- | --- | --- |
| 分阶段预算 | 阶段与运行预算是调用前的软门禁；进行中的工作可能超支。独立报告共享花费，并分别限制调用。 | [分阶段预算](../examples/phased-budgets.js) |
| 已保存工作流 | 使用上下文提供的名称，按序 await 作业，只嵌套一层，并将共享限制、计数器、token、限流器与存储视为父级容量。 | [已保存的嵌套工作流](../examples/saved-nested-workflows.js) |
| 语义重试 | 与可恢复的运行时重试区分开。每次有界尝试使用新的唯一标签，并返回尝试账本与耗尽结果。 | [有界语义重试](../examples/bounded-semantic-retry.js) |
| 校验器反馈 | 遵循[专用 helper](specialized-helpers.md)中 `gate()` 的精确回调。返回门禁结果与尝试账本，使反馈与耗尽保持可见。 | [已验证门禁](../examples/validated-gate.js) |
| 结构化字段 | 在读取字段前传入小型纯 JSON Schema。对可恢复的 `null` 记账；将耗尽的 schema 修复视为不可恢复的失败。 | [结构化输出](../examples/structured-output.js) |
| 防御性文本解析 | 无 `schema` 时，即使提示要求 JSON，`agent()` 也始终解析为原始文本。在读取字段前解析并校验形状；将不可解析文本与可恢复的 `null` 分开记账。形状重要时优先使用 `schema`。 | [防御性 JSON 解析](../examples/defensive-json-parsing.js) |
