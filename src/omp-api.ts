export * from "@oh-my-pi/pi-coding-agent";
export { parseFrontmatter } from "@oh-my-pi/pi-utils/frontmatter";
export { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

import type { ToolDefinition as NativeToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { Static as NativeStatic, TSchema } from "@oh-my-pi/pi-ai";

/** OMP-native coding tools available to restricted workflow subagents. */
export const OMP_CODING_TOOL_NAMES = ["read", "bash", "edit", "glob", "grep", "write"] as const;

type ToolParams<TParams extends TSchema> = TParams extends { readonly static: infer T }
  ? T
  : NativeStatic<TParams>;
type NativeExecute<TParams extends TSchema, TDetails> = NativeToolDefinition<TParams, TDetails>["execute"];

export type ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> = Omit<
  NativeToolDefinition<TParams, TDetails>,
  "execute"
> & {
  execute(
    toolCallId: string,
    params: ToolParams<TParams>,
    signal: Parameters<NativeExecute<TParams, TDetails>>[2],
    onUpdate: Parameters<NativeExecute<TParams, TDetails>>[3],
    ctx: Parameters<NativeExecute<TParams, TDetails>>[4],
  ): ReturnType<NativeExecute<TParams, TDetails>>;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  prepareArguments?: (params: ToolParams<TParams>) => ToolParams<TParams>;
};

/**
 * Translate Pi-only prompt/argument hooks into OMP's native tool contract.
 * Extra metadata is retained for the reference implementation's release checks,
 * while OMP receives the same guidance through `description`.
 */
export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  const guidance = tool.promptGuidelines ?? [];
  const description = [tool.description, tool.promptSnippet, ...guidance].filter(Boolean).join("\n\n");
  if (!tool.prepareArguments) return { ...tool, description };

  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    description,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return execute(toolCallId, tool.prepareArguments!(params), signal, onUpdate, ctx);
    },
  };
}
