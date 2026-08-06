/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./omp-api.js";
import {
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { type EffortState, effortDirective } from "./effort-command.js";
import type { PersistedRunState } from "./run-persistence.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { saveLocationOptions, type WorkflowStorage } from "./workflow-saved.js";

/**
 * The navigator drags in the pi-tui component tree; keep it out of the startup
 * module graph and load it on the first `/workflows` open instead.
 */
async function openNavigator(...args: Parameters<typeof import("./workflow-ui.js").openWorkflowNavigator>) {
  const { openWorkflowNavigator } = await import("./workflow-ui.js");
  return openWorkflowNavigator(...args);
}

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  waiting_consult: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

const USAGE =
  "用法: /workflows [list] | run <提示> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | rm <id> | save <名称> [runId]";

const RUN_USAGE = "用法: /workflows run <提示> — 根据提示强制执行动态工作流";

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const done = run.agents.filter((a) => a.status === "done").length;
  const total = run.agents.length;
  const segment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  const tokens = segment ? ` · ${segment}` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}

function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const total = snapshot.agents.length;
  const done = snapshot.agents.filter((a) => a.status === "done").length;
  const running = snapshot.agents.filter((a) => a.status === "running").length;
  const errs = snapshot.agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  return `◆ ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}`;
}

/**
 * Subscribe to a running run's events and stream live progress, printing the
 * final snapshot when it finishes. Non-blocking: returns true if the run was
 * active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 *
 * With a UI the progress streams to the status bar; without one (ACP/headless)
 * there is no status bar to push into, so one compact progress line is sent as
 * a `workflow-watch` custom message every second instead, and the interval is
 * cleared when the run settles (complete/error/stopped/paused). `rm` emits no
 * final event, so the headless tick also self-cleans when the run's snapshot
 * disappears — the timer never idles until session shutdown.
 */
function watchRun(manager: WorkflowManager, pi: ExtensionAPI, ctx: ExtensionCommandContext, id: string): boolean {
  const active = manager.getRun(id);
  if (active?.status !== "running") return false;

  // Headless/ACP sessions have no status bar. Stream one compact progress line
  // per second as a custom message; stop and clear the interval on settle.
  // Host-managed ctx.setInterval keeps throws contained, is unref'd, and is
  // cleared automatically on session shutdown (runner.clearManagedTimers).
  if (!ctx.hasUI) {
    const finalEvents = ["complete", "error", "stopped", "paused"];
    let settled = false;
    let timer: Timer | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      for (const ev of finalEvents) manager.off(ev, finish);
      if (timer) ctx.clearTimer(timer);
    };
    const finish = (e: { runId?: string }) => {
      if (e && e.runId !== id) return;
      cleanup();
      const run = manager.getRun(id);
      if (run) {
        void pi.sendMessage({
          customType: "workflows",
          content: renderWorkflowText(recomputeWorkflowSnapshot(run.snapshot), true),
          display: true,
        });
      }
    };
    const emit = () => {
      const snapshot = manager.getSnapshot(id);
      if (!snapshot) {
        // The run was removed (rm emits no final event): self-clean now so the
        // timer does not idle until the session ends. `settled` also guards
        // against re-entry from any event still in flight.
        cleanup();
        return;
      }
      pi.sendMessage({ customType: "workflow-watch", content: oneLineProgress(snapshot), display: true });
    };
    timer = ctx.setInterval(emit, 1000);
    for (const ev of finalEvents) manager.on(ev, finish);
    emit();
    return true;
  }

  const key = `wf:${id}`;
  const update = () => {
    const run = manager.getRun(id);
    if (run) ctx.ui.setStatus(key, oneLineProgress(run.snapshot));
  };
  const onEvent = (e: { runId?: string }) => {
    if (!e || e.runId === id) update();
  };
  let settled = false;
  const progressEvents = ["agentStart", "agentEnd", "phase", "log"];
  const finalEvents = ["complete", "error", "stopped", "paused"];
  const finish = (e: { runId?: string }) => {
    if (e && e.runId !== id) return;
    if (settled) return;
    settled = true;
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const ev of finalEvents) manager.off(ev, finish);
    ctx.ui.setStatus(key, undefined);
    const run = manager.getRun(id);
    if (run) {
      void pi.sendMessage({
        customType: "workflows",
        content: renderWorkflowText(recomputeWorkflowSnapshot(run.snapshot), true),
        display: true,
      });
    }
  };
  for (const ev of progressEvents) manager.on(ev, onEvent);
  for (const ev of finalEvents) manager.on(ev, finish);
  update();
  return true;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${run.status}`];
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of run.agents) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(`  ${icon} ${agent.label}`);
  }
  const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  if (tokenSegment) lines.push(`  tokens: ${tokenSegment}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export const SAVE_USAGE = "用法: /workflows save <名称> [runId] [project|user]";

function isSaveLocation(value: string): value is "project" | "user" {
  return value === "project" || value === "user";
}

/**
 * Resolve the destination for a saved workflow: an explicit `project`/`user`
 * argument wins, otherwise ask. A dismissed dialog returns undefined so the
 * caller aborts rather than writing somewhere the user never picked; a host with
 * no usable selector at all falls back to "project", the committable default.
 */
async function pickSaveLocation(
  ctx: ExtensionCommandContext,
  cwd: string,
  name: string,
  existing: Array<"project" | "user">,
  explicit?: "project" | "user",
): Promise<"project" | "user" | undefined> {
  if (explicit) return explicit;
  const options = saveLocationOptions(cwd);
  const labels = options.map(
    (o) => `${o.label}  ${o.display}${existing.includes(o.location) ? "  （覆盖）" : ""}`,
  );
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(`/${name} 保存到哪里？`, labels);
  } catch {
    return "project";
  }
  if (!choice) return undefined;
  return options[labels.indexOf(choice)]?.location;
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling `/workflows save`. */
  storage?: WorkflowStorage;
  /** Working directory for saved workflows registered via `save`. */
  cwd?: string;
  /** Standing effort mode; when high/ultra, `/workflows run` carries its directive too. */
  effort?: EffortState;
  /** Live web console URL, when the console is running. Enables `/workflows web`. */
  getWebConsoleUrl?: () => string | undefined;
}

/** Register the `/workflows` command against the shared manager. Idempotent. */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: WorkflowCommandOptions = {},
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflows", {
    description: "工作流运行列表与控制：list/status/watch/pause/resume/stop/rm/run/save/web",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) => pi.sendMessage({ customType: "workflows", content: text, display: true });

      switch (sub) {
        case "run": {
          const prompt = args
            .trim()
            .slice(parts[0]?.length ?? 0)
            .trim();
          if (!prompt) {
            ctx.ui.notify(RUN_USAGE, "warning");
            return;
          }

          // Best-effort: ensure the workflow tool is active (session_start usually has).
          // Add-only so this does not interfere with the keyword hook's save/restore state.
          try {
            const active = pi.getActiveTools?.() ?? [];
            if (!active.includes(WORKFLOW_TOOL_NAME)) pi.setActiveTools?.([...active, WORKFLOW_TOOL_NAME]);
          } catch {
            // ignore — the forced directive is the real forcing primitive
          }

          const effort = opts.effort;
          const extra = effort && effort.level !== "off" ? effortDirective(effort.level) : undefined;
          // `/workflows run` is an explicit, maximal-intent command — use the
          // forcing directive (no "if it's a question just answer" escape),
          // distinct from the heuristic keyword/effort arming.
          const armed = buildForcedWorkflowPrompt(prompt, extra);
          ctx.ui.notify(`正在运行工作流：${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "info");
          try {
            await pi.sendMessage(
              { customType: "workflow-run", content: armed, display: true },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            ctx.ui.notify("无法启动工作流回合。", "error");
          }
          return;
        }
        // `/workflows web` opens the console; `/workflows web url` only prints it
        // (SSH, or when you want to paste the URL into another machine's browser).
        case "web": {
          const url = opts.getWebConsoleUrl?.();
          if (!url) {
            ctx.ui.notify(
              'Web 控制台未运行。请在 ~/.omp/workflows/settings.json 中设置 {"web":{"enabled":true}}，或以 OMP_WORKFLOW_WEB=1 运行。',
              "warning",
            );
            return;
          }
          // Always print: the URL carries the per-process token, and a transient
          // notify is not something the user can scroll back to.
          await print(`工作流 Web 控制台：${url}`);
          if ((parts[1] ?? "").toLowerCase() === "url") return;
          const { openInBrowser } = await import("./web-open.js");
          const opened = await openInBrowser(url);
          if (!opened.ok) ctx.ui.notify(`无法打开浏览器（${opened.reason}）— 请使用上面的 URL。`, "warning");
          return;
        }
        case "ui":
        case "list": {
          // Interactive navigator when a UI is available; plain text otherwise
          // (print/RPC mode) or when the user explicitly asks for `list`.
          if (sub !== "list" && ctx.hasUI) {
            await openNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          if (parts.length === 0 && ctx.hasUI) {
            await openNavigator(pi, manager, ctx.ui, { storage: opts.storage, cwd: opts.cwd });
            return;
          }
          const runs = manager.listRuns();
          if (!runs.length) {
            await print("还没有工作流运行。用后台工作流启动一个（background: true）。");
            return;
          }
          await print(["工作流运行：", ...runs.map(summarizeRun), "", USAGE].join("\n"));
          return;
        }
        case "watch":
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          // A running run streams live progress (status bar, or text messages
          // in headless sessions) and prints the final snapshot when it
          // finishes — no need to re-run the command.
          if (watchRun(manager, pi, ctx, id)) {
            ctx.ui.notify(
              ctx.hasUI
                ? `正在观察 ${id} — 状态栏实时进度；结束后打印结果。`
                : `正在观察 ${id} — 实时进度消息；结束后打印结果。`,
              "info",
            );
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(recomputeWorkflowSnapshot(live), false));
            return;
          }
          const run = manager.listRuns().find((r) => r.runId === id);
          if (!run) {
            ctx.ui.notify(`不存在工作流运行 "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(
            manager.stop(id) ? `已停止 ${id}` : `无法停止 ${id}（未在运行）`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `已暂停 ${id}` : `无法暂停 ${id}（未在运行）`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          ctx.ui.notify(ok ? `已恢复 ${id}` : `${id} 暂不可恢复`, ok ? "info" : "warning");
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.deleteRun(id) ? `已删除 ${id}` : `不存在运行 ${id}`, "info");
          return;
        }
        case "save": {
          const name = id;
          if (!name) return ctx.ui.notify(SAVE_USAGE, "warning");
          if (!opts.storage) return ctx.ui.notify("保存不可用（未配置存储）", "error");
          const storage = opts.storage;
          const runs = manager.listRuns();
          // Trailing `project`/`user` selects the destination up front and skips
          // the picker, so the command stays scriptable; anything else is a runId.
          const rest = parts.slice(2).filter(Boolean);
          const explicit = rest.find(isSaveLocation);
          const runIdArg = rest.find((part) => !isSaveLocation(part));
          // Pick the named run, else the most recent run that still has its script.
          const run = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.script);
          if (!run?.script) {
            ctx.ui.notify(runIdArg ? `不存在带脚本的运行 ${runIdArg}` : "没有可保存的运行", "error");
            return;
          }
          // Ask where it goes, the way Claude Code does for project vs personal
          // commands.
          const existing = storage.locationsOf(name);
          const location = await pickSaveLocation(ctx, opts.cwd ?? process.cwd(), name, existing, explicit);
          if (!location) return;
          let saved: ReturnType<WorkflowStorage["save"]>;
          try {
            saved = storage.save({ name, description: run.workflowName, script: run.script, location }, location);
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          registerSavedWorkflow(pi, opts.cwd ?? process.cwd(), saved, undefined, () =>
            storage.list().some((w) => w.name === saved.name),
          );
          const verb = existing.includes(location) ? "已更新" : "已保存";
          ctx.ui.notify(`${verb} /${name} → ${saved.path}（来自 ${run.runId}）`, "info");
          return;
        }
        default:
          ctx.ui.notify(`未知子命令 "${sub}"。${USAGE}`, "warning");
      }
    },
  });
}
