import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import { fmtCost, fmtTokens, STATUS_COLOR } from "../ui";

/** Shared geometry: the flow builders lay nodes out manually, so sizes are fixed. */
export const LEAF_W = 216;
export const LEAF_H = 46;
export const AGENT_W = 232;
export const AGENT_H = 58;
/** Container insets: header strip on top, uniform padding elsewhere. */
export const PAD_X = 12;
export const PAD_TOP = 32;
export const PAD_BOTTOM = 12;
export const GAP = 12;

/** Chinese chip labels for the analyzer's node kinds. */
export const KIND_LABEL: Record<string, string> = {
  phase: "阶段",
  agent: "调用",
  parallel: "并发",
  judgePanel: "并发",
  pipeline: "串行",
  workflow: "工作流",
  verify: "验证",
  loopUntilDry: "循环至收敛",
  completenessCheck: "完整性检查",
  retry: "重试",
  gate: "门控",
  checkpoint: "检查点",
  loop: "循环",
  branch: "条件",
  fn: "辅助",
};

export type ContainerNodeData = {
  kind: string;
  title: string;
  /** Right-aligned meta, e.g. `行 91` or `3 个 agent`. */
  meta?: string;
  dynamic?: boolean;
  active?: boolean;
  line?: number;
};

export type OutlineLeafData = {
  kind: string;
  title: string;
  detail?: string;
  dynamic: boolean;
  line: number;
};

export type AgentNodeData = {
  agentId: number;
  label: string;
  status: string;
  model?: string;
  tokens?: number;
  cost?: number;
  preview?: string;
  selected?: boolean;
};

export type FlowNode =
  | Node<ContainerNodeData, "container">
  | Node<OutlineLeafData, "outlineLeaf">
  | Node<AgentNodeData, "agent">;

export const KIND_COLOR: Record<string, string> = {
  phase: "var(--color-accent)",
  agent: "var(--color-ok)",
  parallel: "var(--color-busy)",
  pipeline: "#a371f7",
  workflow: "#a371f7",
  checkpoint: "#db6d28",
  loop: "#db6d28",
  branch: "#db6d28",
  fn: "#8b949e",
};

/** Four anchors so sequence edges can run vertically and containment horizontally. */
function Anchors() {
  const style = { width: 5, height: 5, background: "var(--color-ink-600)", border: "none" } as const;
  return (
    <>
      <Handle id="t" type="target" position={Position.Top} style={{ ...style, opacity: 0 }} />
      <Handle id="l" type="target" position={Position.Left} style={{ ...style, opacity: 0 }} />
      <Handle id="b" type="source" position={Position.Bottom} style={{ ...style, opacity: 0 }} />
      <Handle id="r" type="source" position={Position.Right} style={{ ...style, opacity: 0 }} />
    </>
  );
}

/**
 * A box that visually encloses its children (React Flow renders child nodes on
 * top of it). Used for phases, `parallel`/`pipeline` blocks and control scopes.
 */
export function ContainerNode({ data }: NodeProps<Node<ContainerNodeData, "container">>) {
  const color = KIND_COLOR[data.kind] ?? "var(--color-ink-300)";
  return (
    <div
      className={clsx(
        "h-full w-full rounded-lg border bg-ink-850/40",
        data.active && "shadow-[0_0_0_1px_var(--color-accent)]",
      )}
      style={{
        borderColor: data.active ? "var(--color-accent)" : color,
        borderStyle: data.dynamic ? "dashed" : "solid",
      }}
    >
      <Anchors />
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[11px]">
        <span className="rounded-sm px-1 py-px" style={{ background: `${color}22`, color }}>
          {KIND_LABEL[data.kind] ?? data.kind}
        </span>
        <span className="truncate font-mono text-[12px] text-ink-100">{data.title}</span>
        {data.meta && <span className="ml-auto shrink-0 font-mono text-ink-300">{data.meta}</span>}
      </div>
    </div>
  );
}

/** A tracked call with no tracked calls inside it. */
export function OutlineLeafNode({ data }: NodeProps<Node<OutlineLeafData, "outlineLeaf">>) {
  const color = KIND_COLOR[data.kind] ?? "var(--color-ink-300)";
  return (
    <div
      className="h-full w-full overflow-hidden rounded-md border bg-ink-800 px-2 py-1"
      style={{ borderColor: "var(--color-ink-600)", borderLeft: `3px solid ${color}` }}
    >
      <Anchors />
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px]" style={{ color }}>
          {KIND_LABEL[data.kind] ?? data.kind}
        </span>
        <span className="truncate font-mono text-[12px] text-ink-100">{data.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-300">行 {data.line}</span>
      </div>
      <div className={clsx("truncate text-[10px]", data.dynamic ? "text-busy" : "text-ink-300")}>
        {data.dynamic ? "运行期决定" : (data.detail ?? "")}
      </div>
    </div>
  );
}

export function AgentNode({ data }: NodeProps<Node<AgentNodeData, "agent">>) {
  const color = STATUS_COLOR[data.status] ?? "var(--color-ink-300)";
  return (
    <div
      className={clsx(
        "h-full w-full cursor-pointer overflow-hidden rounded-md border bg-ink-800 px-2 py-1 transition-colors",
        data.selected ? "border-accent bg-ink-700" : "border-ink-600 hover:border-accent/60",
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Anchors />
      <div className="flex items-center gap-1.5">
        <span
          className={clsx("inline-block size-2 shrink-0 rounded-full", data.status === "running" && "animate-pulse")}
          style={{ background: color }}
        />
        <span className="truncate font-mono text-[12px] text-ink-100">{data.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-300">{fmtTokens(data.tokens)}</span>
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-300">
        <span className="truncate">{data.model ?? "—"}</span>
        {data.cost ? <span className="ml-auto shrink-0">{fmtCost(data.cost)}</span> : null}
      </div>
      <div className="truncate text-[10px] text-ink-300 italic">{data.preview ?? ""}</div>
    </div>
  );
}

export const nodeTypes = { container: ContainerNode, outlineLeaf: OutlineLeafNode, agent: AgentNode };
