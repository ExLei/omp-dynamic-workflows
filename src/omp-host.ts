/**
 * Host runtime access without importing `@oh-my-pi/pi-coding-agent`.
 *
 * Why this exists: under omp's extension loader every *static* import of a
 * `@oh-my-pi/*` package is remapped to the host's bundled copy and re-evaluated
 * for this extension's module graph. Measured on the omp binary, a single
 * `import ... from "@oh-my-pi/pi-coding-agent"` costs ~1.4s of `loadExtensions`
 * time — paid synchronously before the TUI paints, on every launch, whether or
 * not a workflow is ever run.
 *
 * omp already hands the extension factory the fully-evaluated host namespace on
 * `ExtensionAPI.pi` (plus the TypeBox shim on `ExtensionAPI.typebox`). Reading
 * them from there costs nothing. So the package is imported for *types only*
 * (erased at runtime) and every runtime value goes through `host()` /
 * `hostTypeBox()` below.
 *
 * The single install point is the extension entry (`extensions/workflow.ts`),
 * which calls `installHostRuntime(pi)` before touching anything else. Tests
 * install the real modules from `tests/setup.ts`.
 */

import type { ExtensionAPI } from "./omp-api.js";

/** The `@oh-my-pi/pi-coding-agent` namespace, as injected by omp. */
export type HostNamespace = ExtensionAPI["pi"];
/** The Zod-backed TypeBox shim, as injected by omp. */
export type HostTypeBox = ExtensionAPI["typebox"];

let hostNamespace: HostNamespace | undefined;
let hostTypeBoxModule: HostTypeBox | undefined;

/**
 * Bind the host runtime for this process. Idempotent; a later call replaces the
 * binding, which is what an extension `/reload` needs (omp invalidates the old
 * ExtensionAPI before loading the next generation).
 */
export function installHostRuntime(api: Pick<ExtensionAPI, "pi" | "typebox">): void {
  hostNamespace = api.pi;
  hostTypeBoxModule = api.typebox;
}

/** True once `installHostRuntime` has run. */
export function isHostRuntimeInstalled(): boolean {
  return hostNamespace !== undefined;
}

function missing(what: string): never {
  throw new Error(
    `omp-dynamic-workflows: ${what} was used before installHostRuntime(api) ran. ` +
      "The extension entry must install the host runtime first (tests: preload tests/setup.ts).",
  );
}

/** The host `@oh-my-pi/pi-coding-agent` namespace. */
export function host(): HostNamespace {
  return hostNamespace ?? missing("the host namespace");
}

/** The host TypeBox compatibility shim. */
export function hostTypeBox(): HostTypeBox {
  return hostTypeBoxModule ?? missing("the host TypeBox shim");
}
