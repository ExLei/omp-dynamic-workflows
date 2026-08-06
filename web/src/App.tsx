import { useEffect } from "react";
import { AgentDrawer } from "./components/AgentDrawer";
import { Authoring } from "./components/Authoring";
import { RunList } from "./components/RunList";
import { Runtime } from "./components/Runtime";
import { SaveDialog } from "./components/SaveDialog";
import { SplitGroup, SplitHandle, SplitPane } from "./components/Split";
import { useStore } from "./store";

export default function App() {
  const connected = useStore((s) => s.connected);
  const cwd = useStore((s) => s.cwd);
  const runs = useStore((s) => s.runs);
  const selectRun = useStore((s) => s.selectRun);
  const connect = useStore((s) => s.connect);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    return connect();
  }, [connect, refresh]);

  // Runs parked on a consult: surface the intervention prompt so the user can
  // jump straight into the editor and reply.
  const awaitingConsult = runs.filter((run) => run.status === "waiting_consult");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-600 bg-ink-800 px-3 py-1.5">
        <span className="font-semibold text-accent">工作流控制台</span>
        <span className="truncate font-mono text-[12px] text-ink-300">{cwd}</span>
        <span className={connected ? "ml-auto text-[12px] text-ok" : "ml-auto text-[12px] text-ink-300"}>
          {connected ? "● 实时已连接" : "○ 未连接"}
        </span>
      </header>
      {awaitingConsult.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-600 bg-ink-800 px-3 py-1">
          {awaitingConsult.map((run) => (
            <button
              key={run.runId}
              type="button"
              onClick={() => void selectRun(run.runId)}
              className="max-w-full truncate font-mono text-[12px] text-accent hover:underline"
              title="点击进入编辑器，修改脚本后点「回复并继续」"
            >
              待咨询 · {run.name}：{(run.pendingConsult?.prompt ?? "").slice(0, 80)}
            </button>
          ))}
        </div>
      )}
      <main className="relative min-h-0 flex-1">
        <SplitGroup id="main" orientation="horizontal">
          <SplitPane id="runs" defaultSize="17%" minSize="140px">
            <RunList />
          </SplitPane>
          <SplitHandle orientation="horizontal" />
          <SplitPane id="authoring" defaultSize="41%" minSize="260px">
            <Authoring />
          </SplitPane>
          <SplitHandle orientation="horizontal" />
          <SplitPane id="runtime" defaultSize="42%" minSize="280px">
            <Runtime />
          </SplitPane>
        </SplitGroup>
        <AgentDrawer />
      </main>
      <SaveDialog />
    </div>
  );
}
