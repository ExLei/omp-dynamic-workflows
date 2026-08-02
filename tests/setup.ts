/**
 * Test preload: bind the host runtime that omp normally injects on
 * `ExtensionAPI` (see src/omp-host.ts) and warm the lazily loaded host subpath
 * modules, so tests can call the synchronous code paths directly.
 */

import * as pi from "@oh-my-pi/pi-coding-agent";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { installHostRuntime } from "../src/omp-host.js";
import { warmFrontmatter, warmSchemaValidator } from "../src/omp-lazy.js";

installHostRuntime({ pi, typebox } as unknown as Parameters<typeof installHostRuntime>[0]);
await Promise.all([warmFrontmatter(), warmSchemaValidator()]);
