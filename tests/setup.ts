/**
 * Test preload: bind the host runtime that omp normally injects on
 * `ExtensionAPI` (see src/omp-host.ts) and warm the lazily loaded host subpath
 * modules, so tests can call the synchronous code paths directly.
 */

import * as pi from "@oh-my-pi/pi-coding-agent";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostRuntime } from "../src/omp-host.js";
import { warmFrontmatter, warmSchemaValidator } from "../src/omp-lazy.js";
import { setHomedirForTests } from "../src/workflow-paths.js";

// 确定性目录 + 自愈式清理：每次运行先清后建，不依赖进程退出钩子
// （bun test 工作进程不触发 process.on("exit")）
const testHome = join(tmpdir(), "omp-test-home");
rmSync(testHome, { recursive: true, force: true });
mkdirSync(testHome, { recursive: true });
setHomedirForTests(testHome);

installHostRuntime({ pi, typebox } as unknown as Parameters<typeof installHostRuntime>[0]);
await Promise.all([warmFrontmatter(), warmSchemaValidator()]);
