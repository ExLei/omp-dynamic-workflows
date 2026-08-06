import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel as FlowPanel,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import { useMemo } from "react";
import type { OutlineNode, WorkflowOutline } from "../lib/types";
import { useStore } from "../store";
import { AutoFit } from "./flow/AutoFit";
import {
  GAP,
  KIND_COLOR,
  LEAF_H,
  LEAF_W,
  PAD_BOTTOM,
  PAD_TOP,
  PAD_X,
  nodeTypes,
  type FlowNode,
} from "./flow/nodes";

const SEQ_STROKE = "#3f4a57";

interface Sized {
  node: OutlineNode;
  w: number;
  h: number;
  children: Sized[];
}

/** Bottom-up sizing: a container is exactly big enough to hold its stacked children. */
function measure(node: OutlineNode): Sized {
  const children = node.children.map(measure);
  if (children.length === 0) return { node, w: LEAF_W, h: LEAF_H, children };
  const innerW = alignWidths(children);
  const innerH = children.reduce((sum, child) => sum + child.h, 0) + GAP * (children.length - 1);
  return { node, w: innerW + PAD_X * 2, h: PAD_TOP + innerH + PAD_BOTTOM, children };
}

/** Siblings share a width so nested boxes line up instead of ragging. */
function alignWidths(siblings: Sized[]): number {
  const width = Math.max(LEAF_W, ...siblings.map((child) => child.w));
  for (const child of siblings) child.w = width;
  return width;
}

/** The kind chip already names the call, so a nameless node stays blank. */
function label(node: OutlineNode): string {
  return node.name ?? (node.children.length > 0 ? "" : (node.detail ?? "未命名"));
}

/** Count of `agent` call sites anywhere below this node — the phase header's meta. */
function countAgents(node: OutlineNode): number {
  return (
    (node.kind === "agent" ? 1 : 0) + node.children.reduce((sum, child) => sum + countAgents(child), 0)
  );
}

function anyDynamic(node: OutlineNode): boolean {
  return node.dynamic || node.children.some(anyDynamic);
}

/** A container's right-aligned meta: how many agent call sites it holds, and where it starts. */
function containerMeta(node: OutlineNode): string {
  const agents = countAgents(node);
  if (agents === 0) return `行 ${node.line}`;
  return `${anyDynamic(node) ? "≥" : ""}${agents} 个 agent · 行 ${node.line}`;
}

/**
 * Design-time view of the script's tracked call sites. Containment is drawn as
 * nesting, execution order as arrows between siblings — except inside a
 * `parallel` block, whose children carry no ordering. Advisory by construction:
 * anything the analyzer could not resolve statically is dashed and flagged
 * `运行期决定`; the runtime graph remains the source of truth.
 */
function buildGraph(outline: WorkflowOutline): { nodes: FlowNode[]; edges: Edge[] } {
  const roots = outline.nodes.map(measure);
  alignWidths(roots);
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];

  const emit = (siblings: Sized[], parentId: string | undefined, sequential: boolean): void => {
    let y = parentId ? PAD_TOP : 0;
    const x = parentId ? PAD_X : 0;
    let previous: string | undefined;

    siblings.forEach((sized, index) => {
      const { node } = sized;
      const id = parentId ? `${parentId}.${index}` : `n${index}`;
      const container = sized.children.length > 0;
      nodes.push({
        id,
        type: container ? "container" : "outlineLeaf",
        parentId,
        extent: parentId ? "parent" : undefined,
        position: { x, y },
        style: { width: sized.w, height: container ? sized.h : LEAF_H },
        selectable: false,
        draggable: false,
        data: container
          ? {
              kind: node.kind,
              title: label(node),
              meta: containerMeta(node),
              dynamic: node.dynamic,
              line: node.line,
            }
          : {
              kind: node.kind,
              title: label(node),
              // The title already falls back to the prompt snippet; do not print it twice.
              detail: node.detail === label(node) ? undefined : node.detail,
              dynamic: node.dynamic,
              line: node.line,
            },
      } as FlowNode);

      if (sequential && previous) {
        edges.push({
          id: `seq:${previous}->${id}`,
          source: previous,
          target: id,
          sourceHandle: "b",
          targetHandle: "t",
          type: "smoothstep",
          pathOptions: { borderRadius: 8 },
          style: { stroke: SEQ_STROKE, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: SEQ_STROKE, width: 14, height: 14 },
        } as Edge);
      }
      previous = id;
      if (container) emit(sized.children, id, node.flow === "sequence");
      y += sized.h + GAP;
    });
  };

  emit(roots, undefined, true);
  return { nodes, edges };
}

export function OutlineFlow({ outline }: { outline: WorkflowOutline }) {
  const focusOutline = useStore((s) => s.focusOutline);
  const { nodes, edges } = useMemo(() => buildGraph(outline), [outline]);
  // Refit only when the shape changes; typing in an unrelated part of the
  // script re-parses but usually leaves the graph identical.
  const signature = useMemo(
    () => nodes.map((node) => `${node.id}:${node.style?.height ?? 0}`).join(","),
    [nodes],
  );

  if (outline.error) {
    return <div className="p-3 text-[13px] text-bad">无法解析:{outline.error}</div>;
  }
  if (nodes.length === 0) {
    return <div className="p-3 text-[13px] text-ink-300">脚本中没有可静态识别的编排调用</div>;
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.15}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => {
        const line = (node.data as { line?: number }).line;
        if (line) focusOutline(line);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222c36" />
      <AutoFit signature={signature} />
      <Controls showInteractive={false} className="!bottom-2 !left-2" />
      <FlowPanel position="top-right" className="!m-1.5">
        <div className="flex items-center gap-2 rounded border border-ink-600 bg-ink-850/90 px-2 py-1 text-[10px] text-ink-300">
          <span className="flex items-center gap-1">
            <span className="inline-block h-px w-4" style={{ background: SEQ_STROKE }} />
            顺序
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm border" style={{ borderColor: KIND_COLOR.parallel }} />
            并发块
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block size-2 rounded-sm border border-dashed"
              style={{ borderColor: KIND_COLOR.loop }}
            />
            运行期决定
          </span>
          <span>点击节点跳转脚本</span>
        </div>
      </FlowPanel>
    </ReactFlow>
  );
}
