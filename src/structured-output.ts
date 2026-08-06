import { defineTool, type ToolDefinition } from "./omp-api.js";
import type { Static, TSchema } from "./omp-typebox.js";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
  schema: TSchemaDef;
  capture: StructuredOutputCapture<Static<TSchemaDef>>;
  name?: string;
}

/**
 * Create a schema-validated tool that captures a subagent's structured result.
 * OMP validates `params` against the supplied JSON schema before execution.
 */
export function createStructuredOutputTool<TSchemaDef extends TSchema>({
  schema,
  capture,
  name = "structured_output",
}: StructuredOutputToolOptions<TSchemaDef>): ToolDefinition<TSchemaDef, Static<TSchemaDef>> {
  return defineTool<TSchemaDef, Static<TSchemaDef>>({
    name,
    label: "Structured Output",
    description: "返回本次子代理任务的最终机器可读结果。",
    promptSnippet: "返回最终的结构化机器可读输出",
    promptGuidelines: [
      `${name} 是本次任务的最终答案通道；任务完成时恰好调用一次 ${name}。`,
      `调用 ${name} 之后不要再写散文式最终回答。`,
    ],
    parameters: schema,
    async execute(_toolCallId, params) {
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
      };
    },
  });
}
