import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import { useMemo } from "react";
import type { AgentSnapshot, WorkflowSnapshot } from "../lib/types";
import { useStore } from "../store";
import { AutoFit } from "./flow/AutoFit";
import { AGENT_H, AGENT_W, GAP, PAD_BOTTOM, PAD_TOP, PAD_X, nodeTypes, type FlowNode } from "./flow/nodes";

const COL_GAP = 56;
const PHASE_W = AGENT_W + PAD_X * 2;
const EMPTY_PHASE_H = 64;
const EDGE_STROKE = "#3f4a57";

/**
 * The runtime graph is built from the live snapshot, not from the script: the
 * real agent set only exists once `runWorkflow` has issued the calls (fan-out
 * width can come from args, a loop, or an earlier agent's output). Phases are
 * containers so an agent's membership is visible without tracing an edge.
 */
function buildGraph(snapshot: WorkflowSnapshot, selectedAgentId: number | null): { nodes: FlowNode[]; edges: Edge[] } {
  const phases = [...snapshot.phases];
  const byPhase = new Map<string, AgentSnapshot[]>();
  for (const agent of snapshot.agents) {
    const phase = agent.phase ?? "（无阶段）";
    if (!phases.includes(phase)) phases.push(phase);
    const bucket = byPhase.get(phase);
    if (bucket) bucket.push(agent);
    else byPhase.set(phase, [agent]);
  }

  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  let x = 0;

  phases.forEach((phase, column) => {
    const agents = byPhase.get(phase) ?? [];
    const phaseId = `phase:${phase}`;
    const height =
      agents.length === 0
        ? EMPTY_PHASE_H
        : PAD_TOP + agents.length * AGENT_H + GAP * (agents.length - 1) + PAD_BOTTOM;
    const done = agents.filter((agent) => agent.status === "done").length;

    nodes.push({
      id: phaseId,
      type: "container",
      position: { x, y: 0 },
      style: { width: PHASE_W, height },
      selectable: false,
      draggable: false,
      data: {
        kind: "phase",
        title: phase,
        meta: agents.length ? `${done}/${agents.length}` : "等待",
        active: phase === snapshot.currentPhase,
      },
    });

    if (column > 0) {
      edges.push({
        id: `pe:${column}`,
        source: `phase:${phases[column - 1]}`,
        target: phaseId,
        sourceHandle: "r",
        targetHandle: "l",
        type: "smoothstep",
        animated: phase === snapshot.currentPhase,
        style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STROKE, width: 14, height: 14 },
      } as Edge);
    }

    agents.forEach((agent, row) => {
      nodes.push({
        id: `agent:${agent.id}`,
        type: "agent",
        parentId: phaseId,
        extent: "parent",
        position: { x: PAD_X, y: PAD_TOP + row * (AGENT_H + GAP) },
        style: { width: AGENT_W, height: AGENT_H },
        draggable: false,
        data: {
          agentId: agent.id,
          label: `[${agent.id}] ${agent.label}`,
          status: agent.status,
          model: agent.model,
          tokens: agent.tokenUsage?.total ?? agent.tokens,
          cost: agent.tokenUsage?.cost,
          preview: agent.error ?? agent.resultPreview,
          selected: agent.id === selectedAgentId,
        },
      });
    });

    x += PHASE_W + COL_GAP;
  });

  return { nodes, edges };
}

export function RuntimeFlow({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const selectAgent = useStore((s) => s.selectAgent);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const { nodes, edges } = useMemo(() => buildGraph(snapshot, selectedAgentId), [snapshot, selectedAgentId]);
  // Only phase/agent membership changes the layout; usage ticks must not refit.
  const signature = useMemo(
    () => `${snapshot.phases.join("|")}#${snapshot.agents.map((agent) => `${agent.id}:${agent.phase ?? ""}`).join(",")}`,
    [snapshot.phases, snapshot.agents],
  );

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
        if (node.type === "agent") selectAgent((node.data as { agentId: number }).agentId);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222c36" />
      <Controls showInteractive={false} className="!bottom-2 !left-2" />
      <AutoFit signature={signature} />
    </ReactFlow>
  );
}
