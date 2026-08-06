# 工作流运行中干预（consult）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现脚本显式声明的运行中干预点 `consult()`：暂停运行 → 默认由审阅子代理（或主代理）修改脚本 → 重放式续跑（journal 重放已完成调用）。含 `workflow_control` 的 `reply`/`intervene` 动作、Web 控制台介入、阶段通知、完整状态机与持久化。

**架构：** `consult()` 在 VM 内抛专用 `WorkflowError`（`CONSULT_PENDING`，recoverable:false）中断脚本；`executeRun` catch 尾识别后置 `waiting_consult` + 持久化 pendingConsult（ManagedRun 字段）+ 释放租约；manager 层接管（自动审阅链派生审阅子代理写文件落盘修改后脚本，或投递主代理）；`resolveConsult`/`markConsultFailed` 单一收口写 journal（`{index, runId, hash, result}`）后带脚本 resume（journal 重放 firstMiss 之前）。settled:false 失败结果由 VM 重放分支兜底重抛。代际号（generation）防 intervene 与在飞审阅链竞态；`consultAutoApplied`（run 级持久化）限自动应用 ≤5 次后回落人工。

**技术栈：** bun、TypeScript、@oh-my-pi/pi-coding-agent（omp 17.2.9）、React（web 控制台）。

**规格：** `docs/superpowers/specs/2026-08-06-consult-intervention-design.md`（v5，五轮对抗审查后定稿）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/enums.ts` | 加 `WorkflowErrorCode.CONSULT_PENDING` |
| `src/workflow.ts` | `ConsultOptions`、`ConsultOutcome`、`hashConsult`、`consult()` 运行时全局（live 抛 / replay 返回 / settled:false 重抛） |
| `src/workflow-manager.ts` | catch 尾 CONSULT_PENDING 分支、stop/resume 双分支、`pendingConsult`/`consultAutoApplied` 字段、`resolveConsult`/`markConsultFailed`/`applyReviewChain`/`intervene` |
| `src/run-persistence.ts` | `RunStatus` 加 `"waiting_consult"`、PersistedRunState 加 `consultAutoApplied` |
| `src/workflow-control-tool.ts` | `normalizeInput`（白名单/script 键/文案）、`allowedActions`、`reply`/`intervene` 动作 |
| `src/task-panel.ts` | `deliverWorkflowMessage`（consult-pending/consult-review-ready/phaseNotify 监听，triggerTurn 语义） |
| `src/workflow-settings.ts` | `phaseNotify: "off" \| "phase"`（默认 "phase"） |
| `src/workflow-tool.ts` | 同步路径 consult 报错文案（按 to 分流） |
| `src/web-server.ts` | resume 带 script、GET /api/runs/:id 暴露 revisedScript、waiting_consult 路由 resolveConsult |
| `web/src/lib/types.ts`、`web/src/store.ts`、`web/src/components/RunList.tsx`、`web/src/components/Runtime.tsx`、`web/src/App.tsx` | 介入按钮、状态标签、编辑器初始值、按钮逻辑 |
| `web/dist/` | 重建产物 |
| `src/workflow-capability-contract.ts`、`src/workflow-authoring-reference.ts` | `consult` 能力 + `consult-options` OptionShape；生成器模板无需改（已中文化） |
| `tests/consult-*.test.ts`（新建若干）、`tests/web-server.test.ts`、`tests/workflow-control-tool`（若存在）、`tests/zh-copy.test.ts` 相关 | 契约测试 |
| `README.md`、`skills/workflow-authoring/references/runtime.md` | 文档联动 |

---

## 任务 1：错误码、状态类型与 VM 核心（consult/hashConsult）

**文件：**
- 修改：`src/enums.ts`（WorkflowErrorCode）
- 修改：`src/run-persistence.ts:9`（RunStatus）
- 修改：`web/lib/types.ts:11`（RunStatus 镜像）
- 修改：`src/workflow.ts`（ConsultOptions/hashConsult/consult，插入 checkpoint 附近 1203-1260 之后、runtimeImplementations 的 checkpoint 旁）
- 测试：`tests/consult-vm.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

```ts
// tests/consult-vm.test.ts
import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowErrorCode } from "../src/errors.js";

const consultScript = `
export const meta = { name: "c", description: "consult vm" };
phase("P1");
await agent("first", { label: "a1" });
consult("should we continue?", { to: "agent" });
return "after";
`;

describe("consult VM contract", () => {
  test("live execution throws CONSULT_PENDING and interrupts the script", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow({
      script: consultScript,
      agent: async (prompt) => {
        calls.push(prompt);
        return "done";
      },
    }).catch((e) => e);
    expect(calls).toEqual(["first"]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(outcome.payload).toMatchObject({ prompt: "should we continue?", callIndex: 1 });
  });

  test("replay returns the journaled outcome (live throws, replay returns)", async () => {
    const calls: string[] = [];
    const journal = new Map([["r1:1", { hash: "", result: { applied: true, summary: "ok" } }]]);
    // hash mismatch must NOT replay; a matching hash must. We build the hash by
    // capturing it from the first run's journal callback.
    let captured: { index: number; hash: string } | null = null;
    await runWorkflow({
      script: consultScript,
      agent: async (p) => "done",
      onAgentJournal: (e) => {
        if (e.index === 1) captured = { index: e.index, hash: e.hash };
      },
    }).catch(() => {});
    const replay = await runWorkflow({
      script: consultScript,
      resumeJournal: new Map([["r1:1", { hash: captured!.hash, result: { applied: true, summary: "ok" } }]]),
      agent: async (p) => "done",
    });
    expect(replay).toBe("after");
  });

  test("a settled:false entry is treated as a miss and rethrows CONSULT_PENDING", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow({
      script: consultScript,
      resumeJournal: new Map([["r1:1", { hash: "any", result: { applied: false, reason: "x", settled: false } }]]),
      agent: async (p) => { calls.push(p); return "done"; },
    }).catch((e) => e);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/consult-vm.test.ts`
预期：FAIL（`WorkflowErrorCode.CONSULT_PENDING` 未定义 / consult is not a function / runWorkflow 签名不符——按实际 runWorkflow 签名调整测试的调用形态）

- [ ] **步骤 3：实现错误码与状态类型**

```ts
// src/enums.ts —— WorkflowErrorCode 枚举内追加（先 grep 现有值避免冲突）
CONSULT_PENDING = "CONSULT_PENDING",
```

```ts
// src/run-persistence.ts:9
export type RunStatus = "pending" | "running" | "paused" | "waiting_consult" | "completed" | "failed" | "aborted";
```

```ts
// web/lib/types.ts:11 镜像同步同一联合类型
```

- [ ] **步骤 4：实现 ConsultOptions/hashConsult/consult**

```ts
// src/workflow.ts —— 在 CheckpointOptions（约 339 行）之后追加
export interface ConsultOptions {
  to?: "agent" | "main";
  agent?: string;
  apply?: "auto" | "confirm";
  timeoutMs?: number;
}
export interface ConsultOutcome {
  applied: boolean;
  revisedScript?: string;
  summary: string;
}
// 与 hashCheckpoint 同构：固定字段序 + ?? null 归一（原始 opts，不做默认解析）
function hashConsult(promptText: string, options: ConsultOptions): string {
  const identity = JSON.stringify({
    promptText,
    to: options.to ?? "agent",
    agent: options.agent ?? null,
    apply: options.apply ?? "auto",
    timeoutMs: options.timeoutMs ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}
```

```ts
// src/workflow.ts —— checkpoint 定义（1208 行）之后追加 consult 定义
const consult = async (promptText: string, consultOptions: ConsultOptions = {}) => {
  throwIfAborted();
  if (typeof promptText !== "string") throw new TypeError("consult(promptText, options?) needs a prompt string");
  if (shared.agentCount >= maxAgents) throw agentLimitError();
  const callIndex = state.callSeq++;
  const callHash = hashConsult(promptText, consultOptions);
  const journalKey = `${runId}:${callIndex}`;
  const cached = options.resumeJournal?.get(journalKey);
  if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
    shared.agentCount++;
    // settled:false（审阅失败且未答复）视为 miss：重抛挂起，防静默越过咨询点
    if ((cached.result as ConsultOutcome | undefined)?.settled === false) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    } else {
      return cached.result;
    }
  }
  if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
  shared.agentCount++;
  const payload = { journalPrefix: `${runId}:`, callIndex, prompt: promptText, opts: consultOptions };
  throw new WorkflowError("consult pending: script paused for review", WorkflowErrorCode.CONSULT_PENDING, {
    recoverable: false,
    payload,
  });
};
```

```ts
// runtimeImplementations（约 1244 行）中 checkpoint 旁边注册：
    checkpoint,
    consult,
```

注意：`ConsultOutcome` 需要 `settled?: boolean` 字段（markConsultFailed 写入）；在接口里加 `settled?: boolean`。`WorkflowError` 的 payload 支持情况先核对 `src/errors.ts` 构造签名，若无 payload 字段则扩展（见步骤 5）。

- [ ] **步骤 5：核对 WorkflowError payload 并适配**

运行：`grep -n "class WorkflowError\|constructor" src/errors.ts`
预期：若构造签名无 `payload`，扩展 `WorkflowError` 增加 `readonly payload?: unknown` 字段（构造器透传），保持现有调用不变。

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/consult-vm.test.ts`
预期：PASS（3 条）；若 runWorkflow 的 onAgentJournal 回调签名与测试不符，按实际签名修正测试。

- [ ] **步骤 7：Commit**

```bash
git add src/enums.ts src/run-persistence.ts web/lib/types.ts src/workflow.ts src/errors.ts tests/consult-vm.test.ts
git commit -m "feat: consult VM 核心——CONSULT_PENDING 错误、hashConsult、live 抛/replay 返回/settled:false 重抛"
```

---

## 任务 2：manager 状态机（catch 尾分支 + stop/resume 触点 + 字段）

**文件：**
- 修改：`src/workflow-manager.ts`（executeRun catch 尾 845-905 区域；stop 1330/1363；resume 1189-1195；ManagedRun 接口与序列化）
- 修改：`src/run-persistence.ts`（PersistedRunState 加 `consultAutoApplied?: number`）
- 测试：`tests/consult-manager-state.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

```ts
// tests/consult-manager-state.test.ts（用现有测试基座 tests/stop-semantics.test.ts 的 manager 构造模式）
import { describe, expect, test } from "bun:test";
import { createManager } from "./helpers.js"; // 若无，照抄 stop-semantics.test.ts 的构造

describe("waiting_consult state machine", () => {
  test("stop() accepts waiting_consult (memory + disk branches)", async () => { /* 构造 waiting_consult 运行 → stop → status aborted */ });
  test("resume() rejects waiting_consult in both memory and disk branches", async () => { /* resume → false */ });
  test("pause() rejects waiting_consult", async () => { /* pause → false */ });
  test("allowedActions(waiting_consult) returns [status, stop, reply, intervene]", async () => { /* 直接调工具层或暴露函数 */ });
  test("executeRun catch tail maps CONSULT_PENDING to waiting_consult (not error, not failed)", async () => {
    // mock agent 抛 WorkflowError(CONSULT_PENDING)，断言运行快照 status === "waiting_consult"、pendingConsult 已持久化
  });
  test("stop in the catch-tail window wins: status already aborted is not overwritten", async () => { /* stop 先落 → 保持 aborted */ });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/consult-manager-state.test.ts`
预期：FAIL

- [ ] **步骤 3：ManagedRun 字段与持久化**

```ts
// workflow-manager.ts ManagedRun 接口追加（连同序列化字段）
pendingConsult?: {
  journalPrefix: string; callIndex: number; prompt: string;
  opts: ConsultOptions; revisedScript?: string; summary?: string;
  generation: number;
};
// PersistedRunState（run-persistence.ts）加：
consultAutoApplied?: number;
// 序列化往返：load 时读回 pendingConsult 与 consultAutoApplied（写进 persistRun 的 save 对象）
```

- [ ] **步骤 4：catch 尾 CONSULT_PENDING 分支**

```ts
// executeRun catch 尾，usageLimitPaused 计算之后、abort 分支之前插入：
const consultPending = !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.CONSULT_PENDING;
// 状态链：abort 分支不变；usageLimitPaused 不变；新增：
if (managed.controller.signal.aborted) {
  if (managed.status === "running") managed.status = "aborted";
} else if (consultPending) {
  if (managed.status === "running") {
    managed.status = "waiting_consult";
    managed.pendingConsult = {
      journalPrefix: workflowError.payload.journalPrefix,
      callIndex: workflowError.payload.callIndex,
      prompt: workflowError.payload.prompt,
      opts: workflowError.payload.opts,
      generation: 0,
    };
  }
} else if (usageLimitPaused) { … } else { managed.status = "failed"; }
// 事件链：abort 之前插入 consultPending 分支 —— 仅发 consult-pending，绝不发 error：
} else if (consultPending) {
  if (managed.status === "waiting_consult") {
    this.emitLive(managed, "consult-pending", { runId: managed.runId, prompt: managed.pendingConsult?.prompt });
  }
} else if (this.listenerCount("error") > 0) { … }
```

- [ ] **步骤 5：stop/resume/pause 触点**

```ts
// stop() 内存分支（约 1330）与磁盘分支（约 1363）：条件从 running/paused 扩展为 running/paused/waiting_consult
// resume()（约 1189-1195）：内存与磁盘分支的拒绝条件加 waiting_consult：
//   if (active.status === "waiting_consult" || persisted.status === "waiting_consult") return false;
//   （普通 resume 拒绝；resolveConsult 内部置 paused 放行，任务 3）
// pause() 保持只接受 running（不变）
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/consult-manager-state.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/workflow-manager.ts src/run-persistence.ts tests/consult-manager-state.test.ts
git commit -m "feat: waiting_consult 状态机——catch 尾分支、stop/resume 双分支触点、pendingConsult 持久化"
```

---

## 任务 3：manager 收口（resolveConsult / markConsultFailed / settled:false 前置检查）

**文件：**
- 修改：`src/workflow-manager.ts`
- 测试：`tests/consult-resolve.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

```ts
// tests/consult-resolve.test.ts
describe("resolveConsult", () => {
  test("reply with script: writes journal entry {index, runId, hash, result}, persists BEFORE resume, clears pending, resumes", async () => {
    // 构造 waiting_consult 运行 → resolveConsult(runId, { script }) → 断言：
    // 1) 磁盘 journal 含该 entry（resume 从磁盘重建，不落盘必丢）
    // 2) 运行恢复执行（快照 running）
    // 3) pendingConsult 已清
  });
  test("reply without script (to:main): journals { applied:false, summary:'维持原脚本' } and resumes", async () => { … });
  test("reply on a completed run is rejected", async () => { … });
  test("double reply: second one loses (status check fails)", async () => { … });
  test("disk-only waiting_consult: resolveConsult works after cold start (recoverStaleRuns leaves it)", async () => { … });
  test("markConsultFailed: journals settled:false, sets failed, persists, recordTerminalRun, emits error", async () => { … });
  test("plain resume with settled:false entry is rejected by the manager pre-check", async () => { … });
  test("intervene on running: sets waiting_consult + persists, THEN aborts; abort catch tail does not overwrite", async () => { … });
  test("generation: review chain captured gen 0, intervene bumps to 1, chain apply is discarded", async () => { … });
  test("user reply is NOT generation-gated (intervene -> reply works)", async () => { … });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/consult-resolve.test.ts`
预期：FAIL

- [ ] **步骤 3：resolveConsult 实现**

```ts
// workflow-manager.ts 新增（复用 resume 主体 1188-1310 的日志/租约流程）
async resolveConsult(runId: string, script?: string): Promise<boolean> {
  const managed = this.runs.get(runId);
  const persisted = this.persistence.load(runId);
  const pending = managed?.pendingConsult ?? persisted?.pendingConsult;
  if (managed && managed.status !== "waiting_consult") return false;
  if (!managed && persisted?.status !== "waiting_consult") return false;
  if (!pending) return false;
  if (script !== undefined) {
    parseWorkflowScript(script); // 校验失败 throw（调用方转工具错误）
  }
  // 1) journal entry（consult 场景；intervene 场景 pending 无 callIndex 锚 → 跳过）
  if (pending.callIndex !== undefined && pending.journalPrefix) {
    const hash = hashConsult(pending.prompt, pending.opts);
    (managed ?? persisted).journal = [
      ...(managed?.journal ?? persisted?.journal ?? []),
      { index: pending.callIndex, runId: pending.journalPrefix.replace(/:$/, ""), hash, result: buildOutcome() },
    ];
  }
  // 2) 清 pending
  if (managed) delete managed.pendingConsult;
  // 3) persistRun 先于 resume（resume 从磁盘重建 journal）
  this.persistRun(managed ?? this.materialize(persisted));
  // 4) 内部放行：置 paused 再 resume（绕过 waiting_consult 拒绝守卫）
  const target = managed ?? (await this.recoverForResume(runId));
  target.status = "paused";
  return this.resume(runId, script); // resume 需支持可选 script 参数（照 resumeFromRunId 的换脚本语义）
}
```

`buildOutcome` 按 pending.opts.apply 分流：confirm → 采纳审阅产物（`{applied:true, revisedScript}`）；其余 → `{applied:false, summary:"维持原脚本"}`。

- [ ] **步骤 4：markConsultFailed 与前置检查**

```ts
async markConsultFailed(runId: string, reason: string): Promise<void> {
  // 状态校验（仅 waiting_consult）→ 写 journal entry { applied:false, reason, settled:false }
  // → 清 pendingConsult → status = "failed" → persistRun() → recordTerminalRun(runId)
  // → emitLive(managed, "error", { runId, error: new WorkflowError(reason, WORKFLOW_ABORTED, {recoverable:true}) })
}
// resume() 前置 UX 检查（磁盘 journal 扫描）：journal 含 settled:false 且脚本省略/逐字节相同 → return false
// （VM 重放分支兜底已在任务 1 实现）
```

- [ ] **步骤 5：intervene 与 generation**

```ts
async intervene(runId: string): Promise<boolean> {
  // running/paused：置 waiting_consult + pendingConsult({to:"main", generation: 当前+1}) + persistRun
  //   + 再 abort controller（catch 尾 abort 分支只覆盖 status==="running"，已置状态被保留）
  // waiting_consult：仅改投 to:"main"（pending.opts.to = "main"，generation+1）并投递
  // 返回是否成功
}
// applyReviewChain(runId, { generation, revisedPath, summary })：校验 pendingConsult.generation === generation，
//   失配 → 丢弃（清理 tmp、不写 journal）；匹配 → resolveConsult(runId, { script: 读文件内容 })
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/consult-resolve.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/workflow-manager.ts tests/consult-resolve.test.ts
git commit -m "feat: resolveConsult/markConsultFailed/intervene——单一收口、persistRun 先于 resume、代际校验、settled:false 前置检查"
```

---

## 任务 4：自动审阅链（审阅子代理派生 + 文件落盘 + 预算 + 上限）

**文件：**
- 修改：`src/workflow-manager.ts`（consult-pending 事件处理 / 审阅链触发）
- 修改：`src/agent.ts`（如需要：审阅子代理的 usage 上报通道——先核对 WorkflowAgent.run 是否有 usage 回调）
- 测试：`tests/consult-review-chain.test.ts`（新建）

- [ ] **步骤 1：核对 usage 上报通道**

运行：`grep -n "usage\|tokenUsage\|onUsage" src/agent.ts | head -20`
预期：确认 WorkflowAgent.run 是否回调 token 用量；有 → 审阅链计入运行 tokenBudget；无 → 实现 `consultReviewBudget`（默认等于 tokenBudget，读 settings）并在 manager 记账（任务 4 步骤 3 的决策点写实）。

- [ ] **步骤 2：写失败测试**

```ts
// tests/consult-review-chain.test.ts
describe("auto review chain (to:agent apply:auto)", () => {
  test("derives reviewer, reads revised file, validates, applies, resumes from firstMiss", async () => {
    // manager 注入 mock 审阅执行器：写一个合法新脚本到给定路径 → 断言：
    // 1) 运行恢复执行且 consult 前调用不重跑（journal 重放）
    // 2) consultAutoApplied === 1
  });
  test("invalid revised script: retries once with parse feedback, then markConsultFailed", async () => { … });
  test("prefix change causes re-pend; consultAutoApplied increments on failure too", async () => { … });
  test("autoApplied > 5: falls back to waiting_consult + delivers '自动审阅超限' message", async () => { … });
  test("generation mismatch: in-flight chain result is discarded (no journal write, tmp cleaned)", async () => { … });
  test("review chain token spend counts into the run budget", async () => { … });
});
```

- [ ] **步骤 3：实现审阅链**

```ts
// workflow-manager.ts
private async runAutoReviewChain(runId: string): Promise<void> {
  const managed = this.runs.get(runId);
  if (!managed?.pendingConsult || managed.pendingConsult.opts.to !== "agent") return;
  const generation = managed.pendingConsult.generation;
  const n = (persisted.consultAutoApplied ?? 0) + 1;
  const tmpPath = join(tmpdir(), `consult-${runId}-${generation}-${n}.js`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? reviewPrompt(managed)   // 快照摘要 + 脚本全文 + pendingConsult.prompt
      : `${reviewPrompt(managed)}\n\n上一次审阅产出的脚本未通过解析：\n${lastParseError}`;
    const result = await this.runReviewAgent(prompt, tmpPath, managed.pendingConsult.opts); // WorkflowAgent.run
    if (!result.ok) { lastParseError = result.error; continue; }
    const revised = readFileSync(tmpPath, "utf8");
    try { parseWorkflowScript(revised); } catch (e) { lastParseError = String(e); continue; }
    await this.applyReviewChain(runId, { generation, script: revised, summary: result.summary });
    rmSync(tmpPath, { force: true });
    return;
  }
  rmSync(tmpPath, { force: true });
  await this.markConsultFailed(runId, "审阅子代理未能产出可解析的修改后脚本");
}
// consultAutoApplied 递增：applyReviewChain 成功与 markConsultFailed 两处都 +1 并 persist
// 上限：consultAutoApplied > 5 → 不触发 runAutoReviewChain，回落 + deliverWorkflowMessage(triggerTurn: wakesTurn(runId))
// 预算：审阅 agent token 累加进 managed 的 tokenUsage（有 usage 回调则直接累加；否则 consultReviewBudget 计数）
```

- [ ] **步骤 4：挂接 consult-pending 事件分流**

```ts
// extensions/workflow.ts 或 index.ts：manager.on("consult-pending", …) →
//   opts.to === "agent" && opts.apply === "auto" → runAutoReviewChain
//   opts.to === "main" → deliverWorkflowMessage(consult 消息, triggerTurn: wakesTurn(runId))
//   opts.apply === "confirm" → runAutoReviewChain（不应用）+ 完成后 consult-review-ready 投递
```

- [ ] **步骤 5：运行测试确认通过**

运行：`bun test tests/consult-review-chain.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/workflow-manager.ts src/agent.ts src/index.ts tests/consult-review-chain.test.ts
git commit -m "feat: 自动审阅链——审阅子代理文件落盘、带反馈重试、预算计入、autoApplied 上限回落"
```

---

## 任务 5：workflow_control 工具（reply/intervene + normalizeInput + allowedActions）

**文件：**
- 修改：`src/workflow-control-tool.ts`（normalizeInput 159-175、allowedActions 197-210、动作分发）
- 修改：`src/workflow-commands.ts:46`（STATUS_ICON 加 waiting_consult）
- 修改：`src/task-panel.ts`（active 过滤——waiting_consult 计入 active）
- 测试：`tests/consult-control-tool.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

```ts
// tests/consult-control-tool.test.ts
describe("workflow_control reply/intervene", () => {
  test("reply accepts script key; normalizeInput passes reply {runId, script}", async () => { … });
  test("reply without script on to:main journals 维持原脚本", async () => { … });
  test("reply on completed run returns error with allowedActions", async () => { … });
  test("reply with invalid script keeps waiting_consult and returns parse error", async () => { … });
  test("intervene on running sets waiting_consult and delivers", async () => { … });
  test("cross-session: reply resolves run via listAllRuns (run owned by another session)", async () => { … });
  test("allowedActions(waiting_consult) = [status, stop, reply, intervene]", async () => { … });
  test("normalizeInput rejects unknown action with updated message", async () => { … });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/consult-control-tool.test.ts`
预期：FAIL

- [ ] **步骤 3：normalizeInput 与 allowedActions**

```ts
// normalizeInput（159-175）：
const actions = new Set(["list", "status", "pause", "resume", "stop", "reply", "intervene"]);
// 错误文案同步：`workflow_control requires action: list|status|pause|resume|stop|reply|intervene`
// allowedKeys：reply 允许 ["action", "runId", "script"]；其余非 list 保持 ["action", "runId"]
// allowedActions（197-210）加分支：
case "waiting_consult":
  return ["status", "stop", "reply", "intervene"];
```

- [ ] **步骤 4：动作分发（findRun 改用 listAllRuns）**

```ts
// findRun（约 181 行）：manager.listRuns() → manager.listAllRuns()（跨会话寻址）
// 动作分发（约 220+ 的 switch）：reply → manager.resolveConsult(runId, script)
//   → 返回 actionSuccess("reply", "applied"|"resumed", …)；失败 → invalidTransition
//   intervene → manager.intervene(runId) → 同上
// reply 的 script 校验失败：返回控制错误（保持 waiting_consult，allowedActions 不变）
```

- [ ] **步骤 5：展示层触点**

```ts
// workflow-commands.ts:46 STATUS_ICON：加 waiting_consult → "⏸"（或既有暂停图标）
// task-panel.ts active 过滤（约 406）：waiting_consult 计入 active（不落入 finished）
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/consult-control-tool.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/workflow-control-tool.ts src/workflow-commands.ts src/task-panel.ts tests/consult-control-tool.test.ts
git commit -m "feat: workflow_control reply/intervene——normalizeInput 白名单、allowedActions、跨会话寻址"
```

---

## 任务 6：投递出口与同步路径（deliverWorkflowMessage + phaseNotify + 报错文案）

**文件：**
- 修改：`src/task-panel.ts`（installResultDelivery 增挂 consult-pending/consult-review-ready/phaseNotify 监听；新增 `deliverWorkflowMessage` 导出）
- 修改：`src/workflow-settings.ts`（phaseNotify）
- 修改：`src/workflow-tool.ts:256-258/329-346`（同步路径 consult 报错文案按 to 分流）
- 测试：`tests/consult-delivery.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

```ts
// tests/consult-delivery.test.ts（用 web-server 测试的 withServer/manager 模式 + mock pi）
describe("consult delivery", () => {
  test("consult-pending (to:main) delivers customType=workflow.consult with runId + prompt + reply guidance", async () => { … });
  test("phaseNotify delivers with triggerTurn:false and does not wake", async () => { … });
  test("consult-pending on a web-started run does not triggerTurn (isSilentOrigin)", async () => { … });
  test("confirm mode: consult-review-ready delivers suggestion summary + path after chain", async () => { … });
  test("sync path: consult error message splits by to (agent mentions auto chain, main mentions reply)", async () => { … });
  test("settings: phaseNotify off suppresses phase rows", async () => { … });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/consult-delivery.test.ts`
预期：FAIL

- [ ] **步骤 3：deliverWorkflowMessage 与监听**

```ts
// task-panel.ts 导出：
export function deliverWorkflowMessage(
  pi: ExtensionAPI, runId: string, text: string,
  opts: { triggerTurn: boolean; customType?: string },
): void { /* 复用 installResultDelivery 内部 deliver 的同款 sendMessage 调用，customType 参数化 */ }
// installResultDelivery 增挂（register once 处）：
manager.on("consult-pending", ({ runId, prompt }) => {
  if (!manager.getRun(runId)?.background) return;
  deliverWorkflowMessage(pi, runId,
    `工作流 ${runId} 在等待咨询答复：${String(prompt).slice(0, 200)}\n` +
    `请用 workflow_control 的 reply 动作回复（runId=${runId}），或经 Web 控制台介入。`,
    { triggerTurn: wakesTurn(runId), customType: "workflow.consult" });
});
manager.on("consult-review-ready", ({ runId, summary, revisedPath }) => {
  … // 第二条消息：建议摘要 + 落盘路径 + 「reply 无 script 即采纳」
});
manager.on("phase", ({ runId, title }) => { … }); // phaseNotify 逻辑在 manager 侧触发上一 phase 行投递
```

- [ ] **步骤 4：phaseNotify 设置与投递时机**

```ts
// workflow-settings.ts：interface 与 normalize 加 phaseNotify（"off"|"phase"，默认 "phase"，
//   遵循缺省即省略：仅显式合法值输出键）
// manager 侧：onPhase 时记 lastPhase；投递上一 phase 行（阶段名、done/total、tokenTotal 从快照取）；
//   CONSULT_PENDING 分支先补投当前 phase 行再发 consult-pending
```

- [ ] **步骤 5：同步路径报错文案**

```ts
// workflow-tool.ts（329-346 工具 catch 或 256-258 同步路径）：
// 识别 WorkflowErrorCode.CONSULT_PENDING：
//   to === "agent" → `运行 ${runId} 已暂停等待咨询答复，自动审阅链已在后台执行，结果将以 follow-up 投递；也可用 /workflows status ${runId} 查看或经 Web 控制台介入`
//   to === "main" → `运行 ${runId} 已暂停等待主代理答复，请用 workflow_control 的 reply 动作回复（runId=${runId}），或用 /workflows status ${runId} 查看`
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/consult-delivery.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/task-panel.ts src/workflow-settings.ts src/workflow-tool.ts tests/consult-delivery.test.ts
git commit -m "feat: consult 投递与同步路径——deliverWorkflowMessage、phaseNotify、报错文案按 to 分流"
```

---

## 任务 7：Web 控制台

**文件：**
- 修改：`src/web-server.ts`（resume 带 script 304-308、GET /api/runs/:id 暴露 revisedScript、waiting_consult 路由 resolveConsult、/api/state 含 waiting_consult 状态标签）
- 修改：`web/src/lib/types.ts`、`web/src/store.ts`、`web/src/components/RunList.tsx`、`web/src/components/Runtime.tsx`、`web/src/App.tsx`
- 重建：`web/dist/`
- 测试：`tests/web-server.test.ts` 增补

- [ ] **步骤 1：写失败测试（web-server.test.ts 增补）**

```ts
test("resume accepts optional script body and routes waiting_consult to resolveConsult", async () => { … });
test("GET /api/runs/:id exposes pendingConsult.revisedScript ?? script for waiting_consult runs", async () => { … });
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/web-server.test.ts`
预期：FAIL（新增两条）

- [ ] **步骤 3：server 实现**

```ts
// web-server.ts:304-308：
if (action === "resume") {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const script = typeof body.script === "string" ? body.script : undefined;
  if (script !== undefined) parseWorkflowScript(script); // 校验失败 → 400
  const run = manager.getRun(runId);
  const ok = run?.status === "waiting_consult"
    ? await manager.resolveConsult(runId, script)
    : await manager.resume(runId, script); // resume 增加可选 script 参数
  return json({ ok });
}
// GET /api/runs/:id（约 283-305）：waiting_consult 时 script 字段返回 pendingConsult.revisedScript ?? script
```

- [ ] **步骤 4：前端实现**

```tsx
// store.ts：builtins/run 类型加 status "waiting_consult"；control 动作加 "reply"（带 script）与 "intervene"
// RunList.tsx / Runtime.tsx：状态标签「待咨询」；运行卡片「介入」按钮（intervene → 编辑器加载
//   GET /api/runs/:id 的 script（revisedScript ?? script）→ 改脚本 → resume 带 script）
// Runtime.tsx（38-53）按钮逻辑：waiting_consult → 暂停禁用、恢复显示「回复并继续」（走 resolveConsult）
// App.tsx：等待咨询的提示行（pendingConsult 摘要前 80 字）
```

- [ ] **步骤 5：重建 web/dist**

运行：`cd web && bun run build`
预期：产物更新（新 index-*.js）

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test tests/web-server.test.ts`
预期：PASS（含新增两条）

- [ ] **步骤 7：Commit**

```bash
git add src/web-server.ts web/src web/dist
git commit -m "feat(web): 控制台介入——resume 带脚本、待咨询标签、介入按钮、revisedScript 暴露"
```

---

## 任务 8：能力契约与文档联动

**文件：**
- 修改：`src/workflow-capability-contract.ts`（consult 能力 + consult-options OptionShape）
- 修改：`src/workflow-authoring-reference.ts`（如需要）
- 重新生成：`skills/workflow-authoring/references/capabilities.md`、`capability-details.md`
- 修改：`README.md`、`skills/workflow-authoring/references/runtime.md`
- 验证：`tests/zh-copy.test.ts`

- [ ] **步骤 1：contract 加 consult 能力**

```ts
// workflow-capability-contract.ts：
const CONSULT_OPTIONS: OptionShape = {
  id: "consult-options",
  options: [
    option("to", '"agent" | "main"', true, '"agent"'),
    option("agent", "string", true),
    option("apply", '"auto" | "confirm"', true, '"auto"'),
    option("timeoutMs", "number", true),
  ],
};
// optionShapes 数组加 CONSULT_OPTIONS；capabilities 数组加：
runtimeGlobal("consult", {
  signature: "consult(prompt, options?) => Promise<ConsultOutcome>",
  discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
  optionShape: "consult-options",
  constraints: [
    "live 执行抛 CONSULT_PENDING 中断脚本；重放命中返回 journaled 结果",
    "settled:false 结果重放视为 miss，重新挂起",
    "消耗 1 个 agent 槽位且不消耗 token（同 checkpoint）",
    "to: agent 默认 apply: auto（审阅链直接应用）；to: main 或 apply: confirm 走主代理",
  ],
  evidence: ["tests/consult-vm.test.ts", "tests/consult-review-chain.test.ts"],
});
```

- [ ] **步骤 2：重新生成并验证漂移**

运行：
```bash
# 写临时脚本调 writeWorkflowCapabilityPublications 后：
bun -e 'import { writeWorkflowCapabilityPublications } from "./src/workflow-authoring-reference.ts"; writeWorkflowCapabilityPublications(process.cwd())'
# 再用 checkWorkflowCapabilityPublications 断言 stale === []
```
预期：生成文件含中文 consult 节；`stale: []`

- [ ] **步骤 3：README 与 skill 文档**

`README.md`：运行时全局表加 `consult` 行（签名 + live/replay 行为一句话）；workflow_control 表加 `reply`/`intervene` 行；配置项表加 `phaseNotify`；状态说明加 waiting_consult。
`skills/workflow-authoring/references/runtime.md`：加 consult 契约（含 confirm 模式、同步路径报错语义）。

- [ ] **步骤 4：验证 zh-copy 与全量类型**

运行：`bunx tsc --noEmit && bun test tests/zh-copy.test.ts`
预期：干净

- [ ] **步骤 5：Commit**

```bash
git add src/workflow-capability-contract.ts skills/workflow-authoring/references README.md
git commit -m "docs: consult 能力契约、生成文档与 README 联动"
```

---

## 任务 9：全量回归与真实宿主冒烟

**文件：** 无（验证）

- [ ] **步骤 1：全量门禁**

运行：`bunx tsc --noEmit && bun test`
预期：全部 PASS（原 98 + 新增 consult 测试）

- [ ] **步骤 2：真实宿主冒烟**

运行：
```bash
cd /tmp && omp plugin uninstall omp-dynamic-workflows
omp plugin install github:ExLei/omp-dynamic-workflows
omp -p "只回复 ok"   # 加载无错误
```
预期：无 `Failed to load extension`；`consult` 出现在能力文档（读 skill://workflow-authoring 的 capability 索引可查）。

- [ ] **步骤 3：提交收尾**

```bash
git add -A && git commit -m "test: consult 全量回归"
```

---

## 自检（writing-plans 要求）

**规格覆盖度**：v5 全部章节映射——§1 API（任务 1）、§2 执行机制/事件映射（任务 2）、§3 审阅链（任务 4）、§4 收口/代际/跨会话/投递契约（任务 3/5/6）、§5 失败语义（任务 1 settled:false 重抛 + 任务 3 markConsultFailed/前置检查 + 任务 6 文案）、§6 触点（任务 2/5）、§7 phaseNotify（任务 6）、§8 控制台（任务 7）、§9 测试（各任务）、§10 文档（任务 8）。无遗漏。

**占位符扫描**：无 TODO/「适当处理」；每个步骤含代码或命令。任务 3 的 `buildOutcome`/`recoverForResume` 为计划内定义的新方法名（任务 3 步骤 3 内给出语义）。

**类型一致性**：`ConsultOptions`/`ConsultOutcome`（含 `settled?`）/`hashConsult`/`resolveConsult(runId, script?)`/`markConsultFailed(runId, reason)`/`intervene(runId)`/`applyReviewChain(runId, {generation, script, summary})` 在任务 1/3/4 间一致；`deliverWorkflowMessage(pi, runId, text, {triggerTurn, customType})` 任务 6 定义后任务 4 使用；`resume(runId, script?)` 任务 3 扩展后任务 7 使用。
