import clsx from "clsx";
import { Copy, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentHistoryEntry, AgentSnapshot } from "../lib/types";
import { useStore } from "../store";
import { fmtCost, fmtTokens, StatusDot, statusLabel } from "./ui";

type DrawerTab = "live" | "result" | "prompt";

const WIDTH_KEY = "wf-drawer-width";
const MIN_WIDTH = 340;

/** Chip + colour per history entry kind, so a transcript is scannable. */
const ENTRY_STYLE: Record<AgentHistoryEntry["kind"], { chip: string; className: string }> = {
  text: { chip: "说明", className: "text-ink-100" },
  toolCall: { chip: "调用", className: "text-accent" },
  toolResult: { chip: "结果", className: "text-ink-300" },
  error: { chip: "错误", className: "text-bad" },
};

/**
 * Right-hand inspector for a single agent. It is the only place that shows an
 * untrimmed transcript: SSE snapshots ship the last few history entries per
 * agent, so the drawer pulls `/api/runs/:id/agents/:id` and refreshes it on
 * that agent's own events while it runs.
 */
export function AgentDrawer() {
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const selectAgent = useStore((s) => s.selectAgent);
  const loading = useStore((s) => s.agentDetailLoading);
  const detail = useStore((s) => s.agentDetail);
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 460);
  const [tab, setTab] = useState<DrawerTab | null>(null);

  useEffect(() => setTab(null), [selectedAgentId]);

  useEffect(() => {
    if (selectedAgentId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") selectAgent(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedAgentId, selectAgent]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      const next = Math.min(Math.max(window.innerWidth - move.clientX, MIN_WIDTH), window.innerWidth - 200);
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((current) => {
        localStorage.setItem(WIDTH_KEY, String(current));
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  if (selectedAgentId === null) return null;
  const agent: AgentSnapshot | undefined =
    detail?.agentId === selectedAgentId
      ? detail.agent
      : snapshot?.agents.find((entry) => entry.id === selectedAgentId);
  const live = agent?.status === "running" || agent?.status === "queued";
  // Default to whatever is actually informative: the stream while it runs, the
  // answer once it has one.
  const active: DrawerTab = tab ?? (live ? "live" : "result");

  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex border-l border-ink-600 bg-ink-900 shadow-[-8px_0_24px_rgba(0,0,0,0.45)]"
      style={{ width }}
    >
      <div
        onPointerDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-ink-600 transition-colors hover:bg-accent"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {!agent ? (
          <div className="p-3 text-[13px] text-ink-300">{loading ? "加载中…" : "该 agent 已不在当前运行中"}</div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-ink-600 bg-ink-800 px-3 py-2">
              <StatusDot status={agent.status} pulse />
              <span className="truncate font-mono text-[13px] text-ink-100">
                [{agent.id}] {agent.label}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-ink-300">{statusLabel(agent.status)}</span>
              {live && <span className="shrink-0 text-[11px] text-busy">实时</span>}
              <button
                type="button"
                onClick={() => selectAgent(null)}
                className="ml-auto rounded p-0.5 text-ink-300 hover:bg-ink-700 hover:text-ink-100"
                title="关闭 (Esc)"
              >
                <X className="size-3.5" />
              </button>
            </header>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600 px-3 py-1.5 font-mono text-[11px] text-ink-300">
              {agent.phase && <span>阶段 {agent.phase}</span>}
              <span>{agent.model ?? "模型未知"}</span>
              <span>{fmtTokens(agent.tokenUsage?.total ?? agent.tokens)} token</span>
              {agent.tokenUsage?.cost ? <span>{fmtCost(agent.tokenUsage.cost)}</span> : null}
              {agent.tokenUsage?.cacheRead ? <span>缓存 {fmtTokens(agent.tokenUsage.cacheRead)}</span> : null}
            </div>

            <nav className="flex gap-1 border-b border-ink-600 bg-ink-850 px-2 py-1">
              {(
                [
                  ["live", `执行过程${agent.history?.length ? ` · ${agent.history.length}` : ""}`],
                  ["result", agent.error ? "错误" : "结果"],
                  ["prompt", "提示词"],
                ] as Array<[DrawerTab, string]>
              ).map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={clsx(
                    "rounded px-2 py-0.5 text-[11px]",
                    active === key ? "bg-ink-700 text-accent" : "text-ink-300 hover:text-ink-100",
                  )}
                >
                  {text}
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-hidden">
              {active === "live" && <Timeline agent={agent} live={live} />}
              {active === "result" && <ResultView agent={agent} />}
              {active === "prompt" && <Block text={agent.prompt} empty="无提示词" />}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/** Chronological transcript, auto-following the tail unless the user scrolls up. */
function Timeline({ agent, live }: { agent: AgentSnapshot; live: boolean }) {
  const history = agent.history ?? [];
  const scroller = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [history.length]);

  if (history.length === 0) {
    return (
      <div className="p-3 text-[13px] text-ink-300">{live ? "等待第一条事件…" : "该 agent 没有记录执行过程"}</div>
    );
  }
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="h-full overflow-auto px-2 py-1.5"
    >
      <ol className="space-y-1">
        {history.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
      </ol>
      {live && <div className="px-1 py-1.5 text-[11px] text-busy">运行中…</div>}
    </div>
  );
}

const CLAMP_LINES = 12;

function Entry({ entry }: { entry: AgentHistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const style = ENTRY_STYLE[entry.kind] ?? ENTRY_STYLE.text;
  const lines = entry.text.split("\n");
  const clipped = !expanded && lines.length > CLAMP_LINES;
  const text = clipped ? lines.slice(0, CLAMP_LINES).join("\n") : entry.text;

  return (
    <li className={clsx("rounded border bg-ink-850 px-2 py-1", entry.isError ? "border-bad/40" : "border-ink-600")}>
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className={clsx("rounded-sm bg-ink-700 px-1", style.className)}>{style.chip}</span>
        {entry.toolName && <span className="font-mono text-accent">{entry.toolName}</span>}
        {entry.path && <span className="truncate font-mono text-ink-300">{entry.path}</span>}
        <span className="ml-auto font-mono text-ink-300">{entry.role}</span>
      </div>
      <pre className={clsx("mt-0.5 text-[12px] whitespace-pre-wrap", entry.isError ? "text-bad" : "text-ink-100")}>
        {text}
      </pre>
      {clipped && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-accent hover:underline"
        >
          展开剩余 {lines.length - CLAMP_LINES} 行
        </button>
      )}
    </li>
  );
}

function ResultView({ agent }: { agent: AgentSnapshot }) {
  if (agent.error) {
    return <Block text={`${agent.errorCode ? `[${agent.errorCode}] ` : ""}${agent.error}`} tone="error" />;
  }
  const value = agent.result ?? agent.resultPreview;
  if (value === undefined || value === null || value === "") {
    return <div className="p-3 text-[13px] text-ink-300">尚无结果</div>;
  }
  return <Block text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} />;
}

function Block({ text, tone, empty }: { text?: string; tone?: "error"; empty?: string }) {
  if (!text) return <div className="p-3 text-[13px] text-ink-300">{empty ?? "空"}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end px-2 pt-1.5">
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(text)}
          className="flex items-center gap-1 rounded border border-ink-600 px-1.5 py-0.5 text-[11px] text-ink-300 hover:border-accent hover:text-accent"
        >
          <Copy className="size-3" /> 复制
        </button>
      </div>
      <pre
        className={clsx(
          "min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12px] whitespace-pre-wrap",
          tone === "error" ? "text-bad" : "text-ink-100",
        )}
      >
        {text}
      </pre>
    </div>
  );
}
