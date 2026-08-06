# 专用 helper

在可能省略失败智能体的 helper 结果之外，保留候选或工作的身份。

## 质量

| Helper | 编写契约 |
| --- | --- |
| `completenessCheck(args, results)` | 返回 `{ complete, missing? }` 或可恢复的 `null`。评审者只看到前 4,000 个序列化字符，因此更大的证据要分块或摘要。把裁决视为建议性的。 |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` 从零开始。默认值：`JSON.stringify` 键、两轮干轮、50 轮。null、非数组与仅重复的轮次计为干轮。token 预算或智能体上限耗尽时，返回部分数组而不带终止原因；在 helper 之外保留失败轮次的身份与停止状态。 |

## 控制

| Helper | 编写契约 |
| --- | --- |
| `gate(thunk, validator, { attempts })` | 以初始 `undefined` 反馈与从零开始的尝试次数调用 `thunk(feedback, attempt)`。`validator(value)` 同步或异步返回 `{ ok, feedback? }`；不接受裸布尔值。默认三次尝试。返回 `{ ok, value, attempts }`，耗尽时包含最后的值。参见[已验证门禁](../examples/validated-gate.js)。 |
| `checkpoint(prompt, options?)` | 记账人类/默认决策。只有前台确认与有文档的无头行为可用；输入、选择与超时仅为声明。 |

始终 `await gate()`。包含 `await` 的 thunk 本身必须声明为 `async`；在把 `agent()` 的解析值加入账本之前先 await 它。运行时智能体重试会重复可恢复的执行失败；helper 尝试是新的语义调用。两层都要设限，并为耗尽记账。
