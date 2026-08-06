# helper 参考索引

仅当 helper 表达了任务的策略时使用它。在可能省略失败智能体的 helper 结果之外，保留候选或工作的身份。

- 使用 `verify()` 或 `judgePanel()` 时阅读[质量 helper](quality-helpers.md)。
- 使用 `retry()` 时阅读[重试 helper](retry-helper.md)。
- 使用 `completenessCheck()`、`loopUntilDry()`、`gate()` 或 `checkpoint()` 时阅读[专用 helper](specialized-helpers.md)。

运行时智能体重试会重复可恢复的执行失败；helper 尝试是新的语义调用。两层都要设限，并为耗尽记账。
