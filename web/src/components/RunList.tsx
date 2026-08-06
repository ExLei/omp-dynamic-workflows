import clsx from "clsx";
import { BookMarked, Boxes } from "lucide-react";
import { useStore } from "../store";
import { SplitGroup, SplitHandle, SplitPane } from "./Split";
import { fmtCost, fmtTokens, locationLabel, Panel, StatusDot, statusLabel } from "./ui";

export function RunList() {
  const runs = useStore((s) => s.runs);
  const saved = useStore((s) => s.saved);
  const builtins = useStore((s) => s.builtins);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectRun = useStore((s) => s.selectRun);
  const control = useStore((s) => s.control);
  const loadSaved = useStore((s) => s.loadSaved);

  return (
    <SplitGroup id="runlist" orientation="vertical">
      <SplitPane id="runs" defaultSize="62%" minSize="60px">
        <Panel title={`运行 · ${runs.length}`} className="h-full min-h-0">
          <ul className="space-y-1 p-2">
            {runs.length === 0 && <li className="px-1 text-[13px] text-ink-300">暂无运行</li>}
            {runs.map((run) => (
              <li key={run.runId}>
                <div
                  className={clsx(
                    "rounded border px-2 py-1.5 transition-colors",
                    run.runId === selectedRunId
                      ? "border-accent bg-ink-700"
                      : "border-ink-600 bg-ink-800 hover:border-accent/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void selectRun(run.runId)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <StatusDot status={run.status} pulse />
                    <span className="truncate font-mono text-[13px]">{run.name}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-300">{statusLabel(run.status)}</span>
                  </button>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-300">
                    {run.doneCount}/{run.agentCount} 个 agent
                    {run.errorCount > 0 && <span className="text-bad"> · {run.errorCount} 错误</span>} ·{" "}
                    {fmtTokens(run.tokens)} token {fmtCost(run.cost)}
                  </div>
                  {run.currentPhase && (
                    <div className="truncate font-mono text-[11px] text-accent/80">▸ {run.currentPhase}</div>
                  )}
                  {(run.status === "running" || run.status === "paused" || run.status === "waiting_consult") && (
                    <button
                      type="button"
                      title={
                        run.status === "waiting_consult"
                          ? "进入编辑器，修改脚本后点「回复并继续」"
                          : "暂停执行并进入人工介入"
                      }
                      onClick={() => void (run.status === "waiting_consult" ? selectRun(run.runId) : control("intervene", run.runId))}
                      className="mt-1 w-full rounded border border-ink-600 px-1.5 py-0.5 font-mono text-[11px] text-accent hover:border-accent"
                    >
                      ✎ 介入
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </SplitPane>

      <SplitHandle orientation="vertical" />

      <SplitPane id="saved" defaultSize="38%" minSize="60px">
        <Panel title="已保存 / 内置" className="h-full min-h-0">
          <ul className="space-y-1 p-2">
            {saved.map((entry) => (
              <li key={`saved-${entry.name}`}>
                <button
                  type="button"
                  onClick={() => loadSaved(entry.name)}
                  className="flex w-full items-center gap-2 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-left hover:border-accent/60"
                >
                  <BookMarked className="size-3 text-accent" />
                  <span className="truncate font-mono text-[13px]">/{entry.name}</span>
                  <span className="ml-auto text-[11px] text-ink-300">{locationLabel(entry.location)}</span>
                </button>
              </li>
            ))}
            {builtins.map((entry) => (
              <li key={`builtin-${entry.name}`}>
                <button
                  type="button"
                  onClick={() => loadSaved(entry.name)}
                  title={entry.description}
                  className="flex w-full items-center gap-2 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-left hover:border-accent/60"
                >
                  <Boxes className="size-3 text-ink-300" />
                  <span className="truncate font-mono text-[13px]">/{entry.name}</span>
                  <span className="ml-auto text-[11px] text-ink-300">内置</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </SplitPane>
    </SplitGroup>
  );
}
