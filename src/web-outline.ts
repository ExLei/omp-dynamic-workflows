/**
 * Best-effort *static* outline of a workflow script, for the web editor's
 * design-time graph.
 *
 * This is deliberately advisory. The real agent graph is dynamic: `runWorkflow`
 * numbers agents by runtime call sequence, and fan-out width routinely comes
 * from `args`, a loop, or a previous agent's output (see src/workflow.ts —
 * acorn is otherwise only used there to read `export const meta`). Anything this
 * outline cannot resolve is reported as `dynamic`, so the UI can show "N agents,
 * width unknown until run" instead of pretending a fixed DAG exists.
 */

import { parse } from "acorn";

/** Runtime globals worth drawing. Mirrors WORKFLOW_CAPABILITY_CONTRACT's call surface. */
const TRACKED = new Set([
  "phase",
  "agent",
  "parallel",
  "pipeline",
  "workflow",
  "checkpoint",
  "verify",
  "judgePanel",
  "loopUntilDry",
  "completenessCheck",
  "retry",
  "gate",
]);

/** Nodes whose body makes the enclosed call count unknowable without running. */
const DYNAMIC_SCOPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
  "IfStatement",
  "ConditionalExpression",
  "SwitchStatement",
]);

export interface OutlineNode {
  kind: string;
  /** Phase title / agent label when statically known. */
  name?: string;
  /** First statically known prompt fragment, for tooltips. */
  detail?: string;
  line: number;
  /** True when the call sits inside a loop/branch, or its arguments are computed. */
  dynamic: boolean;
  children: OutlineNode[];
}

export interface WorkflowOutline {
  nodes: OutlineNode[];
  /** Statically visible phase titles, in source order. */
  phases: string[];
  /** Lower bound: statically visible `agent()` call sites, not runtime agents. */
  agentCallSites: number;
  /** True when any tracked call is inside a loop/branch or takes computed args. */
  hasDynamicFanout: boolean;
  error?: string;
}

interface AstNode {
  type: string;
  start: number;
  [key: string]: unknown;
}

export function outlineWorkflowScript(script: string): WorkflowOutline {
  const outline: WorkflowOutline = { nodes: [], phases: [], agentCallSites: 0, hasDynamicFanout: false };
  let program: AstNode;
  try {
    program = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (error) {
    outline.error = error instanceof Error ? error.message : String(error);
    return outline;
  }

  const lineAt = lineIndex(script);

  const walk = (node: unknown, parent: OutlineNode[], inDynamicScope: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent, inDynamicScope);
      return;
    }
    const ast = node as AstNode;
    if (typeof ast.type !== "string") return;

    const dynamicScope = inDynamicScope || DYNAMIC_SCOPES.has(ast.type);

    if (ast.type === "CallExpression") {
      const callee = ast.callee as AstNode | undefined;
      const name = callee?.type === "Identifier" ? (callee.name as string) : undefined;
      if (name && TRACKED.has(name)) {
        const args = (ast.arguments ?? []) as AstNode[];
        const label = staticLabel(name, args);
        const entry: OutlineNode = {
          kind: name,
          name: label.name,
          detail: label.detail,
          line: lineAt(ast.start),
          dynamic: dynamicScope || label.dynamic,
          children: [],
        };
        parent.push(entry);
        if (name === "agent") outline.agentCallSites++;
        if (name === "phase" && label.name) outline.phases.push(label.name);
        if (entry.dynamic) outline.hasDynamicFanout = true;
        for (const arg of args) walk(arg, entry.children, dynamicScope);
        return;
      }
    }

    for (const key of Object.keys(ast)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      walk(ast[key], parent, dynamicScope);
    }
  };

  walk(program.body, outline.nodes, false);
  return outline;
}

function staticLabel(
  fn: string,
  args: AstNode[],
): { name?: string; detail?: string; dynamic: boolean } {
  const first = args[0];
  if (fn === "phase" || fn === "workflow") {
    const literal = stringLiteral(first);
    return { name: literal, dynamic: literal === undefined };
  }
  const options = args[1];
  const label = objectStringProp(options, "label");
  const prompt = stringLiteral(first);
  return {
    name: label,
    detail: prompt?.slice(0, 120),
    // A computed prompt is normal and fine; an unlabeled agent inside a
    // computed expression is what makes the node count unknowable.
    dynamic: label === undefined && prompt === undefined,
  };
}

function stringLiteral(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as Array<{ value: { cooked?: string } }> | undefined;
    const expressions = node.expressions as unknown[] | undefined;
    if (quasis && (expressions?.length ?? 0) === 0) return quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return undefined;
}

function objectStringProp(node: AstNode | undefined, key: string): string | undefined {
  if (!node || node.type !== "ObjectExpression") return undefined;
  const properties = node.properties as AstNode[] | undefined;
  for (const property of properties ?? []) {
    if (property.type !== "Property") continue;
    const propKey = property.key as AstNode;
    const name = propKey.type === "Identifier" ? (propKey.name as string) : stringLiteral(propKey);
    if (name === key) return stringLiteral(property.value as AstNode);
  }
  return undefined;
}

/** Byte offset -> 1-based line, via one prefix scan. */
function lineIndex(source: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
