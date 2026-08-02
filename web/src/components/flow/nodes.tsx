import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import clsx from "clsx";
import { fmtTokens, STATUS_COLOR } from "../ui";

export type AgentNodeData = {
  label: string;
  status: string;
  model?: string;
  tokens?: number;
  preview?: string;
  agentId: number;
};
export type PhaseNodeData = { label: string; current: boolean; count: number };
export type OutlineNodeData = { kind: string; label: string; dynamic: boolean; line: number };

export type FlowNode =
  | Node<AgentNodeData, "agent">
  | Node<PhaseNodeData, "phase">
  | Node<OutlineNodeData, "outline">;

export function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData, "agent">>) {
  const color = STATUS_COLOR[data.status] ?? "var(--color-ink-300)";
  return (
    <div
      className={clsx(
        "w-[200px] rounded-md border bg-ink-800 px-2 py-1.5 text-left",
        selected ? "border-accent" : "border-ink-600",
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-ink-600" />
      <div className="flex items-center gap-1.5">
        <span
          className={clsx("inline-block size-2 rounded-full", data.status === "running" && "animate-pulse")}
          style={{ background: color }}
        />
        <span className="truncate text-[11px] text-ink-100">{data.label}</span>
        <span className="ml-auto text-[9px] text-ink-300">{fmtTokens(data.tokens)}</span>
      </div>
      {data.model && <div className="truncate text-[9px] text-ink-300">{data.model}</div>}
      {data.preview && <div className="truncate text-[9px] text-ink-300 italic">{data.preview}</div>}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-ink-600" />
    </div>
  );
}

export function PhaseNode({ data }: NodeProps<Node<PhaseNodeData, "phase">>) {
  return (
    <div
      className={clsx(
        "w-[200px] rounded-md border px-2 py-1 text-center",
        data.current ? "border-accent bg-accent/10 text-accent" : "border-ink-600 bg-ink-850 text-ink-300",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-ink-600" />
      <div className="truncate text-[11px]">{data.label}</div>
      <div className="text-[9px] opacity-70">{data.count} agents</div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-ink-600" />
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  phase: "var(--color-accent)",
  agent: "var(--color-ok)",
  parallel: "var(--color-busy)",
  pipeline: "var(--color-busy)",
  workflow: "#a371f7",
  checkpoint: "#db6d28",
};

export function OutlineFlowNode({ data }: NodeProps<Node<OutlineNodeData, "outline">>) {
  const color = KIND_COLOR[data.kind] ?? "var(--color-ink-300)";
  return (
    <div
      className="w-[190px] rounded-md border border-ink-600 bg-ink-800 px-2 py-1"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-ink-600" />
      <div className="flex items-center gap-1.5">
        <span className="text-[10px]" style={{ color }}>
          {data.kind}
        </span>
        <span className="truncate text-[11px] text-ink-100">{data.label}</span>
        <span className="ml-auto text-[9px] text-ink-300">L{data.line}</span>
      </div>
      {data.dynamic && <div className="text-[9px] text-busy">运行期决定</div>}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-ink-600" />
    </div>
  );
}

export const nodeTypes = { agent: AgentNode, phase: PhaseNode, outline: OutlineFlowNode };
