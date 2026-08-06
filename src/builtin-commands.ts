/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`,
 * `/multi-perspective`, `/code-review`, and `/codebase-audit`.
 *
 * Each command starts its generated workflow through the WorkflowManager's
 * background path — the command returns immediately, progress is visible in
 * the task panel and `/workflows` (pause/stop work like any managed run), and
 * the report is delivered back into the conversation on completion by
 * installResultDelivery. Running inline in the handler instead would block the
 * whole session until the workflow finished (#104).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "./omp-api.js";
import type { BuiltinWorkflowInvocation } from "./builtin-workflows.js";
import { findBuiltinWorkflow } from "./builtin-workflows.js";
import { MAX_DIFF_CHARS } from "./code-review.js";
import { parseCommandArgs } from "./saved-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";

const execFileAsync = promisify(execFile);

/**
 * Cap on the diff-source exec's stdout+stderr buffer. Node's default (1 MB)
 * throws on anything but a small diff — `gh pr diff` on a sizeable PR routinely
 * exceeds it. 64 MB comfortably covers any realistic diff while still bounding
 * worst-case memory; the prompt-side cap (code-review.ts's MAX_DIFF_CHARS) is
 * what actually protects the review from a huge diff, not this buffer.
 */
const DIFF_EXEC_MAX_BUFFER = 64 * 1024 * 1024;

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

/** Split a command argument string into tokens, respecting single/double quotes. */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * Start a built-in workflow through the manager's background path and tell the
 * user where to watch it. startInBackground can throw synchronously (script
 * parse, run lease) — surface that as a notify instead of an unhandled error.
 * Async failures are handled by the manager's generic delivery ("✗ Background
 * workflow … failed"), so no handler-side await is needed — that await is
 * exactly what used to hang the session (#104).
 */
function startBackground(
  manager: WorkflowManager,
  ctx: ExtensionCommandContext,
  name: string,
  script: string,
  args?: unknown,
  exec?: { tools?: ToolDefinition[]; toolset?: string },
): void {
  try {
    const { runId } = manager.startInBackground(script, args, exec ?? {});
    ctx.ui.notify(
      `/${name} 正在后台运行（${runId}）— 可查看任务面板或 /workflows；完成后报告会发到这里。`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`${name} 启动失败：${error instanceof Error ? error.message : error}`, "error");
  }
}

/**
 * Look up a built-in descriptor by its fixed, hardcoded name. Every call site
 * below passes one of the 5 literal names in BUILTIN_WORKFLOWS, so this can
 * only throw if that registry and this file's command names fall out of sync
 * — a programming error, not a user-input problem (tests pin the names stay
 * in sync, see builtin-commands.test.ts).
 */
function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  if (!found) throw new Error(`internal error: no built-in workflow registered for "${name}"`);
  return found;
}

/**
 * Resolve a built-in's script/exec context for the given args, surfacing an
 * invalid-args error (e.g. a whitespace-only string that passes the handler's
 * cheap `!value` check but fails the registry's real validation) as the same
 * kind of warning notify the handlers already use for their own validation,
 * rather than an uncaught rejection.
 */
function resolveBuiltinOrNotify(
  name: string,
  cwd: string,
  args: unknown,
  ctx: ExtensionCommandContext,
): BuiltinWorkflowInvocation | undefined {
  try {
    return requireBuiltin(name).resolve(cwd, args);
  } catch (error) {
    ctx.ui.notify(`/${name}：${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}

export function registerBuiltinWorkflows(
  pi: ExtensionAPI,
  opts: { cwd: string; manager: WorkflowManager; storage?: WorkflowStorage },
): void {
  const { cwd, manager } = opts;
  const storage = opts.storage ?? createWorkflowStorage(cwd);

  /**
   * A project/user saved workflow always takes precedence over a built-in of
   * the same name — on every path, not just the `workflow` tool's `name`
   * input. Builtins are registered as commands before saved workflows
   * (registerAllSavedWorkflows skips a name that's already registered), so
   * without this dynamic check a same-named saved workflow would silently
   * never run from its slash command. Checking here, at invocation time
   * rather than registration time, makes "saved wins" hold regardless of
   * registration order. Mirrors registerSavedWorkflow's own handler exactly
   * (same parseCommandArgs call, same startBackground path, no builtin exec
   * context) so a shadowed command behaves identically to how it would if the
   * saved workflow itself had been registered under this name.
   */
  function runSavedShadowIfPresent(name: string, rawArgs: string, ctx: ExtensionCommandContext): boolean {
    const saved = storage.load(name);
    if (!saved) return false;
    startBackground(manager, ctx, name, saved.script, parseCommandArgs(rawArgs, saved.parameters));
    return true;
  }

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "深度研究：扇出网络搜索、抓取来源、3 票对抗验证主张、输出带引用的报告",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("deep-research", args, ctx)) return;
        const question = args.trim();
        if (!question) return ctx.ui.notify("用法: /deep-research <问题>", "warning");
        // Resolve through the shared builtin registry (builtin-workflows.ts) so
        // this command and the workflow tool's `name` input always run the exact
        // same generated script and exec context (tools/toolset) for this pattern.
        const resolved = resolveBuiltinOrNotify("deep-research", cwd, { question }, ctx);
        if (!resolved) return;
        startBackground(
          manager,
          ctx,
          "deep-research",
          resolved.script,
          { question },
          {
            tools: resolved.tools,
            toolset: resolved.toolset,
          },
        );
      },
    });
  }

  if (!alreadyRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "调查一个任务，再由持怀疑态度的审查者交叉核对每项发现",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("adversarial-review", args, ctx)) return;
        const task = args.trim();
        if (!task) return ctx.ui.notify("用法: /adversarial-review <任务或问题>", "warning");
        const resolved = resolveBuiltinOrNotify("adversarial-review", cwd, { task }, ctx);
        if (!resolved) return;
        startBackground(manager, ctx, "adversarial-review", resolved.script, { task });
      },
    });
  }

  if (!alreadyRegistered(pi, "code-review")) {
    pi.registerCommand("code-review", {
      description: "分级多角度代码审查：正确性/复用简化效率/抽象层级 finder 池 + 按位置分组验证 + 排序后的发现",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("code-review", args, ctx)) return;
        const input = args.trim();
        let diffSource = "git diff HEAD";
        let diff = "";

        try {
          let cmd: string;
          let cmdArgs: string[];
          if (!input) {
            diffSource = "git diff HEAD";
            cmd = "git";
            cmdArgs = ["diff", "HEAD"];
          } else if (/^\d+$/.test(input)) {
            diffSource = `gh pr diff ${input}`;
            cmd = "gh";
            cmdArgs = ["pr", "diff", input];
          } else if (input.includes("..")) {
            diffSource = `git diff ${input}`;
            cmd = "git";
            cmdArgs = ["diff", input];
          } else {
            diffSource = `git diff HEAD -- ${input}`;
            cmd = "git";
            cmdArgs = ["diff", "HEAD", "--", input];
          }
          // execFile (not exec/shell) + array args: input can't break out into a
          // shell command. maxBuffer raised well past Node's 1MB default so a
          // large `gh pr diff` doesn't throw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER.
          const { stdout } = await execFileAsync(cmd, cmdArgs, { cwd, maxBuffer: DIFF_EXEC_MAX_BUFFER });
          diff = stdout;
          if (!diff.trim()) {
            return ctx.ui.notify(`${diffSource} 没有 diff 输出`, "warning");
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
            return ctx.ui.notify(
              `来自 ${diffSource} 的 diff 超过 ${Math.floor(DIFF_EXEC_MAX_BUFFER / (1024 * 1024))}MB 捕获上限 — ` +
                `请缩小目标（如指定文件或路径）后重试。`,
              "error",
            );
          }
          return ctx.ui.notify(
            `获取 diff 失败（${diffSource}）：${err instanceof Error ? err.message : err}`,
            "error",
          );
        }

        // The workflow itself also caps prompt size (MAX_DIFF_CHARS), but truncating
        // here lets us tell the user clearly rather than have it happen silently deep
        // inside the generated script.
        const originalLength = diff.length;
        if (originalLength > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS);
          ctx.ui.notify(
            `diff 共 ${originalLength.toLocaleString()} 个字符 — 已截断到前 ` +
              `${MAX_DIFF_CHARS.toLocaleString()} 个供审查。截断之后的发现不在覆盖范围内。`,
            "warning",
          );
        }

        const resolved = resolveBuiltinOrNotify("code-review", cwd, { diff, diffSource }, ctx);
        if (!resolved) return;
        startBackground(manager, ctx, "code-review", resolved.script, { diff, diffSource });
      },
    });
  }

  if (!alreadyRegistered(pi, "multi-perspective")) {
    pi.registerCommand("multi-perspective", {
      description: "并行从多个独立视角分析主题，然后综合",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("multi-perspective", args, ctx)) return;
        const [topic, ...rest] = tokenizeArgs(args);
        if (!topic) {
          return ctx.ui.notify('用法: /multi-perspective "<主题>" [视角1] [视角2] …', "warning");
        }
        // resolve() falls back to a broadly-useful default set when fewer than
        // two perspectives are given (see builtin-workflows.ts).
        const resolved = resolveBuiltinOrNotify("multi-perspective", cwd, { topic, perspectives: rest }, ctx);
        if (!resolved) return;
        startBackground(manager, ctx, "multi-perspective", resolved.script);
      },
    });
  }

  if (!alreadyRegistered(pi, "codebase-audit")) {
    pi.registerCommand("codebase-audit", {
      description: "对代码库范围并行执行检查，然后交叉验证并报告",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("codebase-audit", args, ctx)) return;
        const [scope, ...checks] = tokenizeArgs(args);
        if (!scope || checks.length === 0) {
          return ctx.ui.notify('用法: /codebase-audit <范围> "<检查1>" ["<检查2>" …]', "warning");
        }
        const resolved = resolveBuiltinOrNotify("codebase-audit", cwd, { scope, checks }, ctx);
        if (!resolved) return;
        startBackground(manager, ctx, "codebase-audit", resolved.script);
      },
    });
  }
}
