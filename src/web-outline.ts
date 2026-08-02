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
 *
 * What it *does* guarantee is topology: siblings are emitted in source order
 * (= execution order for straight-line code), control-flow scopes become
 * explicit container nodes, and the statements a `phase()` marker governs are
 * nested under that phase — the same shape the runtime graph has.
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

/** Tracked calls whose children run concurrently rather than one after another. */
const CONCURRENT = new Set(["parallel", "judgePanel"]);

/** Statements whose body makes the enclosed call count unknowable without running. */
const SCOPE_KIND = new Map<string, { kind: "loop" | "branch"; name: string }>([
  ["ForStatement", { kind: "loop", name: "for" }],
  ["ForOfStatement", { kind: "loop", name: "for…of" }],
  ["ForInStatement", { kind: "loop", name: "for…in" }],
  ["WhileStatement", { kind: "loop", name: "while" }],
  ["DoWhileStatement", { kind: "loop", name: "do…while" }],
  ["IfStatement", { kind: "branch", name: "if" }],
  ["ConditionalExpression", { kind: "branch", name: "?:" }],
  ["SwitchStatement", { kind: "branch", name: "switch" }],
]);

/** How a node's children relate to each other. */
export type OutlineFlow = "sequence" | "parallel";

export interface OutlineNode {
  /** Tracked call name (`phase`, `agent`, …) or a control scope: `loop` / `branch` / `fn`. */
  kind: string;
  /** Phase title / agent label / scope name when statically known. */
  name?: string;
  /** First statically known prompt fragment, for tooltips. */
  detail?: string;
  /** 1-based source line of the call, and of its last line. */
  line: number;
  endLine: number;
  /** True when the call sits inside a loop/branch, or its arguments are computed. */
  dynamic: boolean;
  /** Whether `children` run one after another or all at once. */
  flow: OutlineFlow;
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
  end: number;
  [key: string]: unknown;
}

/** Pre-line-mapping node; `start` also carries the sibling sort key. */
interface Draft {
  kind: string;
  name?: string;
  detail?: string;
  start: number;
  end: number;
  dynamic: boolean;
  flow: OutlineFlow;
  children: Draft[];
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

  const walk = (node: unknown, parent: Draft[], inDynamicScope: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent, inDynamicScope);
      return;
    }
    const ast = node as AstNode;
    if (typeof ast.type !== "string") return;

    if (ast.type === "CallExpression") {
      const callee = ast.callee as AstNode | undefined;
      const name = callee?.type === "Identifier" ? (callee.name as string) : undefined;
      if (name && TRACKED.has(name)) {
        const args = (ast.arguments ?? []) as AstNode[];
        const label = staticLabel(name, args);
        const entry: Draft = {
          kind: name,
          name: label.name,
          detail: label.detail,
          start: ast.start,
          end: ast.end,
          dynamic: inDynamicScope || label.dynamic,
          flow: CONCURRENT.has(name) ? "parallel" : "sequence",
          children: [],
        };
        parent.push(entry);
        if (name === "agent") outline.agentCallSites++;
        if (name === "phase" && label.name) outline.phases.push(label.name);
        if (entry.dynamic) outline.hasDynamicFanout = true;
        for (const arg of args) walk(arg, entry.children, inDynamicScope);
        return;
      }
    }

    // Control flow and named helpers become containers, but only when they
    // actually enclose tracked calls — an unrelated `if` is not orchestration.
    const scope = scopeFor(ast);
    if (scope) {
      const children: Draft[] = [];
      for (const key of childKeys(ast)) walk(ast[key], children, scope.dynamic || inDynamicScope);
      if (children.length > 0) {
        parent.push({
          kind: scope.kind,
          name: scope.name,
          start: ast.start,
          end: ast.end,
          dynamic: scope.dynamic,
          flow: "sequence",
          children,
        });
        if (scope.dynamic) outline.hasDynamicFanout = true;
      }
      return;
    }

    for (const key of childKeys(ast)) walk(ast[key], parent, inDynamicScope);
  };

  const drafts: Draft[] = [];
  walk(program.body, drafts, false);

  const lineAt = lineIndex(script);
  outline.nodes = finalize(drafts, lineAt);
  return outline;
}

function childKeys(ast: AstNode): string[] {
  return Object.keys(ast).filter((key) => key !== "type" && key !== "start" && key !== "end" && key !== "loc");
}

function scopeFor(ast: AstNode): { kind: string; name: string; dynamic: boolean } | undefined {
  const flow = SCOPE_KIND.get(ast.type);
  if (flow) return { ...flow, dynamic: true };
  if (ast.type === "FunctionDeclaration") {
    const id = ast.id as AstNode | undefined;
    const name = id?.type === "Identifier" ? (id.name as string) : "fn";
    // A helper's calls fire wherever it is invoked, which the outline cannot see.
    return { kind: "fn", name: `${name}()`, dynamic: true };
  }
  return undefined;
}

/** Sort each sibling list into execution order, fold phases, and map offsets to lines. */
function finalize(drafts: Draft[], lineAt: (offset: number) => number): OutlineNode[] {
  const ordered = foldPhases([...drafts].sort((a, b) => a.start - b.start));
  return ordered.map((draft) => ({
    kind: draft.kind,
    name: draft.name,
    detail: draft.detail,
    line: lineAt(draft.start),
    endLine: lineAt(draft.end),
    dynamic: draft.dynamic,
    flow: draft.flow,
    children: finalize(draft.children, lineAt),
  }));
}

/**
 * `phase("x")` is a marker, not a container: everything between it and the next
 * marker belongs to that phase at runtime. Re-parent those siblings so the
 * static graph has the same phase→agents shape the live graph has.
 */
function foldPhases(list: Draft[]): Draft[] {
  if (!list.some((draft) => draft.kind === "phase")) return list;
  const out: Draft[] = [];
  let current: Draft | undefined;
  for (const draft of list) {
    if (draft.kind === "phase") {
      current = draft;
      out.push(draft);
    } else if (current) {
      current.children.push(draft);
      current.end = Math.max(current.end, draft.end);
    } else {
      out.push(draft);
    }
  }
  return out;
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
