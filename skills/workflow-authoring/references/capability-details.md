<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# 详尽的工作流能力事实

契约格式：`1.0.0`<br>
契约内容 / 技能 / 扩展：`0.1.0`

下方每条确切事实均由已安装扩展的能力契约投影而来。解释性判断应放在本文件旁的手写参考文档中。

<a id="agent"></a>
## agent

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`agent(prompt, options?) => Promise<string \| structured value \| null>`
- 选项结构：`agent-options`
- `label`：string（可选；默认：由阶段与调用次数推导）
- `phase`：string（可选；默认：当前阶段）
- `schema`：plain JSON Schema（可选）
- `model`：string（可选；优先级最高的精确模型选择器）
- `tier`：string（可选；已配置的路由名；动态引用：model-routes）
- `isolation`："worktree"（可选）
- `agentType`：string（可选；必须来自给定上下文；动态引用：agent-types）
- `timeoutMs`：number | null（可选；默认：运行超时；null 表示禁用）
- `retries`：number（可选；默认：运行重试次数；有限值向下取整并限制在 0..3）
- 约束：可恢复失败在重试后返回 null；不可恢复失败抛出异常
- 约束：有界结构化输出修复后仍不符合 schema 属不可恢复，绕过智能体重试
- 约束：单智能体重试覆盖调用级重试；重试次数向下取整并限制在 0..3
- 约束：恢复（resume）只重放最长未变化前缀；第一个失配点及之后的每次调用都实时执行
- 约束：选择器优先级为 显式 model > agentType model > tier > phase model > metadata model > 隐式中档 > 会话默认
- 约束：显式 model、agentType model、tier 或 phase model 解析到不可用模型时抛出 MODEL_NOT_FOUND 并指明来源（例如 tier 及其解析结果），而不是回退
- 约束：只有隐式默认中档（未显式请求 model、tier、agentType 或 phase model）在不可用时降级到会话默认，并记录一次运行可见的警告而非抛出异常
- 约束：worktree 隔离为尽力而为；失败时记录隔离被忽略并继续运行，不使用隔离工作目录

<a id="parallel"></a>
## parallel

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`parallel(thunks) => Promise<Array<unknown \| null>>`
- 约束：要求传入函数而非 Promise
- 约束：结果顺序与输入顺序一致
- 约束：可恢复的 thunk 失败变为 null；不可恢复失败抛出异常

<a id="pipeline"></a>
## pipeline

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`pipeline(items, ...stages) => Promise<Array<unknown \| null>>`
- 约束：items 并发运行，每个 item 的各阶段串行
- 约束：每个阶段接收 previousValue、originalItem 和从零开始的索引
- 约束：null 阶段结果会传给下一阶段；作者必须显式防护缺失覆盖
- 约束：可恢复的阶段失败变为 null；不可恢复失败抛出异常

<a id="workflow"></a>
## workflow

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`workflow(savedName, childArgs?) => Promise<unknown>`
- 约束：只允许一层嵌套
- 约束：共享限流器、计数器、token 记账与 store
- 约束：嵌套工作流不复用父级的恢复日志

<a id="verify"></a>
## verify

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>`
- 选项结构：`verify-options`
- `reviewers`：number（可选；默认：2；作者应提供有限整数；运行时将低于 1 的值限制为 1）
- `threshold`：number（可选；默认：0.5）
- `lens`：string | string[]（可选）
- 约束：审阅者失败被省略；成功投票构成 realCount / total 的分母
- 约束：阈值比较为包含式；无审阅者成功时 real 为 false
- 约束：多个视角在审阅者之间轮转

<a id="judgepanel"></a>
## judgePanel

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>`
- 选项结构：`judge-panel-options`
- `judges`：number（可选；默认：3；作者应提供有限整数；运行时将低于 1 的值限制为 1）
- `rubric`：string（可选；默认："overall quality and correctness"）
- 约束：失败判定被省略；每个候选分数只对成功判定取平均
- 约束：无成功判定的候选得 0 分
- 约束：最高平均分胜出，以稳定输入索引作为平局裁决；空输入返回 undefined

<a id="loopuntildry"></a>
## loopUntilDry

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>`
- 选项结构：`loop-until-dry-options`
- `round`：(roundIndex: number) => unknown[] | Promise<unknown[]>（必填）
- `key`：(item: unknown) => string（可选；默认：JSON.stringify）
- `consecutiveEmpty`：number（可选；默认：2；作者应提供有限整数；运行时将低于 1 的值限制为 1）
- `maxRounds`：number（可选；默认：50；作者应提供有限正整数）
- 约束：roundIndex 从零开始；null、非数组或只含重复项的轮次结果视为空
- 约束：token 预算或智能体上限耗尽时返回已积累的部分数组，而不是抛出异常
- 约束：返回数组不报告终止原因是耗尽、maxRounds 还是容量不足
- 约束：作者必须在辅助函数之外保留失败轮次身份与真实的终止状态

<a id="completenesscheck"></a>
## completenessCheck

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>`
- 约束：序列化结果证据的前 4,000 个字符才会发送给评判模型
- 约束：missing 为可选；可恢复的评判模型失败返回 null
- 约束：依赖咨询性结论前，大型证据集必须分块或摘要

<a id="retry"></a>
## retry

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>`
- 选项结构：`retry-options`
- `attempts`：number（可选；默认：3；作者必须提供有限整数；运行时将低于 1 的值限制为 1）
- `until`：(result: unknown) => boolean（可选；默认：省略时接受第一个结果；必须为同步；异步校验请使用 gate）
- 约束：attempt 从零开始，attempts 计 thunk 总调用次数
- 约束：until 必须同步；返回 Promise 视为真值并接受第一个结果
- 约束：省略 until 时无论 attempts 多少都接受第一个结果
- 约束：until(result) 为 true 时停止；耗尽时只返回最后一个结果，不带尝试元数据
- 约束：覆盖默认值时作者必须提供有限的 attempts 上限

<a id="gate"></a>
## gate

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>`
- 选项结构：`gate-options`
- `attempts`：number（可选；默认：3；作者必须提供有限整数；运行时将低于 1 的值限制为 1）
- 约束：首次 thunk 调用时 feedback 为 undefined，之后接收上一次 validator 的 feedback 字符串
- 约束：thunk 的 attempt 从零开始，返回的 attempts 计数从一开始
- 约束：validator 返回带真值 ok 属性的对象时接受该值；裸布尔不接受
- 约束：耗尽时返回 ok false，附带最后一个值与受限的 attempts 计数
- 约束：覆盖默认值时作者必须提供有限的 attempts 上限

<a id="checkpoint"></a>
## checkpoint

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`checkpoint(prompt, options?) => Promise<unknown>`
- 选项结构：`checkpoint-options`
- `default`：unknown（可选；默认：无 UI 且省略时为 true）
- `headless`："default" | "abort"（可选；默认："default"）
- `kind`："confirm" | "input" | "select"（可选；默认："confirm"）
- `choices`：string[]（可选）
- `timeoutMs`：number（可选）
- 约束：前台 confirm 与 headless 行为已实现；input/select/timeout 仅声明未接通
- 约束：消耗一个智能体槽位且不消耗 token
- 约束：记录的答案只在未变化的恢复前缀内重放

<a id="log"></a>
## log

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`log(message) => void`

<a id="phase"></a>
## phase

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`phase(title, options?) => void`
- 选项结构：`phase-options`
- `budget`：number（可选；调用前的正向软性 token 门）
- 约束：阶段预算为调用前的软性门

<a id="args"></a>
## args

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`args: unknown`

<a id="cwd"></a>
## cwd

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`cwd: string`

<a id="process"></a>
## process

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`process: { cwd(): string }`

<a id="budget"></a>
## budget

- 分类：`runtime-global`
- 支持：`supported`
- 签名：`budget: { total, spent(), remaining() }`
- 约束：共享软 token 记账的冻结视图
- 约束：花费在智能体结束后才累计，因此进行中的工作可能超支
- 约束：嵌套工作流共享同一记账

<a id="console"></a>
## console

- 分类：`runtime-global`
- 支持：`compatibility`
- 签名：`console: { log, info, warn, error }`
- 约束：新工作流应使用 log()

<a id="tool-input-script"></a>
## script

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`script?: string`
- 约束：未提供 `name` 时必须为原始 JavaScript 工作流源码

<a id="tool-input-name"></a>
## name

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`name?: string`
- 约束：先解析项目/用户的已保存工作流，再解析 5 个内置模式之一
- 约束：与 resumeFromRunId 互斥

<a id="tool-input-args"></a>
## args

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`args?: unknown`

<a id="tool-input-background"></a>
## background

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`background?: boolean = true`
- 约束：后台工作流为无头模式；需要 checkpoint 显示前台确认时请使用 background false

<a id="tool-input-maxagents"></a>
## maxAgents

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`maxAgents?: number = 1000`
- 约束：默认值，不是产品硬上限

<a id="tool-input-concurrency"></a>
## concurrency

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`concurrency?: number`
- 约束：运行时限制在 1..16

<a id="tool-input-agentretries"></a>
## agentRetries

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`agentRetries?: number = configured value or 0`
- 约束：向下取整并限制在 0..3

<a id="tool-input-agenttimeoutms"></a>
## agentTimeoutMs

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`agentTimeoutMs?: number = configured default or unbounded`

<a id="tool-input-tokenbudget"></a>
## tokenBudget

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`tokenBudget?: number = configured default or unlimited`
- 约束：调用前的软性门；进行中的工作可能超支

<a id="tool-input-resumefromrunid"></a>
## resumeFromRunId

- 分类：`workflow-tool-input`
- 支持：`supported`
- 签名：`resumeFromRunId?: string`
- 约束：用编辑过的脚本恢复此前未完成的运行
- 约束：未变化的位置调用从缓存重放，直到第一个变化或插入的调用
- 约束：始终在后台运行

<a id="metadata"></a>
## export const meta

- 分类：`script-contract`
- 支持：`supported`
- 签名：`export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, model?: string }`
- 约束：必须是首条语句
- 约束：name 与 description 必须为非空字符串
- 约束：元数据必须使用字面量；字符串拼接与模板插值等表达式会被拒绝
- 约束：meta 声明是唯一合法的导出，因为其余函数体在 async 函数内执行

<a id="return-value"></a>
## 工作流返回值

- 分类：`script-contract`
- 支持：`supported`
- 签名：`return JSON-serializable data`
- 约束：不要返回函数、Promise、循环引用对象、BigInt 或运行时句柄

<a id="determinism"></a>
## 确定性脚本执行

- 分类：`script-contract`
- 支持：`supported`
- 签名：—
- 约束：Date.now()、Math.random() 与无参 new Date() 不可用
- 约束：时间戳与随机性经 args 传入

<a id="compatibility"></a>
## 整脚本 Markdown 围栏剥离

- 分类：`compatibility-behavior`
- 支持：`compatibility`
- 签名：—
- 约束：为兼容而接受，但不推荐

<a id="model-routes"></a>
## 模型路由

- 分类：`dynamic-reference`
- 支持：`supported`
- 签名：—
- 约束：动态值不得复制进静态契约数据
- 动态引用归属：`model-tier-config`
- 条目结构：`{ name: string; description?: string }`
- 未来查找连接：`loadModelTierConfig`
- 此静态引用有意不包含动态值。

<a id="agent-types"></a>
## 智能体类型

- 分类：`dynamic-reference`
- 支持：`supported`
- 签名：—
- 约束：动态值不得复制进静态契约数据
- 动态引用归属：`agent-registry`
- 条目结构：`{ name: string; description?: string }`
- 未来查找连接：`loadAgentRegistry`
- 此静态引用有意不包含动态值。
