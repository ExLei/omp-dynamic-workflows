import { Background, BackgroundVariant, ReactFlow, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import type { OutlineNode, WorkflowOutline } from "../lib/types";
import { type FlowNode, nodeTypes } from "./flow/nodes";

const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 58;

/**
 * Design-time view of the script's tracked call sites. Advisory by construction:
 * anything the analyzer could not resolve statically is flagged `dynamic`, and
 * the runtime graph remains the source of truth.
 */
function buildGraph(outline: WorkflowOutline): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  let row = 0;

  const walk = (list: OutlineNode[], depth: number, parentId?: string): void => {
    list.forEach((node, index) => {
      const id = `${depth}-${index}-${node.line}-${node.kind}`;
      nodes.push({
        id,
        type: "outline",
        position: { x: depth * COLUMN_WIDTH, y: row * ROW_HEIGHT },
        data: {
          kind: node.kind,
          label: node.name ?? node.detail ?? "",
          dynamic: node.dynamic,
          line: node.line,
        },
      });
      row++;
      if (parentId) {
        edges.push({
          id: `e:${parentId}->${id}`,
          source: parentId,
          target: id,
          style: { stroke: node.dynamic ? "var(--color-busy)" : "var(--color-ink-600)" },
          strokeDasharray: node.dynamic ? "4 3" : undefined,
        } as Edge);
      }
      walk(node.children, depth + 1, id);
    });
  };
  walk(outline.nodes, 0);
  return { nodes, edges };
}

export function OutlineFlow({ outline }: { outline: WorkflowOutline }) {
  const { nodes, edges } = useMemo(() => buildGraph(outline), [outline]);
  if (nodes.length === 0) {
    return <div className="p-3 text-xs text-ink-300">脚本中没有可静态识别的编排调用</div>;
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222c36" />
    </ReactFlow>
  );
}
