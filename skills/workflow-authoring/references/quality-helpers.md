# 校验与评审

在可能省略失败智能体的 helper 结果之外，保留工作 ID。

| 调用 | 契约 |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string \| string[] })` | 默认值：2 名审阅者、含 `0.5` 的门槛、单个视角或循环数组。返回 `{ real, realCount, total, votes }`。失败的审阅者被省略；成功的投票是分母；零幸存者意味着 `real: false`。 |
| `judgePanel(attempts, { judges: number, rubric: string })` | 默认值：3 名评审者与 `"overall quality and correctness"`。失败的评审被省略。返回最高均值 `{ index, attempt, score, judgments }`；平局时输入顺序优先；空输入返回 `undefined`。 |
