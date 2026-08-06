# Web 控制台问题输入框 设计

> 日期：2026-08-07
> 状态：待实现

## 背景与目标

Web 控制台（`web/`，由 `src/web-server.ts` 提供）的「编排 · 脚本」面板底部是
「参数 (JSON)」文本框，运行时必须手填 JSON（如 `{"question":"..."}`）。用户希望把
参数输入框改造成**可以直接输入问题的框框**，从而在控制台直接发送问题。

目标：普通用户零 JSON 知识即可在控制台输入问题并启动工作流；同时不丢失 code-review
（需要 diff）与自定义脚本的复杂参数能力。

## 现状（已核实）

- `web/src/components/Authoring.tsx` 底部：`参数 (JSON)` 标签 + textarea（`argsText`），
  「运行」按钮在面板头部。
- `web/src/store.ts` `start()`：`argsText` 解析为 JSON，然后
  `script.trim() ? { script, args } : { name: runName.trim(), args }` POST `/api/runs`。
- 后端 `/api/runs`（`src/web-server.ts`）：`script` 为空时按 `name` 经
  `resolveWorkflowInvocation` 解析内置/已保存工作流；内置模式校验各自参数键。
- 内置模式参数键：`deep-research→question`、`adversarial-review→task`、
  `multi-perspective→topic`、`codebase-audit→scope`、`code-review→diff`（不适用提问）。
- 脚本内可读全局 `args`（如 `args.question`）。
- `web/` 无前端测试基建；构建 = `bun run build`（`tsc -b && vite build`）→ `web/dist`；
  运行中的服务器每请求从磁盘读文件，重建即生效，无需重启。

## 设计

### 1. UI（`web/src/components/Authoring.tsx` 底部参数区）

- 「参数 (JSON)」标签与 textarea 替换为「问题」多行输入框（rows=3，
  placeholder「输入你的问题…」，`Enter` 直接发送、`Shift+Enter` 换行）。
- 「高级参数 (JSON)」折叠开关（默认收起）：展开后显示原 JSON textarea。
  填写了 JSON 时 JSON 优先，否则用问题框内容。
- 问题框下方一行小字提示发送去向（如「发送至 deep-research」）。

### 2. 发送逻辑（`web/src/store.ts` `start()`）

映射表（前端常量）：

```ts
const BUILTIN_QUESTION_KEY: Record<string, string> = {
  "deep-research": "question",
  "adversarial-review": "task",
  "multi-perspective": "topic",
  "codebase-audit": "scope",
};
```

- **激活项是内置模式**（`runName` 匹配内置名，且编辑器脚本与预览脚本一致，即未改动）：
  按名发送 `{ name, args: { <映射键>: 问题 } }`；code-review 给出提示
  「该模式需要 diff 参数，请展开高级参数 (JSON) 输入」并不发送。
- **激活项是已保存工作流**（`runName` 匹配且脚本未改动）：按名发送
  `{ name, args: { question } }`（保留 tools/toolset 绑定）。
- **自定义脚本**（其余情况）：`{ script, args: { question } }`。
- 高级 JSON 非空 → 解析后作为 `args` 基准；若问题框也非空且当前目标是内置模式、
  JSON 中缺少映射键 → 用问题补齐（如 `{"angles":3}` + 问题 → `{"angles":3,"question":"…"}`），
  避免必填键缺失导致 400。
- 错误：问题与高级 JSON 都为空 → 提示「请输入问题」；高级 JSON 非法 →
  提示「参数不是合法 JSON」（沿用现有 notice 机制）；`runName` 为空且脚本为空 →
  提示「没有可运行的工作流」。

目标判定细节：脚本为空视为"按名意图"；脚本被用户改过（≠ 预览/保存脚本）则按脚本发送。

### 3. 状态变更（`web/src/store.ts`）

- `argsText`/`setArgsText` → `question`/`setQuestion` 与 `advancedArgsText`/`setAdvancedArgsText`。
- `start()` 重写为上述逻辑；其余 action 不动。

### 4. 后端

零改动。`/api/runs` 已支持 `{name, args}` 与 `{script, args}`。

## 边界与错误处理

| 场景 | 行为 |
| --- | --- |
| 问题为空且高级 JSON 为空 | notice「请输入问题」，不发送 |
| 高级 JSON 非法 | notice「参数不是合法 JSON」，不发送 |
| 激活 code-review，问题框发送 | notice 提示需 diff，引导展开高级 JSON |
| 内置预览脚本被用户改动 | 按脚本发送（不再按名），args 用映射键 |
| 空脚本 + 空 runName | notice「没有可运行的工作流」 |
| 内置 multi-perspective / codebase-audit 预览含 `<topic>`/`<scope>` 字面量 | 按名发送即规避（预览只是展示） |

## 验证

- `cd web && bun run build` 通过（tsc -b 无类型错误）。
- 浏览器驱动 `http://127.0.0.1:45503`：选 deep-research → 输入问题 → 发送 →
  运行启动、agent 派发；高级 JSON 折叠展开/收起正常；code-review 提示正常。
- 后端路径由现有 `tests/web-server.test.ts` 覆盖，无回归。

## 非目标

- 不改后端、不加前端测试基建、不动其他面板。
- 已保存工作流的复杂参数形态不在本设计内解决（仍走高级 JSON）。
