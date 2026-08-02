import { useEffect } from "react";
import { Authoring } from "./components/Authoring";
import { SaveDialog } from "./components/SaveDialog";
import { RunList } from "./components/RunList";
import { Runtime } from "./components/Runtime";
import { useStore } from "./store";

export default function App() {
  const connected = useStore((s) => s.connected);
  const cwd = useStore((s) => s.cwd);
  const connect = useStore((s) => s.connect);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    return connect();
  }, [connect, refresh]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-600 bg-ink-800 px-3 py-1.5">
        <span className="font-semibold text-accent">omp workflows</span>
        <span className="truncate text-[11px] text-ink-300">{cwd}</span>
        <span className={connected ? "ml-auto text-[11px] text-ok" : "ml-auto text-[11px] text-ink-300"}>
          {connected ? "● 实时已连接" : "○ 未连接"}
        </span>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-h-0 border-r border-ink-600">
          <RunList />
        </div>
        <div className="min-h-0 border-r border-ink-600">
          <Authoring />
        </div>
        <div className="min-h-0">
          <Runtime />
        </div>
      </main>
      <SaveDialog />
    </div>
  );
}
