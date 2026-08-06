import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverExtensionPaths, loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { workflowAgentIdentity } from "../src/agent.js";
import { defineTool } from "../src/omp-api.js";
import { Type } from "../src/omp-typebox.js";
import { runWorkflow } from "../src/workflow.js";
import { workflowHomeDir, workflowProjectPaths } from "../src/workflow-paths.js";
import { openWorkflowNavigator } from "../src/workflow-ui.js";

const ROOT = join(import.meta.dir, "..");

describe("OMP plugin contract", () => {
  test("manifest exposes the native extension and bundled skills", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    expect(manifest.pi).toBeUndefined();
    expect(manifest.omp).toEqual({
      extensions: ["extensions/workflow.ts"],
      skills: ["skills/workflow-authoring", "skills/workflow-patterns"],
    });
  });

  test("OMP discovers the package manifest and registers the workflow surface", async () => {
    const paths = await discoverExtensionPaths([ROOT], ROOT, undefined, { ambient: false });
    expect(paths).toEqual([join(ROOT, "extensions/workflow.ts")]);
    const loaded = await loadExtensions(paths, ROOT);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);

    const extension = loaded.extensions[0]!;
    expect([...extension.tools.keys()]).toEqual(["workflow", "workflow_control"]);
    expect([...extension.commands.keys()]).toEqual(
      expect.arrayContaining(["workflows", "workflows-models", "deep-research", "code-review", "effort"]),
    );
    expect(extension.tools.get("workflow")?.definition.description).toContain("仅当用户显式选择使用工作流时才调用它");
  });

  test("Pi-only tool hooks are translated into OMP description and execution", async () => {
    let received: unknown;
    const tool = defineTool({
      name: "adapter_probe",
      label: "Adapter probe",
      description: "Base description",
      promptSnippet: "Short prompt",
      promptGuidelines: ["Required guidance"],
      parameters: Type.Object({ value: Type.Number() }),
      prepareArguments: (params) => ({ value: Number(params.value) }),
      async execute(_id, params) {
        received = params;
        return { content: [{ type: "text", text: "ok" }], details: params };
      },
    });

    await tool.execute("call", { value: "7" } as never, undefined, undefined, {} as never);
    expect(tool.description).toBe("Base description\n\nShort prompt\n\nRequired guidance");
    expect(received).toEqual({ value: 7 });
  });

  test("parallel workflow execution preserves result order", async () => {
    const calls: string[] = [];
    const result = await runWorkflow(
      `export const meta = { name: "omp_parallel", description: "parallel contract" }
const values = await parallel(["alpha", "beta"].map(label => () => agent("work:" + label, { label })))
return values`,
      {
        agent: {
          async run(prompt, options) {
            calls.push(prompt);
            return `done:${options?.label}`;
          },
        },
        persistLogs: false,
      },
    );

    expect(calls).toEqual(["work:alpha", "work:beta"]);
    expect(result.agentCount).toBe(2);
    expect(result.result).toEqual(["done:alpha", "done:beta"]);
  });

  test("all workflow state paths use the .omp namespace", () => {
    const paths = workflowProjectPaths(ROOT);
    expect(workflowHomeDir()).toContain(`${join(".omp", "workflows")}`);
    expect(paths.runsDir).toContain(`${join(".omp", "workflows")}`);
    // Project-scoped saved workflows live inside the project, not the home namespace.
    expect(paths.projectSavedDir).toBe(join(ROOT, ".omp", "workflows", "saved"));
    expect(paths.homeSavedDir).toContain(`${join(".omp", "workflows")}`);
    // Runs are machine-local only: never written into the project tree.
    expect(paths.runsDir).toContain(join(".omp", "workflows", "projects"));
    expect(paths.runsDir.startsWith(ROOT)).toBe(false);
  });

  test("every subagent gets its own registry identity, never the host's Main slot", () => {
    // createAgentSession derives its registry id as agentId ?? parentTaskPrefix
    // ?? "Main", and registering an id evicts the previous holder — so two
    // concurrent subagents sharing "Main" made the loser throw
    // `Agent "Main" was replaced during session initialization.`
    const ids = [
      workflowAgentIdentity("recon-A"),
      workflowAgentIdentity("recon-A"),
      workflowAgentIdentity("judge · small"),
      workflowAgentIdentity(),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).not.toBe("Main");
      expect(id).toMatch(/^wf-[\w.-]+$/);
    }
  });

  test("workflow navigator uses the host-provided theme without SDK singleton state", async () => {
    const boxSharp = {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
      teeDown: "┬",
      teeUp: "┴",
      teeLeft: "┤",
      teeRight: "├",
      cross: "┼",
    };
    const theme = {
      nav: { cursor: "›" },
      boxRound: {
        topLeft: "╭",
        topRight: "╮",
        bottomLeft: "╰",
        bottomRight: "╯",
        horizontal: "─",
        vertical: "│",
      },
      boxSharp,
      md: { quoteBorder: "│", hrChar: "─", colorSwatch: "■" },
      getSymbolPreset: () => "unicode",
      getSpinnerFrames: () => ["-", "\\", "|", "/"],
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      strikethrough: (text: string) => text,
      underline: (text: string) => text,
    };
    const manager = {
      listRuns: () => [],
      getRun: () => undefined,
      on() {},
      off() {},
    };
    let rendered: string[] = [];
    const ui = {
      custom(
        factory: (
          tui: never,
          theme: never,
          keybindings: never,
          done: (result: undefined) => void,
        ) => { render(width: number): string[]; dispose?(): void },
      ): Promise<void> {
        const component = factory(
          { requestRender() {}, terminal: { rows: 30 } } as never,
          theme as never,
          {} as never,
          () => {},
        );
        rendered = component.render(80);
        component.dispose?.();
        return Promise.resolve();
      },
      notify() {},
    };

    await openWorkflowNavigator({} as never, manager as never, ui as never);
    expect(rendered.length).toBeGreaterThan(2);
    expect(rendered[0]).toContain("workflows");
  });
});
