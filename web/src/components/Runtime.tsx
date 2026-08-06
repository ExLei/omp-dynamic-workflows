import clsx from "clsx";
import { Copy, Pause, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store";
import { RuntimeFlow } from "./RuntimeFlow";
import { SplitGroup, SplitHandle, SplitPane } from "./Split";
import { Button, fmtCost, fmtElapsed, fmtTokens, Panel, StatusDot } from "./ui";

/** Run-scoped views only: anything about one agent lives in the drawer. */
type Tab = "agents" | "result" | "logs" | "events";

const TAB_LABEL: Record<Tab, string> = {
  agents: "智能体",
  result: "结果",
  logs: "日志",
  events: "事件",
};

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
    <SplitGroup id="runtime" orientation="vertical">
      <SplitPane id="graph" defaultSize="58%" minSize="120px">
        <Panel
          title="运行时"
          className="h-full min-h-0"
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
            <div className="p-3 text-[13px] text-ink-300">左侧选择一个运行,或在中间编辑脚本后点“运行”。</div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600 px-3 py-1.5 font-mono text-[12px] text-ink-300">
                <StatusDot status={status ?? "pending"} pulse />
                <span className="text-ink-100">{snapshot.name}</span>
                <span>阶段 {snapshot.currentPhase ?? "-"}</span>
                <span>
                  完成 {snapshot.doneCount}/{snapshot.agentCount}
                </span>
                {snapshot.runningCount > 0 && <span className="text-busy">运行中 {snapshot.runningCount}</span>}
                {snapshot.errorCount > 0 && <span className="text-bad">错误 {snapshot.errorCount}</span>}
                <span>{fmtTokens(snapshot.tokenUsage?.total)} token</span>
                <span>{fmtCost(snapshot.tokenUsage?.cost)}</span>
                <span>{fmtElapsed(run?.durationMs ?? elapsed)}</span>
                {run?.pauseReason && <span className="text-busy">已暂停:{run.pauseReason}</span>}
              </div>
              <div className="min-h-0 flex-1">
                <RuntimeFlow snapshot={snapshot} />
              </div>
            </div>
          )}
        </Panel>
      </SplitPane>

      <SplitHandle orientation="vertical" />

      <SplitPane id="inspect" defaultSize="42%" minSize="80px">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex gap-1 border-b border-ink-600 bg-ink-800 px-2 py-1">
            {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={clsx(
                  "rounded px-2 py-0.5 text-[11px] tracking-wider",
                  tab === key ? "bg-ink-700 text-accent" : "text-ink-300 hover:text-ink-100",
                )}
              >
                {TAB_LABEL[key]}
              </button>
            ))}
            <span className="ml-auto self-center text-[11px] text-ink-300">点击 agent 查看实时执行过程</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "agents" && <AgentTable />}
            {tab === "result" && <ResultPane />}
            {tab === "logs" && <LogsPane />}
            {tab === "events" && <EventFeed />}
          </div>
        </div>
      </SplitPane>
    </SplitGroup>
  );
}

function AgentTable() {
  const snapshot = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId] : undefined));
  const selectAgent = useStore((s) => s.selectAgent);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  if (!snapshot) return <div className="p-3 text-[13px] text-ink-300">未选择运行</div>;
  if (snapshot.agents.length === 0) return <div className="p-3 text-[13px] text-ink-300">尚未派发 agent</div>;
  return (
    <table className="w-full border-collapse font-mono text-[12px]">
      <thead className="sticky top-0 bg-ink-850 text-ink-300">
        <tr>
          {["", "ID", "标签", "阶段", "模型", "Token", "成本", "结果/错误"].map((header) => (
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
            <td className="px-2 py-1 text-ink-300">{fmtCost(agent.tokenUsage?.cost)}</td>
            <td className="max-w-[280px] truncate px-2 py-1 text-ink-300">
              {agent.error ? <span className="text-bad">{agent.error}</span> : agent.resultPreview}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The workflow's own return value — distinct from any single agent's result. */
function ResultPane() {
  const outcome = useStore((s) => (s.selectedRunId ? s.results[s.selectedRunId] : undefined));
  const status = useStore((s) => s.runs.find((entry) => entry.runId === s.selectedRunId)?.status);
  if (status === "running" || status === "paused") {
    return <div className="p-3 text-[13px] text-ink-300">运行中,结束后显示 workflow 的返回值</div>;
  }
  if (!outcome || (outcome.value === undefined && !outcome.error)) {
    return <div className="p-3 text-[13px] text-ink-300">没有返回值</div>;
  }
  const text =
    typeof outcome.value === "string" ? outcome.value : outcome.value === undefined ? "" : JSON.stringify(outcome.value, null, 2);
  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      {outcome.error && (
        <div className="mb-2 rounded border border-bad/40 bg-bad/5 px-2 py-1 text-[12px] text-bad">
          {outcome.error.code ? `[${outcome.error.code}] ` : ""}
          {outcome.error.message}
        </div>
      )}
      <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-ink-300 uppercase">
        <span>返回值</span>
        {outcome.durationMs ? <span>· {fmtElapsed(outcome.durationMs)}</span> : null}
        {text && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(text)}
            className="ml-auto flex items-center gap-1 rounded border border-ink-600 px-1.5 py-0.5 hover:border-accent hover:text-accent"
          >
            <Copy className="size-3" /> 复制
          </button>
        )}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded border border-ink-600 bg-ink-950 p-2 text-[12px] whitespace-pre-wrap">
        {text || "(空)"}
      </pre>
    </div>
  );
}

function LogsPane() {
  const logs = useStore((s) => (s.selectedRunId ? s.snapshots[s.selectedRunId]?.logs : undefined)) ?? [];
  if (logs.length === 0) return <div className="p-3 text-[13px] text-ink-300">无日志</div>;
  return (
    <ol className="divide-y divide-ink-600/40 font-mono text-[12px]">
      {logs.map((line, index) => (
        <li key={index} className="flex gap-2 px-2 py-0.5">
          <span className="w-8 shrink-0 text-right text-ink-300">{index + 1}</span>
          <span className="whitespace-pre-wrap text-ink-100">{line}</span>
        </li>
      ))}
    </ol>
  );
}

function EventFeed() {
  const feed = useStore((s) => s.feed);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const [onlyCurrent, setOnlyCurrent] = useState(true);
  const visible = onlyCurrent && selectedRunId ? feed.filter((entry) => entry.runId === selectedRunId) : feed;
  return (
    <div>
      <label className="flex items-center gap-1.5 border-b border-ink-600/60 px-2 py-1 text-[11px] text-ink-300">
        <input
          type="checkbox"
          checked={onlyCurrent}
          onChange={(event) => setOnlyCurrent(event.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        只看当前运行
      </label>
      <ul className="divide-y divide-ink-600/50 font-mono text-[12px]">
        {visible.map((entry) => (
          <li key={entry.id} className="flex gap-2 px-2 py-0.5">
            <span className="text-ink-300">{new Date(entry.at).toISOString().slice(11, 19)}</span>
            <span className="w-24 shrink-0 text-accent">{entry.type}</span>
            <span className="truncate text-ink-300">{entry.text}</span>
          </li>
        ))}
        {visible.length === 0 && <li className="px-2 py-1 text-ink-300">等待事件…</li>}
      </ul>
    </div>
  );
}
