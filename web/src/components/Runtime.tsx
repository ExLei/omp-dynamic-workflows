import clsx from "clsx";
import { Pause, Play, Square, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentSnapshot } from "../lib/types";
import { useStore } from "../store";
import { RuntimeFlow } from "./RuntimeFlow";
import { Button, fmtCost, fmtElapsed, fmtTokens, Panel, StatusDot } from "./ui";

type Tab = "agents" | "detail" | "result" | "logs" | "events";

const TABS: Tab[] = ["agents", "detail", "result", "logs", "events"];

export function Runtime() {
  const selectedRunId = useStore((s) => s.selectedRunId);
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  const run = useStore((s) => s.runs.find((entry) => entry.runId === s.selectedRunId));
  const control = useStore((s) => s.control);
  const remove = useStore((s) => s.remove);
  const [tab, setTab] = useState<Tab>("agents");

  const status = run?.status;
  const elapsed = run ? Date.now() - Date.parse(run.startedAt) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Panel
        title="运行时"
        className="min-h-0 flex-1"
        right={
          <>
            <Button disabled={status !== "running"} onClick={() => void control("pause")}>
              <Pause className="inline size-3" /> 暂停
            </Button>
            <Button
              disabled={status !== "paused" && status !== "failed"}
              onClick={() => void control("resume")}
              tone="primary"
            >
              <Play className="inline size-3" /> 恢复
            </Button>
            <Button disabled={status !== "running" && status !== "paused"} onClick={() => void control("stop")}>
              <Square className="inline size-3" /> 停止
            </Button>
            <Button disabled={!selectedRunId || status === "running"} tone="danger" onClick={() => void remove()}>
              <Trash2 className="inline size-3" />
            </Button>
          </>
        }
      >
        {!snapshot ? (
          <div className="p-3 text-xs text-ink-300">左侧选择一个运行,或在中间编辑脚本后点“运行”。</div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600 px-3 py-1.5 text-[11px] text-ink-300">
              <StatusDot status={status ?? "pending"} pulse />
              <span className="text-ink-100">{snapshot.name}</span>
              <span>phase {snapshot.currentPhase ?? "-"}</span>
              <span>
                {snapshot.doneCount}/{snapshot.agentCount} done
              </span>
              {snapshot.errorCount > 0 && <span className="text-bad">{snapshot.errorCount} err</span>}
              <span>{fmtTokens(snapshot.tokenUsage?.total)} tok</span>
              <span>{fmtCost(snapshot.tokenUsage?.cost)}</span>
              <span>{fmtElapsed(run?.durationMs ?? elapsed)}</span>
              {run?.pauseReason && <span className="text-busy">paused: {run.pauseReason}</span>}
            </div>
            <div className="min-h-0 flex-1">
              <RuntimeFlow snapshot={snapshot} />
            </div>
          </div>
        )}
      </Panel>

      <div className="flex h-[42%] min-h-0 flex-col border-t border-ink-600">
        <div className="flex gap-1 border-b border-ink-600 bg-ink-800 px-2 py-1">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={clsx(
                "rounded px-2 py-0.5 text-[10px] tracking-wider uppercase",
                tab === key ? "bg-ink-700 text-accent" : "text-ink-300 hover:text-ink-100",
              )}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "agents" && <AgentTable />}
          {tab === "detail" && <AgentDetail />}
          {tab === "result" && <ResultPane />}
          {tab === "logs" && <LogsPane />}
          {tab === "events" && <EventFeed />}
        </div>
      </div>
    </div>
  );
}

function AgentTable() {
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  const selectAgent = useStore((s) => s.selectAgent);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  if (!snapshot) return null;
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead className="sticky top-0 bg-ink-850 text-ink-300">
        <tr>
          {["", "id", "label", "phase", "model", "tokens", "结果/错误"].map((header) => (
            <th key={header} className="px-2 py-1 text-left font-normal">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {snapshot.agents.map((agent) => (
          <tr
            key={agent.id}
            onClick={() => selectAgent(agent.id)}
            className={clsx(
              "cursor-pointer border-t border-ink-600/60 hover:bg-ink-800",
              selectedAgentId === agent.id && "bg-ink-700",
            )}
          >
            <td className="px-2 py-1">
              <StatusDot status={agent.status} pulse />
            </td>
            <td className="px-2 py-1 text-ink-300">{agent.id}</td>
            <td className="px-2 py-1">{agent.label}</td>
            <td className="px-2 py-1 text-ink-300">{agent.phase ?? "-"}</td>
            <td className="px-2 py-1 text-ink-300">{agent.model ?? "-"}</td>
            <td className="px-2 py-1 text-ink-300">{fmtTokens(agent.tokenUsage?.total ?? agent.tokens)}</td>
            <td className="max-w-[280px] truncate px-2 py-1 text-ink-300">
              {agent.error ? <span className="text-bad">{agent.error}</span> : agent.resultPreview}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentDetail() {
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const agent: AgentSnapshot | undefined = snapshot?.agents.find((entry) => entry.id === selectedAgentId);
  if (!agent) return <div className="p-3 text-xs text-ink-300">在 agents 表或图上选择一个 agent</div>;
  return (
    <div className="space-y-2 p-2 text-[11px]">
      <div className="flex items-center gap-2">
        <StatusDot status={agent.status} />
        <span className="text-ink-100">
          [{agent.id}] {agent.label}
        </span>
        <span className="text-ink-300">{agent.model}</span>
        <span className="ml-auto text-ink-300">
          {fmtTokens(agent.tokenUsage?.total ?? agent.tokens)} tok {fmtCost(agent.tokenUsage?.cost)}
        </span>
      </div>
      <Section title="prompt">{agent.prompt}</Section>
      {agent.error && <Section title="error">{agent.error}</Section>}
      <Section title="result">{agent.resultPreview ?? ""}</Section>
      <div>
        <div className="mb-1 text-[10px] tracking-wider text-ink-300 uppercase">history</div>
        <div className="space-y-1">
          {(agent.history ?? []).map((entry, index) => (
            <div key={index} className="rounded border border-ink-600 bg-ink-850 px-2 py-1">
              <span className="text-[9px] text-accent">
                {entry.role}/{entry.kind}
                {entry.toolName ? ` ${entry.toolName}` : ""}
              </span>
              <div className={clsx("whitespace-pre-wrap", entry.isError && "text-bad")}>{entry.text}</div>
            </div>
          ))}
          {(agent.history ?? []).length === 0 && <div className="text-ink-300">无历史</div>}
        </div>
      </div>
    </div>
  );
}

function ResultPane() {
  const outcome = useStore((s) => (s.selectedRunId ? s.results[s.selectedRunId] : undefined));
  if (!outcome) return <div className="p-3 text-xs text-ink-300">运行结束后显示返回值</div>;
  return (
    <div className="space-y-2 p-2 text-[11px]">
      {outcome.error && <Section title="error">{`${outcome.error.code ?? ""} ${outcome.error.message}`}</Section>}
      <Section title={`return value${outcome.durationMs ? ` · ${fmtElapsed(outcome.durationMs)}` : ""}`}>
        {typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value, null, 2)}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] tracking-wider text-ink-300 uppercase">{title}</div>
      <pre className="max-h-52 overflow-auto rounded border border-ink-600 bg-ink-950 p-2 whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

function LogsPane() {
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  return <pre className="p-2 text-[11px] whitespace-pre-wrap">{(snapshot?.logs ?? []).join("\n") || "无日志"}</pre>;
}

function EventFeed() {
  const feed = useStore((s) => s.feed);
  return (
    <ul className="divide-y divide-ink-600/50 text-[11px]">
      {feed.map((entry) => (
        <li key={entry.id} className="flex gap-2 px-2 py-0.5">
          <span className="text-ink-300">{new Date(entry.at).toISOString().slice(11, 19)}</span>
          <span className="w-24 shrink-0 text-accent">{entry.type}</span>
          <span className="truncate text-ink-300">{entry.text}</span>
        </li>
      ))}
      {feed.length === 0 && <li className="px-2 py-1 text-ink-300">等待事件…</li>}
    </ul>
  );
}
