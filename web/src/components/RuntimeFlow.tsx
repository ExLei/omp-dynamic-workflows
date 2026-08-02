import { Background, BackgroundVariant, ReactFlow, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import type { WorkflowSnapshot } from "../lib/types";
import { useStore } from "../store";
import { type FlowNode, nodeTypes } from "./flow/nodes";

const COLUMN_WIDTH = 250;
const ROW_HEIGHT = 74;

/**
 * The runtime graph is built from the live snapshot, not from the script: the
 * real agent set only exists once `runWorkflow` has issued the calls (fan-out
 * width can come from args, a loop, or an earlier agent's output).
 */
function buildGraph(snapshot: WorkflowSnapshot): { nodes: FlowNode[]; edges: Edge[] } {
  const phases = [...snapshot.phases];
  const byPhase = new Map<string, typeof snapshot.agents>();
  for (const agent of snapshot.agents) {
    const phase = agent.phase ?? "(no phase)";
    if (!phases.includes(phase)) phases.push(phase);
    const bucket = byPhase.get(phase);
    if (bucket) bucket.push(agent);
    else byPhase.set(phase, [agent]);
  }

  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  phases.forEach((phase, column) => {
    const agents = byPhase.get(phase) ?? [];
    const phaseId = `phase:${phase}`;
    nodes.push({
      id: phaseId,
      type: "phase",
      position: { x: column * COLUMN_WIDTH, y: 0 },
      data: { label: phase, current: phase === snapshot.currentPhase, count: agents.length },
    });
    if (column > 0) {
      edges.push({
        id: `pe:${column}`,
        source: `phase:${phases[column - 1]}`,
        target: phaseId,
        animated: phase === snapshot.currentPhase,
        style: { stroke: "var(--color-ink-600)" },
      });
    }
    agents.forEach((agent, row) => {
      const id = `agent:${agent.id}`;
      nodes.push({
        id,
        type: "agent",
        position: { x: column * COLUMN_WIDTH, y: 80 + row * ROW_HEIGHT },
        data: {
          agentId: agent.id,
          label: `[${agent.id}] ${agent.label}`,
          status: agent.status,
          model: agent.model,
          tokens: agent.tokenUsage?.total ?? agent.tokens,
          preview: agent.error ?? agent.resultPreview,
        },
      });
      edges.push({
        id: `ae:${agent.id}`,
        source: phaseId,
        target: id,
        animated: agent.status === "running",
        style: { stroke: agent.status === "running" ? "var(--color-busy)" : "var(--color-ink-600)" },
      });
    });
  });
  return { nodes, edges };
}

export function RuntimeFlow({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const selectAgent = useStore((s) => s.selectAgent);
  const { nodes, edges } = useMemo(() => buildGraph(snapshot), [snapshot]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_event, node) => {
        if (node.type === "agent") selectAgent((node.data as { agentId: number }).agentId);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222c36" />
    </ReactFlow>
  );
}
