/**
 * `/workflows-models` command registration.
 *
 * The implementation lives in workflows-models-ui.ts and is imported on first
 * invocation: it pulls in the pi-tui component tree, which costs real time to
 * evaluate inside omp's extension loader and is not needed to register a
 * command that most sessions never run.
 */

import type { ExtensionAPI } from "./omp-api.js";

export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "查看并编辑工作流使用的模型档位（small/medium/big）",
    handler: async (_args, ctx) => {
      const { runWorkflowModelsCommand } = await import("./workflows-models-ui.js");
      await runWorkflowModelsCommand(ctx);
    },
  });
}
