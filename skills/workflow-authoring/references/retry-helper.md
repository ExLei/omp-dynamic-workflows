# 重试

`retry(thunk, { attempts, until })` 只接受这 2 个参数；`until` 属于选项对象。它以从零开始的索引调用 `thunk(attempt)`，默认 3 次尝试。`until` 是同步的——返回 Promise 或省略谓词都会接受首个结果。耗尽时只返回最后一个结果，因此请保留尝试账本。

始终 `await retry()`。包含 `await` 的 thunk 必须是 `async`；在把 `agent()` 的解析值加入账本之前先 await 它。运行时重试会重复可恢复的执行失败；helper 尝试是新的语义调用。两层都要设限，并为耗尽记账。
