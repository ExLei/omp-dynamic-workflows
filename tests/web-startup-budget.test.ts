/**
 * Startup-cost guard for the web console.
 *
 * The plugin pays ~1.4s if any module on omp's blocking extension-load path
 * statically imports `@oh-my-pi/pi-coding-agent` as a runtime value (see
 * src/omp-host.ts), and the extension entry deliberately imports per-module
 * instead of through the barrel so the navigator and other on-demand UI stay out
 * of that graph.
 *
 * The console is on by default, so it now sits one dynamic `import()` away from
 * that path. These are structural assertions, not timings: they fail
 * deterministically the moment an import would reintroduce the cost, instead of
 * flaking on a slow machine.
 *
 * Bun's transpiler is the oracle — it erases type-only imports exactly the way
 * the runtime does, so whatever it reports is what actually gets evaluated.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWebConsoleConfig } from "../src/workflow-settings.js";

const ROOT = join(import.meta.dir, "..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Specifiers this module evaluates at load time; type-only imports are erased. */
function runtimeImports(relativePath: string): string[] {
  const { imports } = transpiler.scan(readFileSync(join(ROOT, relativePath), "utf8"));
  return imports.filter((entry) => entry.kind === "import-statement").map((entry) => entry.path);
}

function dynamicImports(relativePath: string): string[] {
  const { imports } = transpiler.scan(readFileSync(join(ROOT, relativePath), "utf8"));
  return imports.filter((entry) => entry.kind === "dynamic-import").map((entry) => entry.path);
}

describe("web console startup budget", () => {
  test("the extension entry reaches the web server only through a dynamic import", () => {
    // A static import would move Bun.serve and the whole server module onto the
    // blocking path whether or not the console is enabled.
    expect(runtimeImports("extensions/workflow.ts")).not.toContain("../src/web-server.js");
    expect(dynamicImports("extensions/workflow.ts")).toContain("../src/web-server.js");
    // ...and it must not be awaited: session_start runs before the first paint.
    expect(readFileSync(join(ROOT, "extensions/workflow.ts"), "utf8")).toMatch(
      /void import\(["']\.\.\/src\/web-server\.js["']\)/,
    );
  });

  test("the web server evaluates nothing that is not already on the plugin's path", () => {
    // Node builtins are free; every other entry is a module the extension already
    // loads through WorkflowManager or the built-in commands.
    const allowed = new Set([
      "node:crypto",
      "node:fs",
      "node:path",
      "node:url",
      "./builtin-workflows.js",
      "./web-outline.js",
      "./workflow.js",
      "./workflow-saved.js",
    ]);
    const unexpected = runtimeImports("src/web-server.ts").filter((path) => !allowed.has(path));
    expect(unexpected).toEqual([]);
  });

  test("no web module evaluates the host package", () => {
    for (const file of ["src/web-server.ts", "src/web-outline.ts"]) {
      const host = runtimeImports(file).filter((path) => path.startsWith("@oh-my-pi/"));
      expect({ file, host }).toEqual({ file, host: [] });
    }
  });

  test("the static outline analyzer stays on acorn alone", () => {
    expect(runtimeImports("src/web-outline.ts")).toEqual(["acorn"]);
  });

  test("the browser opener is dynamic and depends only on node builtins", () => {
    // `/workflows web` is rare; its opener must not be evaluated at load time.
    expect(runtimeImports("src/workflow-commands.ts")).not.toContain("./web-open.js");
    expect(dynamicImports("src/workflow-commands.ts")).toContain("./web-open.js");
    expect(runtimeImports("src/web-open.ts")).toEqual(["node:child_process", "node:util"]);
  });
});

describe("web console launch decision", () => {
  const noEnv = {};

  test("defaults to on with an ephemeral port and no auto-open", () => {
    expect(resolveWebConsoleConfig({}, noEnv)).toEqual({ enabled: true, port: 0, announce: true, open: false });
  });

  test("settings can turn it off, pin a port, silence the notice, and auto-open", () => {
    expect(resolveWebConsoleConfig({ web: { enabled: false } }, noEnv).enabled).toBe(false);
    expect(resolveWebConsoleConfig({ web: { port: 7800 } }, noEnv).port).toBe(7800);
    expect(resolveWebConsoleConfig({ web: { announce: false } }, noEnv).announce).toBe(false);
    expect(resolveWebConsoleConfig({ web: { open: true } }, noEnv).open).toBe(true);
  });

  test("the env override beats settings in both directions", () => {
    // Off in settings, forced on for this launch.
    expect(resolveWebConsoleConfig({ web: { enabled: false } }, { OMP_WORKFLOW_WEB: "1" }).enabled).toBe(true);
    // On by default, forced off for this launch.
    for (const flag of ["0", "false", "off", "OFF"]) {
      expect(resolveWebConsoleConfig({}, { OMP_WORKFLOW_WEB: flag }).enabled).toBe(false);
    }
  });

  test("a numeric override pins the port; a non-numeric one only enables", () => {
    expect(resolveWebConsoleConfig({}, { OMP_WORKFLOW_WEB: "7799" })).toEqual({
      enabled: true,
      port: 7799,
      announce: true,
      open: false,
    });
    // "1" is the enable flag, never port 1.
    expect(resolveWebConsoleConfig({}, { OMP_WORKFLOW_WEB: "1" }).port).toBe(0);
    expect(resolveWebConsoleConfig({ web: { port: 7801 } }, { OMP_WORKFLOW_WEB: "yes" })).toEqual({
      enabled: true,
      port: 7801,
      announce: true,
      open: false,
    });
    expect(resolveWebConsoleConfig({}, { OMP_WORKFLOW_WEB: "99999" }).port).toBe(0);
  });
});
