<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# 工作流能力索引

契约格式：`1.0.0`<br>
契约内容 / 技能 / 扩展：`0.1.0`

本紧凑的生成索引覆盖受支持的运行时全局与工作流工具输入。涉及约束、兼容行为、内部边界与动态引用归属时，请跟随[穷尽生成事实](capability-details.md)。

## 支持的能力索引

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| 名称 | 分类 | 签名 | 选项与默认值 |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`：string（可选；默认：由阶段与调用次数推导）<br>`phase`：string（可选；默认：当前阶段）<br>`schema`：plain JSON Schema（可选）<br>`model`：string（可选）<br>`tier`：string（可选）<br>`isolation`："worktree"（可选）<br>`agentType`：string（可选）<br>`timeoutMs`：number \| null（可选；默认：运行超时；null 表示禁用）<br>`retries`：number（可选；默认：运行重试次数） |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| workflow | runtime-global | `workflow(savedName, childArgs?) => Promise<unknown>` | — |
| verify | runtime-global | `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>` | `reviewers`：number（可选；默认：2）<br>`threshold`：number（可选；默认：0.5）<br>`lens`：string \| string[]（可选） |
| judgePanel | runtime-global | `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>` | `judges`：number（可选；默认：3）<br>`rubric`：string（可选；默认："overall quality and correctness"） |
| loopUntilDry | runtime-global | `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>` | `round`：(roundIndex: number) => unknown[] \| Promise<unknown[]>（必填）<br>`key`：(item: unknown) => string（可选；默认：JSON.stringify）<br>`consecutiveEmpty`：number（可选；默认：2）<br>`maxRounds`：number（可选；默认：50） |
| completenessCheck | runtime-global | `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>` | — |
| retry | runtime-global | `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>` | `attempts`：number（可选；默认：3）<br>`until`：(result: unknown) => boolean（可选；默认：省略时接受第一个结果） |
| gate | runtime-global | `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>` | `attempts`：number（可选；默认：3） |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`：unknown（可选；默认：无 UI 且省略时为 true）<br>`headless`："default" \| "abort"（可选；默认："default"）<br>`kind`："confirm" \| "input" \| "select"（可选；默认："confirm"）<br>`choices`：string[]（可选）<br>`timeoutMs`：number（可选） |
| log | runtime-global | `log(message) => void` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`：number（可选） |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining() }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| background | workflow-tool-input | `background?: boolean = true` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or unbounded` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
