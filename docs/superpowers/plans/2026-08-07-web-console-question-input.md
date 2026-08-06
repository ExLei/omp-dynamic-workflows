# Web 控制台问题输入框 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 web 控制台「编排 · 脚本」面板底部的「参数 (JSON)」输入框改造成「问题」输入框，问题按当前激活工作流自动映射为参数并直接发送；JSON 输入保留为可展开的「高级参数」。

**架构：** 纯前端改动。`web/src/store.ts` 的 `start()` 重写发送决策（按名 vs 按脚本、问题→参数键映射、JSON 优先补齐），`web/src/components/Authoring.tsx` 底部参数区替换为问题框 + 折叠高级 JSON。后端 `/api/runs` 已支持 `{name, args}` 与 `{script, args}`，零改动。

**技术栈：** React 19 + zustand + TypeScript + Vite（`web/`）；构建 `bun run build`（`tsc -b && vite build`）；运行中的服务器每请求从 `web/dist` 读盘，重建即生效。

**规格：** `docs/superpowers/specs/2026-08-07-web-console-question-input-design.md`

**前置事实（已核实）：**
- `store.start()`（`web/src/store.ts:284-299`）：解析 `argsText` JSON → `script.trim() ? {script,args} : {name:runName.trim(),args}`。
- `Authoring.tsx:77-89`：`参数 (JSON)` 标签 + textarea（`argsText`/`setArgsText`）。
- 内置模式参数键：`deep-research→question`、`adversarial-review→task`、`multi-perspective→topic`、`codebase-audit→scope`；`code-review→diff`（不适用提问）。
- `web/` 无前端测试基建（package.json 无 test script）——验证方式为构建 + 浏览器驱动。

---

### 任务 1：store.ts 状态改名与发送逻辑重写

**文件：** 修改 `web/src/store.ts`（接口 ~64-100 行、初始值 ~148-152 行、action 定义 ~261-263 行、`start()` ~284-299 行）

- [ ] **步骤 1：接口与初始值改名**

`WorkflowStore` 接口中 `argsText: string;` 替换为：

```ts
  question: string;
  advancedArgsText: string;
```

action 签名 `setArgsText: (argsText: string) => void;` 替换为：

```ts
  setQuestion: (question: string) => void;
  setAdvancedArgsText: (advancedArgsText: string) => void;
```

初始值 `argsText: "{}",` 替换为：

```ts
  question: "",
  advancedArgsText: "",
```

- [ ] **步骤 2：添加内置模式问题键映射常量**

在 `useStore` 创建语句之前（`function pushFeed` 附近）添加：

```ts
/** 可用问题框驱动的内置模式 → 其必填 args 键；code-review 需要 diff，不在此列。 */
const BUILTIN_QUESTION_KEY: Record<string, string> = {
  "deep-research": "question",
  "adversarial-review": "task",
  "multi-perspective": "topic",
  "codebase-audit": "scope",
};
```

- [ ] **步骤 3：action 改名**

`setArgsText(argsText) { set({ argsText }); },` 替换为：

```ts
  setQuestion(question) {
    set({ question });
  },
  setAdvancedArgsText(advancedArgsText) {
    set({ advancedArgsText });
  },
```

- [ ] **步骤 4：重写 `start()`**

`async start() { … }` 整体替换为：

```ts
  async start() {
    const { script, question, advancedArgsText, runName, builtins, saved } = get();
    const targetName = runName.trim();
    const trimmedQuestion = question.trim();
    const builtin = builtins.find((b) => b.name === targetName);
    const savedWorkflow = saved.find((w) => w.name === targetName);
    // 按名运行意图：空编辑器 + 已知名称，或脚本未被改动（等于预览/保存脚本）。
    // 被用户改过的脚本按脚本发送；未改动的内置预览走按名（生成脚本 + tools/toolset 绑定，
    // 并规避 multi-perspective/codebase-audit 预览里的 <topic>/<scope> 字面量）。
    const byName =
      targetName !== "" &&
      (!script.trim() ||
        (builtin !== undefined && script === builtin.script) ||
        (savedWorkflow !== undefined && script === savedWorkflow.script));

    if (!targetName && !script.trim()) {
      set({ notice: { kind: "error", text: "没有可运行的工作流：请选择内置/已保存工作流或在编辑器中编写脚本" } });
      return;
    }

    let args: unknown;
    const json = advancedArgsText.trim();
    if (json) {
      try {
        args = JSON.parse(json);
      } catch {
        set({ notice: { kind: "error", text: "参数不是合法 JSON" } });
        return;
      }
      // JSON 里缺必填键时用问题框补齐（如 {"angles":3} + 问题 → {angles, question}）。
      if (builtin && trimmedQuestion) {
        const key = BUILTIN_QUESTION_KEY[builtin.name];
        if (key && !(args as Record<string, unknown>)[key]) {
          args = { ...(args as Record<string, unknown>), [key]: trimmedQuestion };
        }
      }
    } else {
      if (!trimmedQuestion) {
        set({ notice: { kind: "error", text: "请输入问题" } });
        return;
      }
      if (builtin) {
        const key = BUILTIN_QUESTION_KEY[builtin.name];
        if (!key) {
          set({
            notice: {
              kind: "error",
              text: `${builtin.name} 需要 diff 参数，不适合提问：请展开「高级参数 (JSON)」输入 { "diff": "…" }`,
            },
          });
          return;
        }
        args = { [key]: trimmedQuestion };
      } else {
        args = { question: trimmedQuestion };
      }
    }

    try {
      const body = byName ? { name: targetName, args } : { script, args };
      const { runId } = await api.start(body);
      set({ notice: { kind: "info", text: `已启动 ${runId}` } });
      await get().selectRun(runId);
    } catch (error) {
      set({ notice: { kind: "error", text: String(error) } });
    }
  },
```

- [ ] **步骤 5：Commit**

```bash
git add web/src/store.ts && git commit -m "feat(web): 问题输入发送逻辑——按名映射与 JSON 补齐"
```

### 任务 2：Authoring.tsx 参数区改为问题框

**文件：** 修改 `web/src/components/Authoring.tsx`（imports 第 1-16 行、组件顶部 state 读取第 11-24 行、底部参数区第 77-89 行）

- [ ] **步骤 1：imports 与 state 读取**

`react` 导入行 `import { useEffect, useRef } from "react";` 增加 `useState`（当前未导入）：

```ts
import { useEffect, useRef, useState } from "react";
```

顶部读取处 `const argsText = useStore((s) => s.argsText);` 与 `const setArgsText = useStore((s) => s.setArgsText);` 替换为：

```ts
  const question = useStore((s) => s.question);
  const advancedArgsText = useStore((s) => s.advancedArgsText);
  const setQuestion = useStore((s) => s.setQuestion);
  const setAdvancedArgsText = useStore((s) => s.setAdvancedArgsText);
  const builtins = useStore((s) => s.builtins);
  const saved = useStore((s) => s.saved);
```

（组件内新增局部 `const [showAdvanced, setShowAdvanced] = useState(false);`）

- [ ] **步骤 2：替换底部参数区**

第 77-89 行（`参数 (JSON)` 块，止于 `parse && !parse.ok` 之前）替换为：

```tsx
            <div className="shrink-0 border-t border-ink-600 p-2">
              <div className="mb-1 text-[11px] tracking-wider text-ink-300 uppercase">问题</div>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void start();
                  }
                }}
                rows={3}
                spellCheck={false}
                placeholder="输入你的问题，Enter 直接发送…"
                className="w-full resize-y rounded border border-ink-600 bg-ink-950 p-1.5 text-[12px] outline-none focus:border-accent"
              />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-300">
                <span>发送至 {targetLabel}</span>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="underline-offset-2 hover:text-ink-100 hover:underline"
                >
                  高级参数 (JSON) {showAdvanced ? "▾" : "▸"}
                </button>
              </div>
              {showAdvanced && (
                <textarea
                  value={advancedArgsText}
                  onChange={(event) => setAdvancedArgsText(event.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder='{"diff": "…", "level": "xhigh"}（优先于问题框）'
                  className="mt-1 w-full resize-y rounded border border-ink-600 bg-ink-950 p-1.5 text-[12px] outline-none focus:border-accent"
                />
              )}
```

在 `const outline = parse?.outline;` 之后（return 之前）添加目标标签计算：

```ts
  const targetName = runName.trim();
  const byName =
    targetName !== "" &&
    (!script.trim() ||
      builtins.some((b) => b.name === targetName && script === b.script) ||
      saved.some((s) => s.name === targetName && script === s.script));
  const targetLabel = byName ? targetName : script.trim() ? "当前脚本" : "未选择";
```

（`runName`、`script` 已在组件顶部读取。）

- [ ] **步骤 3：构建验证**

```bash
cd web && bun run build
```

预期：`tsc -b` 无类型错误、vite 产出 `web/dist`。

- [ ] **步骤 4：Commit**

```bash
git add web/src/components/Authoring.tsx && git commit -m "feat(web): 参数框改造为问题输入框 + 折叠高级 JSON"
```

### 任务 3：浏览器端到端验证

**文件：** 无代码改动；驱动 `http://127.0.0.1:45503/?token=7AtcQh2pi-3MbFerM2ZriMJyohkrpfSa`

- [ ] **步骤 1：deep-research 问题发送**

点击「已保存 / 内置」列表中的 `deep-research` → 问题框输入一句短问题 → 点「运行」（或 Enter）。
预期：notice「已启动 …」、运行列表出现新 run、运行时视图显示 agent 派发。确认后暂停/停止该 run 以省 token。

- [ ] **步骤 2：code-review 提示**

点击 `code-review` → 问题框输入任意文本 → 点「运行」。预期：红色 notice 提示需要 diff，未发起运行。

- [ ] **步骤 3：高级 JSON 仍可用**

展开「高级参数 (JSON)」→ 填 `{"diff": "test"}` 非法值测试提示（或合法 JSON 确认折叠区显示正常）。预期：JSON 非法时提示「参数不是合法 JSON」。

- [ ] **步骤 4：Commit（如有验证期修复）**

```bash
git add -A && git commit -m "fix(web): 问题输入框验证期修复"
```
