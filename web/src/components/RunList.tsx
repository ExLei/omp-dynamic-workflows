import clsx from "clsx";
import { BookMarked, Boxes } from "lucide-react";
import { useStore } from "../store";
import { SplitGroup, SplitHandle, SplitPane } from "./Split";
import { fmtCost, fmtTokens, Panel, StatusDot } from "./ui";

export function RunList() {
  const runs = useStore((s) => s.runs);
  const saved = useStore((s) => s.saved);
  const builtins = useStore((s) => s.builtins);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectRun = useStore((s) => s.selectRun);
  const loadSaved = useStore((s) => s.loadSaved);

  return (
    <SplitGroup id="runlist" orientation="vertical">
      <SplitPane id="runs" defaultSize="62%" minSize="60px">
        <Panel title={`运行 · ${runs.length}`} className="h-full min-h-0">
          <ul className="space-y-1 p-2">
            {runs.length === 0 && <li className="px-1 text-[13px] text-ink-300">暂无运行</li>}
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  onClick={() => void selectRun(run.runId)}
                  className={clsx(
                    "w-full rounded border px-2 py-1.5 text-left transition-colors",
                    run.runId === selectedRunId
                      ? "border-accent bg-ink-700"
                      : "border-ink-600 bg-ink-800 hover:border-accent/60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={run.status} pulse />
                    <span className="truncate font-mono text-[13px]">{run.name}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-300">{run.status}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-300">
                    {run.doneCount}/{run.agentCount} agents
                    {run.errorCount > 0 && <span className="text-bad"> · {run.errorCount} err</span>} ·{" "}
                    {fmtTokens(run.tokens)} tok {fmtCost(run.cost)}
                  </div>
                  {run.currentPhase && (
                    <div className="truncate font-mono text-[11px] text-accent/80">▸ {run.currentPhase}</div>
                  )}
                </button>
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
                  <span className="ml-auto text-[11px] text-ink-300">{entry.location}</span>
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
