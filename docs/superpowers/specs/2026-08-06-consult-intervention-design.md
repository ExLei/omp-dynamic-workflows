# 工作流运行中干预（consult）设计

日期：2026-08-06
状态：设计稿（五轮对抗审查修订版 v5，审查-修订循环终止）

## 背景与需求

工作流（后台运行、脚本化编排）运行期间需要**人工/代理干预**：在脚本显式声明的干预点暂停，让
审阅者（运行内子代理或主代理）查看进度并**修改脚本**，随后**重放式续跑**（复用已完成调用结果，
只执行变化部分）。

用户确认的需求约束：

1. 干预点由**脚本显式声明**（新增 `consult()` API），不做自动插桩。
2. 修改后**重放式续跑**：journal 重放已完成调用，从 firstMiss 起执行新脚本。
3. 默认**子代理建议直接应用**（`to:"agent", apply:"auto"`）；主代理咨询/确认为可选
   （`to:"main"` / `apply:"confirm"`）。
4. 混合模式：每个阶段结束后默认投递一行进度通知（不阻塞、可关闭），主代理可随时介入。
5. 咨询对象：运行内子代理（默认）或主代理（发起编排的会话 assistant）。

## 设计

### 1. 运行时 API：`consult(prompt, opts?)`

```
consult(prompt: string, opts?: {
  to?: "agent" | "main"        // 咨询对象，默认 "agent"
  agent?: string               // 审阅子代理 agentType 名；省略派生默认审阅代理
  apply?: "auto" | "confirm"   // 默认 "auto"：子代理建议直接应用
  timeoutMs?: number           // 审阅子代理超时，默认 agentTimeoutMs
}) => Promise<ConsultOutcome>   // 重放命中时返回；live 执行时抛 CONSULT_PENDING
```

- **两种行为（规格明确）**：
  - **live 执行**：消耗 1 个 agent 槽位（与 checkpoint 相同），校验参数后**抛专用
    `WorkflowError`（新错误码 `CONSULT_PENDING`，**`recoverable: false`**）**，payload 携带
    `{ journalPrefix, callIndex, prompt, opts }`。脚本执行在该点中断，后续由 manager 层接管。
    `recoverable: false` 是硬约束：`parallel`/`pipeline` 对 **non-recoverable** 的
    `WorkflowError` 才 rethrow、对 recoverable 错误吞成 null 继续跑（workflow.ts:926-930、
    962-966——v2 此处表述写反，v3 修正）——置 true 会被吞成 null、consult 永不挂起。顶层
    逃逸会触发 `runFatalController.abort()`（workflow.ts:1312-1314）——**在飞兄弟 agent 被
    中断**（未 journal、resume 时重跑），这是「干预点暂停」的固有语义，写入文档与测试。
  - **重放命中**：恢复运行时按 `${journalPrefix}${callIndex}` 命中 journal entry → **返回**
    结果对象 `{ applied, revisedScript?, summary }`（live 抛、replay 返回是同一 API 的两种
    行为）。
- 与 checkpoint 同一 journal 流：callSeq 递增、`hashConsult(prompt, opts)`、firstMiss 语义。
  **hash 身份面**：hashConsult 与 VM 侧共用同一实现，固定字段序 + `?? null` 归一（与
  hashCheckpoint 同构，参照 workflow.ts:1524-1534 的 `{promptText, kind: kind??"confirm"}`
  模式）；pendingConsult 持久化**原始** prompt/opts（未经 agent 默认解析），保证 JSON
  往返后 manager 层重算的 hash 与 VM 重放时的 callHash 一致。
- **帧命名空间**：`journalPrefix` 是 consult 所在**帧**的 journal key 前缀——嵌套 `workflow()`
  的子帧为 `${runId}-nestedN:`（workflow.ts workflowFn），顶层为 `${runId}:`。payload 与
  pendingConsult 必须携带它，resolveConsult 才能写入正确命名空间。

### 2. 执行机制（跨 VM / manager 边界）

```
脚本执行到 consult() → 抛 CONSULT_PENDING（recoverable:false，含 journalPrefix/callIndex/prompt/opts）
  → executeRun catch 尾新增分支（判定顺序：usage-limit → CONSULT_PENDING → abort）：
      仅当 managed.status 仍为 "running" **且 `!managed.controller.signal.aborted`**（与
        usageLimitPaused 同款守卫，workflow-manager.ts:846——防 Esc 中断 externalSignal
        竞态：同步路径 Esc 直接 abort controller 不改状态，无此守卫会把用户取消误置为
        waiting_consult）时：
        status = waiting_consult
        pendingConsult = { journalPrefix, callIndex, prompt, opts, revisedScript?, summary?, generation, autoApplied }（ManagedRun 字段）
        persistRun() → releaseRunLease() → 发 consult-pending 事件（**不经过 error 发射链**）
      若 status 已非 running（stop 先落）→ 不覆盖，保持用户操作的结果
  → manager 按 to/apply 分流：
      to:"agent", apply:"auto" → 自动审阅链（见 §3）
      to:"main" → 投递主代理（见 §4）
      to:"agent", apply:"confirm" → **先跑自动审阅链生成建议**（§3 的 1-3 步；校验通过后
        不应用），再投递主代理：消息含 prompt 摘要 + 建议摘要 + revisedScript 落盘路径
        （建议全文可数 KB，投递用摘要+路径引用，规避输出长度限制）→ reply 无 script =
        **采纳建议**（应用审阅产物）、带 script = 覆盖。**注意与 to:"main" 的区别**：
        to:"main" 没有审阅链，主代理直接给答复/脚本
```

**事件发射映射（防误报失败）**：现有 catch 尾的状态链与事件链分离（workflow-manager.ts:
845-884：usageLimitPaused→paused 事件、abort→静默、else→error 事件）。新增分支必须：

| 到达 catch 尾的情形 | 状态 | 事件 |
|---|---|---|
| CONSULT_PENDING 且 status===running | waiting_consult | **仅 consult-pending**（error 不发射；否则 installResultDelivery 会投递「✗ failed」并以 triggerTurn 唤醒，每个 consult 被误报失败） |
| abort 且 status===waiting_consult | 保持 waiting_consult | 静默（沿用 abort 分支语义） |
| abort 且 status===running | aborted | 静默（现状） |
| markConsultFailed 路径 | failed | error 事件（驱动投递与 UsageLimitScheduler 清理） |

### 3. 子代理建议链（to:"agent"）

1. manager 用注入的 agent 能力（`WorkflowAgent.run` 独立于已死的 VM）派生审阅子代理：
   - 输入：当前进度快照摘要（阶段、done/total、tokenTotal）+ 当前脚本全文 + prompt
   - 工具面：默认编码工具集（含**文件写工具**），`workflow`/`workflow_control` 照旧排除
   - **输出约定：把修改后的完整脚本写入指定路径**（`<os.tmpdir()>/consult-<runId>-<generation>-<n>.js`，
     保证唯一），返回 `{ ok: true, summary }` 或 `{ ok: false, reason }`。规避模型单次输出
     长度限制。
2. **审阅链计入运行预算与计数**：审阅子代理的 token 花费计入运行 tokenBudget（经
   manager 记账通道，参照 WorkflowAgent 的 usage 上报）；快照 tokenTotal 反映审阅花费
   （不冻结）。`consultAutoApplied` 在**审阅链每次完成（成功应用或失败）时 +1**——失败
   循环同样有上限，防反复烧钱。**若实现核对发现 WorkflowAgent 无 usage 上报通道，则
   改为 consultReviewBudget 独立上限（默认等于 tokenBudget）并在规格中标注**——不得
   让审阅链花费完全脱离任何预算。
3. 宿主读文件 → `parseWorkflowScript` 校验。失败：**带校验反馈重试 1 次**（第二次审阅子代理
   prompt 携带第一次的 parse 错误）；仍失败 → `markConsultFailed`（§5）。
4. **不做静态调用序对齐校验**（两轮审查确认不可实现）。**re-pend 是预期行为**：resume 重放
   时 consult 调用点 journal miss（子代理改了此前内容）→ 重新 CONSULT_PENDING → 自动审阅链
   再触发。由 `consultAutoApplied` 上限兜底（§3.5）。
5. **自动应用递归上限**：`consultAutoApplied` 是 **run 级持久化字段**（随 PersistedRunState，
   参照 autoResumeAttempts 模式），每次审阅链完成 +1、**不清零**；>5 后自动审阅链不再触发，
   回落 `waiting_consult` 等人工 reply，并**经 deliverWorkflowMessage 投递「运行 X 的自动
   审阅超限，等待人工答复」**（triggerTurn 沿用 wakesTurn/isSilentOrigin 判定——web
   控制台启动的 run 不唤醒回合，其余触发；否则 headless 下静默挂起、无人知晓）。

### 4. 主代理通道与 resolveConsult

- `workflow_control` 新增 action：
  - `reply { runId, script? }`：答复咨询。script 需 `parseWorkflowScript` 通过（否则返回校验
    错误、保持 waiting_consult）；省略 script 的语义：**to:"main" → 维持原脚本继续**
    （journal 写 `{ applied: false, summary: "维持原脚本" }`）；**apply:"confirm" → 采纳
    审阅建议**（应用 §3 生成的 revisedScript，journal 写
    `{ applied: true, revisedScript, summary }`）；**to:"agent"+apply:"auto" 超限回落** →
    沿用「维持原脚本继续」语义（与 to:"main" 一致）。
  - `intervene { runId }`：随时介入。**来源状态：running | paused | waiting_consult**。
    对 running/paused：先置 `waiting_consult` + 创建 `pendingConsult`（to:"main"，
    `generation+1`）+ `persistRun()`，**再 abort controller**（catch 尾 abort 分支只在
    status==="running" 时覆盖，已置状态被保留）；在飞 agent 被中断、resume 重跑。对
    waiting_consult：改投 to:"main" 并投递，**`generation+1`（使在飞自动审阅链失效，见下）**。
  - **跨会话寻址**：reply/intervene 用 `listAllRuns()` 解析 runId（不按当前 sessionId
    过滤——consult 可能投递到另一会话，被唤醒的会话必须能回复）；规格写明：运行归属会话 A、
    投递落在会话 B 时，B 的 workflow_control 也能回复。
  - **intervene 的 journal 锚点**：intervene 创建的 pendingConsult **没有对应的 consult()
    调用**（无 journalPrefix/callIndex 可依）——reply 时**不写 consult journal entry**
    （仅清 pendingConsult → persistRun → resume）；带脚本则走普通 resume 换脚本语义
    （journal 重放原调用序，脚本变化处自然 miss）。
- **journal entry 结构（硬性）**：resolveConsult/markConsultFailed/reply 写入的 entry 必须为
  `{ index, runId, hash, result }`——重放命中条件 `cached.hash === callHash && callIndex <
  firstMiss`（workflow.ts:1219-1221），resumeJournal key 为 `${e.runId ?? runId}:${e.index}`
  （workflow-manager.ts:1239-1241）。`hash` 由 pendingConsult 的 prompt/opts 经 `hashConsult`
  重算；`runId` 为 consult 所在**帧**的 runId（由 journalPrefix 推导，嵌套帧不是顶层
  runId）。缺 hash → 每次重放永远 miss → 反复 re-consult 重复烧钱；缺 runId → 嵌套帧 entry
  归入顶层命名空间错配。
- **`manager.resolveConsult(runId, { script? })` 是唯一收口**：同一同步生命周期内完成
  状态校验（仅 `waiting_consult` 且 pendingConsult 存在；内存与磁盘双路径都支持）→ 追加
  journal entry（正确帧命名空间 + hash）→ 清 pendingConsult → **persistRun()** → resume。
  **persistRun 必须在 resume 之前**：resume() 的唯一 journal 来源是磁盘
  （`this.persistence.load(runId)`，workflow-manager.ts:1193，resumeJournal 由磁盘 journal
  组装），entry 只进内存会在 resume 重建时丢失 → 回复被静默丢弃、重复 re-consult。
  **内部放行**：resume 的 waiting_consult 拒绝守卫（§6）会自锁唯一收口——resolveConsult
  先置 `managed.status = "paused"` 再调 resume()（借用现有 paused 可续跑路径）；磁盘冷
  启动路径（recoverStaleRuns 只翻 running→paused，waiting_consult 原样驻盘）同理。
  `web-server.ts` 的 resume 端点对 `waiting_consult` 运行必须路由到 resolveConsult。
- **在飞审阅链与回复的竞态（代际号，单向）**：`pendingConsult.generation` 初值 0，每次
  intervene 改投（running/paused → waiting_consult，或 waiting_consult 改投 main）时 +1。
  审阅链启动时**捕获当时的 generation**，apply 时经独立入口（applyReviewChain）校验
  pendingConsult.generation 一致——失配（intervene 已改投）则**丢弃审阅结果**（不应用、
  不写 journal、清理 tmp 文件）。**用户 reply 不携带 generation、不受代际约束**，其成败
  仅由「waiting_consult 且 pendingConsult 存在」决定——intervene → 用户回复的主链路
  绝不被代际自锁。
- **投递出口与挂载**：新增 `deliverWorkflowMessage(run, text, { triggerTurn, customType })`，
  由 task-panel 的 installResultDelivery **增挂监听**实现（WorkflowManager 无 pi 句柄，事件
  总线是唯一通道）：
  - **消息正文契约（to:"main"/confirm 的 consult-pending 消息）**：customType 取值
    `workflow.consult`；正文**必须**含 `runId`、prompt 摘要（前 200 字）、回复指引
    （「用 workflow_control 的 reply 动作回复，runId=…」）——跨会话场景（投递落在会话 B）
    下主代理无法用 list 发现归属会话 A 的 runId（findRun 按 sessionId 过滤），runId 必须
    内嵌于消息；confirm 模式追加建议摘要与 revisedScript 落盘路径。
  - **confirm 模式投递时机**：consult-pending 事件在 catch 尾即发（早于审阅链完成）——
    审阅链完成后**再发 consult-review-ready 事件**，installResultDelivery 据此投递含建议
    的第二条消息（triggerTurn:true 同前）；两条消息都带 runId，后者注明「建议已就绪，
    reply 无 script 即采纳」。
  - consult-pending（to:"main"/confirm）→ `triggerTurn: true`（需要主代理回复；web 控制台
    启动的 run 除外——沿用 wakesTurn/isSilentOrigin 语义，不唤醒主代理回合）
  - phaseNotify → `triggerTurn: false`（只记录上下文，不唤醒——否则每阶段一轮计费回合）
  - 自动审阅超限回落 → `triggerTurn` 沿用 wakesTurn 判定（§3.5）
- 竞态防护：reply/intervene 仅在 `waiting_consult` 且 pendingConsult 存在时接受（intervene
  对 running/paused 例外）；运行已终止（completed/failed/aborted）时返回错误；双通道同时
  reply → 先到者成功，后到者状态校验失败被拒。

### 5. 失败与重放语义

| 场景 | 行为 |
|---|---|
| 审阅子代理返回非法脚本（校验失败） | 带校验反馈重试 1 次；仍失败 → `markConsultFailed` |
| 审阅子代理超时 / token 超限 / 派生失败 | 同上失败路径（不静默降级） |
| **markConsultFailed**（单一收口） | 状态校验（仅 waiting_consult）→ 写 journal entry `{ applied:false, reason, settled:false }`（正确帧命名空间 + hash）→ 清 pendingConsult → 置 failed → **persistRun() + recordTerminalRun()**（failed 是终态，recordTerminalRun 是唯一驱逐入口）→ 发 error 事件。**投递文案含 consult 上下文**（runId、prompt 摘要）并指引**唯一可行恢复路径**：「请用 /workflows resume 带脚本恢复（咨询将重新挂起，届时可答复）」——**不指引 reply**（failed 态下 reply 已被 §4 竞态防护拒绝，指了就是死路） |
| consult 失败后用户带脚本 resume | 脚本变化 → consult hash miss → 重新咨询（consultAutoApplied 已 +1，超限回落人工） |
| consult 失败后**普通 resume**（脚本省略或与持久化脚本逐字节相同） | **禁止静默跳过**（两层）：(a) manager 前置 UX 检查：journal 含 `settled:false` 的 consult entry 时拒绝，提示「该运行存在未答复的咨询，请用带脚本恢复（咨询重新挂起后即可答复）」；(b) **VM 重放分支兜底**：`consult()` 重放命中 entry 且 `result.settled === false` 时视为 miss、重抛 CONSULT_PENDING（同一 journalPrefix/callIndex）——覆盖「脚本变更点在 consult 之后」的窗口（manager 字节比较无法预判，静态调用序校验不可行；只有 VM 重放分支能闭合） |
| 主代理 reply 带非法脚本 | workflow_control 返回校验错误，保持 waiting_consult，可重试 |
| 咨询中 stop / rm | **正常终止**：stop() 接受 waiting_consult（内存+磁盘两分支），终止时清除 pendingConsult 与 tmp 审阅文件；catch 尾 CONSULT_PENDING 分支不覆盖已置的 aborted（§2 判定顺序） |
| 咨询中 pause | 拒绝（waiting_consult 下 pause 返回 invalidTransition；介入用 intervene） |
| 咨询中普通 resume | 拒绝——**内存与磁盘回退分支都拦**（workflow-manager.ts:1189-1195） |
| headless 且 to:"agent" 派生审阅子代理失败 | markConsultFailed（同非法脚本），不静默降级 |
| **同步执行路径（headless -p 默认同步）** | 同步 runSync 下 catch 尾置 waiting_consult 后 rethrow → 工具调用报错（**文案按 to 分流**：to:"agent" →「运行 X 已暂停等待咨询答复，自动审阅链已在后台执行，结果将以 follow-up 投递；也可用 /workflows status <id> 查看或经 Web 控制台介入」；to:"main" →「运行 X 已暂停等待主代理答复，请用 workflow_control 的 reply 动作回复（runId=…），或用 /workflows status <id> 查看」——**to:"main" 无审阅链、无 follow-up**）。**to:"agent" apply:"auto" 的自动链照常触发**（manager 后台派生，不阻塞工具返回）。**不额外投递咨询消息**（错误即信号，避免双重信号）；自动链应用后以 background 续跑，结果经 installResultDelivery 照常投递。to:"main" 无答复时运行无限等待（文档写明：等待直到 reply 或 stop，agentTimeoutMs 不作用于等待期） |
| parallel/pipeline 内 consult | recoverable:false → rethrow + runFatalController.abort 中断在飞兄弟（文档写明；测试覆盖） |

**journal 化原则**：consult 无论成败都写入结果 entry（失败含 reason 与 `settled:false`）。
恢复重放命中已决结果，避免重复烧钱；用户改脚本后 prompt 变化自然 miss 重新咨询。

### 6. 状态机触点（逐处接入）

- `RunStatus` 新增 `waiting_consult`：**真实定义在 src/run-persistence.ts:9**
  （`"pending" | "running" | "paused" | "completed" | "failed" | "aborted"`——v2 误写为
  src/enums.ts，该文件只有 capability 枚举）；**web 镜像同步 web/lib/types.ts:11**。
- `allowedActions()`（src/workflow-control-tool.ts:197-210）新增分支：
  `waiting_consult → ["status", "stop", "reply", "intervene"]`（不放 resume/pause）。
- **workflow_control 输入校验层**（normalizeInput，workflow-control-tool.ts:159-175）：
  动作白名单加 `reply`/`intervene`；`reply` 允许 `script` 键（现非 list 动作只允许
  action/runId 两键，否则 `reply {runId, script}` 直接抛「does not accept script」）；
  「requires action: list|status|pause|resume|stop」错误文案同步更新（该文案为
  Error() 消息、不在 zh-copy.test.ts 扫描范围，由 §9 新增的 normalizeInput 测试覆盖）。
- `stop()`（workflow-manager.ts:1330/1363 内存+磁盘分支）接受 waiting_consult。
- `pause()` 仅接受 running（不变）；普通 `resume()` 内存+磁盘分支都拒绝 waiting_consult
  （以及 §5 的 settled:false 检查）。
- executeRun catch 尾：CONSULT_PENDING 分支（以 status==="running" 为前提）与 usage-limit/
  abort 的判定顺序（§2）+ 事件发射映射（§2 表）。
- `consultAutoApplied` 随 PersistedRunState 持久化（参照 autoResumeAttempts）。
- 展示层：task-panel 的 active/finished 过滤把 waiting_consult 计入 active；
  workflow-commands 的 STATUS_ICON 加 waiting_consult 图标；web Runtime.tsx 按钮逻辑
  （介入/回复可用，暂停禁用、恢复改走 resolveConsult）。
- `pendingConsult` 是 **ManagedRun 字段**，随 persistRun 序列化（含 revisedScript、
  generation、autoApplied）；stop/rm 显式清除并清理 tmp 审阅文件。

### 7. 阶段通知（phaseNotify）

- settings（src/workflow-settings.ts）新增 `phaseNotify: "off" | "phase"`，默认 `"phase"`，
  遵循「缺省即省略」不变量。
- 每个 phase **开始时**（onPhase 事件，workflow-manager.ts:721-727 只携带 title——现有
  运行时**没有 phase 结束事件**）投递**上一 phase** 的进度行（阶段名、done/total、
  tokenTotal，数据从快照取）；运行完成/进入 waiting_consult 时补投当前 phase 行。
  **顺序保证**：CONSULT_PENDING 分支在发 consult-pending 事件前先补投当前 phase 行——
  用户先看到进度行、后看到咨询消息。不阻塞、不改变运行状态；"off" 关闭。ACP/TUI/headless
  三态均只追加文本消息，不破坏帧、不唤醒回合。

### 8. Web 控制台

- `POST /api/runs/:id/resume` 支持可选 body `{ script }`（parse 校验；waiting_consult 运行
  路由到 resolveConsult）。
- 运行卡片新增「介入」按钮：对 running/paused 置 waiting_consult + 编辑器加载当前脚本 +
  等待 reply（或用户直接改脚本后带脚本 resume）；对 waiting_consult 直接进编辑器。
- **编辑器初始值**：`GET /api/runs/:id` 对 waiting_consult 返回
  `pendingConsult.revisedScript ?? script`——自动审阅最后一次产物对人工回复路径可见
  （§3.5 回落时把审阅产物写入 `pendingConsult.revisedScript`）。
- 运行状态标签「待咨询」；运行列表与详情显示 pendingConsult 摘要（prompt 前 80 字）。

### 9. 测试

- consult journal 重放：resume 后按 callIndex 重放建议结果对象（live 抛 / replay 返回）；
  **entry 的 hash/runId 正确性**（嵌套帧 entry 落子帧命名空间）
- 审阅子代理 mock：写文件返回新脚本 → 校验 → firstMiss 续跑
- 前缀修改场景：re-pend → consultAutoApplied 递增（成功与失败都计）→ >5 回落 +
  投递通知
- 嵌套 workflow() 内 consult：journal 写入子帧命名空间，resolveConsult 写对 key
- reply（带/不带脚本）与竞态（stop 后 reply、双通道双 reply、**intervene 改投时在飞审阅链
  代际失配丢弃**）
- intervene：对 running 先置状态再 abort、对 waiting_consult 改投 main
- stop 竞态窗口：stop 先落 → catch 尾不覆盖（状态保持 aborted）
- **事件映射**：CONSULT_PENDING 不触发 error 事件/投递；markConsultFailed 触发 error 事件
- waiting_consult 状态机触点：stop/pause/resume（内存+磁盘）/allowedActions/
  task-panel/STATUS_ICON
- waiting_consult 持久化与冷启动恢复（ManagedRun 字段随 persistRun；disk-only 运行
  resolveConsult 路径）
- markConsultFailed：journal 写入（settled:false）+ failed + persistRun + recordTerminalRun +
  error 事件 + 投递文案指引 resume 带脚本（不指引 reply）
- **普通 resume 遇 settled:false entry → 拒绝**
- 同步执行路径（headless -p）：consult 工具报错文案含 runId/回复指引、无双重投递
- 审阅链预算：token 计入运行 tokenBudget、快照 tokenTotal 反映
- parallel 内 consult：中断在飞兄弟（recoverable:false 路径）
- resume 带脚本（web-server + manager）
- phaseNotify：默认 phase 投递一行（triggerTurn:false）、off 关闭
- deliverWorkflowMessage：consult 到 main 触发回合、phaseNotify 不触发、web 启动的 run
  的 consult 不唤醒
- 跨会话：会话 B 的 workflow_control 能回复会话 A 的 run（listAllRuns 解析）
- **VM 重放 settled:false**：consult() 重放命中 `settled:false` entry → 视为 miss 重抛
  CONSULT_PENDING（覆盖「变更点在 consult 之后」窗口）
- **apply:"confirm" 全流程**：审阅链生成建议（不应用）→ 投递摘要+路径 → reply 无 script=
  采纳建议、带 script=覆盖
- **normalizeInput**：动作白名单含 reply/intervene、reply 接受 script 键、错误文案更新
- **同步模式 auto 链**：headless -p 下 consult 工具报错（文案含指引）、自动链后台执行、
  恢复后结果投递
- **phaseNotify 顺序**：consult-pending 前先补投当前 phase 行
- **hash 往返**：原始 opts 持久化 → manager 重算 hash 与 VM callHash 一致（JSON 往返）
- **resolveConsult 顺序**：persistRun 先于 resume；内部放行（置 paused 再 resume）
- **generation 单向**：审阅链 apply 代际失配丢弃；用户 reply 不受代际约束
- **投递消息契约**：to:"main" 消息含 runId/prompt 摘要/回复指引（customType=workflow.consult）
- **confirm 第二条消息**：审阅链完成后 consult-review-ready 投递（建议摘要+路径，reply 无
  script 采纳）
- **intervene 无 journal 锚点**：reply 不写 consult entry，仅清 pending → persist → resume
- zh-copy 守护：新 UI/工具文案中文

### 10. 文档联动

- README.md：运行时全局表（consult，含 live/replay 行为说明与同步路径报错语义）、
  workflow_control 表（reply/intervene）、配置项表（phaseNotify）、状态说明（waiting_consult）
- capability contract：新增 `consult` 运行时全局能力（signature/options/constraints/
  discovery=WORKFLOW_AUTHORING_SKILL；**新建 `consult-options` OptionShape**，字段：
  `to`（"agent" | "main"，默认 "agent"）、`agent`（string，可选）、`apply`
  （"auto" | "confirm"，默认 "auto"）、`timeoutMs`（number，可选））→ 生成器重新
  生成 capabilities.md / capability-details.md（漂移检查零）
- skills/workflow-authoring：references/runtime.md 等补 consult 契约（含 live 抛 /
  replay 返回、confirm 模式、同步路径报错语义）；示例可加 consult 片段
- workflow-authoring skill 的 SKILL.md 不变量清单补 consult（若适用）
- README 的「内置模式」与「快速上手」无需改；「编写工作流」脚本契约段补一句
  consult 用法示例

## 关键现有代码锚点

- checkpoint journal 骨架：src/workflow.ts:1203-1251（callSeq/hash/firstMiss/resumeJournal）
- parallel/pipeline 对 **non-recoverable** rethrow、recoverable 吞 null：src/workflow.ts:
  926-930、962-966
- runFatalController.abort：src/workflow.ts:1312-1314
- 嵌套帧 runId：src/workflow.ts:1014-1018（`${runId}-nestedN`）、workflowFn
- executeRun catch 尾：src/workflow-manager.ts:840-905（usage-limit/abort 分支，usageLimitPaused
  以 !signal.aborted 为前提 847-853；状态链与事件链分离 845-884）
- resume 主体：src/workflow-manager.ts:1188-1310（租约 1195-1196；内存+磁盘状态检查 1189-1195；
  resumeJournal 组装 1239-1241）
- stop：src/workflow-manager.ts:1330/1363；pause：1162；recordTerminalRun：942-963；
  allowedActions：src/workflow-control-tool.ts:197-210；findRun 按 sessionId 过滤：
  workflow-manager.ts:1391-1392
- 投递：installResultDelivery（src/task-panel.ts:154-240，deliver 助手 213-217 用
  pi.sendMessage triggerTurn 默认 true；error 监听 222-226/236-240）
- 持久化：src/run-persistence.ts（runs/<runId>.json 内嵌 journal、租约锁、RunStatus 定义
  :9、PersistedRunState.autoResumeAttempts 模式）；web 镜像 web/lib/types.ts:11
- 子代理装配：src/agent.ts（WorkflowAgent.run 可独立于 VM，agent.ts:603 起；usage 上报）
- web-server resume：src/web-server.ts:304-308（live.script ?? persisted.script）
- parseWorkflowScript：src/workflow.ts:1360-1374（仅 meta/body，无调用序）
- 同步执行路径：src/workflow-tool.ts:256-258（headless 默认同步）、329-346（工具 catch
  对非 abort 错误原样抛出）
