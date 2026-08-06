# 运行时编写

常规脚本使用本页。仅当本页缺少签名、默认值、支持边界或已安装版本事实时，才打开生成的能力索引。

## 脚本外壳

以唯一合法的导出开头：`export const meta = { name, description, phases?: [{ title, detail?, model? }] }`。值为非空字面量；只声明用到的阶段，并在每个阶段的工作前调用 `phase()`。其余函数体已运行在 async 函数内部：把 helper 写成普通声明；`export default` 与其他导出无效。显式返回结果。

运行时提供 `agent`、`parallel`、`pipeline`、`workflow`、质量/控制 helper、`phase`、`log`、`args`、`cwd`、受限的 `process.cwd()` 与 `budget`。导入、`require()`、文件系统模块、`Date.now()`、`Math.random()` 与无参 `new Date()` 不可用。Node VM 领域是实现基底，不是安全边界或公开 API。

## 拓扑

- `parallel()` 接受 thunk，运行独立工作，并保持输入顺序。在做整体综合前，await 整个数组。
- `pipeline()` 对每条目按顺序运行阶段，同时条目并发推进。每个阶段接收 `(previousValue, originalItem, index)`，并把 `null` 转发给下一阶段，因此先防护缺失覆盖。
- `workflow(name, childArgs?)` 运行上下文提供的已保存工作流。嵌套只有一层，并共享限制、计数器、token 与存储。

## 数据与失败

调用 `agent(prompt, { label, schema? })`；它返回文本、schema 校验后的值或可恢复的 `null`。不可恢复的限制、校验与预算失败会抛出。在过滤之前记录每个预期工作 ID。`null` 表示缺失覆盖，绝不是否定性结论。

当 JavaScript 读取字段时，传入小型纯 JSON Schema。修复后的 schema 不合规会抛出并绕过智能体重试。只有在返回显式的不完整结果而不读取缺失字段时才捕获它。返回对象、数组、字符串、数字、布尔值与 `null`——而不是函数、Promise、循环引用、`BigInt` 或运行时句柄。

## 路由与支持

选择器优先级为显式 `model` > `agentType` 模型 > `tier` > 阶段模型 > 元数据模型 > 隐式 `medium` > 会话默认。不可用的显式选择器（`model`、`agentType` 模型、`tier` 或阶段模型）会抛出而不是回退——如果脚本需要优雅降级，就捕获它。只有未打标签的智能体落入的隐式默认 `medium` 分层在不可用时降级到会话默认，并在运行中记录一次性警告。仅在上下文提供名称与用途时才使用精确 `model`、非标准 `tier` 或 `agentType`。工作树隔离是尽力而为的。参见[注册表归属](registry-ownership.md)。

标记为 `supported` 的生成条目是编写 API。`console` 与整篇脚本的 Markdown 围栏仅用于兼容。VM 领域设施是内部的。活动模型路由与智能体类型是动态的。新脚本使用 `log()`。
