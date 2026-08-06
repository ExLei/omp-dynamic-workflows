/**
 * Task 10 (syncMode 兜底): workflow tool execute 的 backgroundDefault 三态——
 * settings/options 的 syncMode 强制同步（always）、强制后台（never），缺省 auto
 * 维持 isAcpOrHeadlessSession 现状判定（hasUI true → 后台、false → 同步）。
 *
 * 用最小 fake manager + fake storage 驱动真实 createWorkflowTool().execute，
 * 只观察 execute 选择 startInBackground（后台）还是 runSync（同步）分支——脚本
 * 实际执行、进度帧节流属 WorkflowManager / acp-bridge 既有测试覆盖范围，此处
 * 不引入。settings 走 tests/setup.ts 注入的确定性测试 home（homedir override →
 * 全局文件为 <testHome>/.omp/workflows/settings.json）：saveWorkflowSettings 写
 * 全局文件后，execute 内 loadWorkflowSettings({ cwd }) 读回；cwd 用独立 tmp
 * 目录，杜绝项目覆盖文件的干扰。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { getWorkflowSettingsPath, saveWorkflowSettings } from "../src/workflow-settings.js";

const SCRIPT = `export const meta = { name: "sync_probe", description: "d", phases: [{ title: "work" }] };
await phase("work");
return await agent("go", { label: "w" });
`;

/** Minimal result the fake runSync returns — must satisfy the sync branch's reads. */
const SYNC_RESULT = {
  agentCount: 1,
  result: "ok",
  durationMs: 0,
  runId: "sync-run-1",
  meta: { name: "sync_probe" },
  phases: [],
  logs: [],
  tokenUsage: undefined,
};

interface FakeManager {
  manager: never;
  /** args of every startInBackground call (empty ⇒ never took the background branch). */
  startedBackground: unknown[][];
  /** args of every runSync call (empty ⇒ never took the sync branch). */
  ranSync: unknown[][];
}

function makeFakeManager(): FakeManager {
  const startedBackground: unknown[][] = [];
  const ranSync: unknown[][] = [];
  const manager = {
    startInBackground: (...args: unknown[]) => {
      startedBackground.push(args);
      return { runId: "bg-run-1" };
    },
    runSync: async (...args: unknown[]) => {
      ranSync.push(args);
      return SYNC_RESULT;
    },
    resume: async () => null,
  };
  return { manager: manager as never, startedBackground, ranSync };
}

/** Drive one workflow execute with a fresh tmp cwd + fake manager. */
async function runExecute(
  fake: FakeManager,
  ctx: { hasUI?: boolean },
  toolOptions: Record<string, unknown> = {},
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "omp-sync-mode-"));
  try {
    const tool = createWorkflowTool({
      cwd,
      manager: fake.manager,
      storage: { load: () => undefined },
      ...toolOptions,
    } as never);
    await tool.execute("call-1", { script: SCRIPT } as never, undefined, undefined, ctx as never);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

afterEach(() => {
  // 全局 settings 文件按测试逐个重建（saveWorkflowSettings 会 merge 既有内容），
  // 清理后每例从空文件出发，避免跨例污染。
  rmSync(getWorkflowSettingsPath(), { force: true });
});

describe("workflow tool backgroundDefault with syncMode", () => {
  test("auto (absent): TUI-like ctx (hasUI true) defaults to background", async () => {
    const fake = makeFakeManager();
    await runExecute(fake, { hasUI: true });
    expect(fake.startedBackground).toHaveLength(1);
    expect(fake.ranSync).toHaveLength(0);
  });

  test("auto (absent): headless ctx (hasUI false) defaults to sync", async () => {
    const fake = makeFakeManager();
    await runExecute(fake, { hasUI: false });
    expect(fake.ranSync).toHaveLength(1);
    expect(fake.startedBackground).toHaveLength(0);
  });

  test("settings syncMode always forces sync even when ctx.hasUI is true (V1 ACP 场景)", async () => {
    saveWorkflowSettings({ syncMode: "always" });
    const fake = makeFakeManager();
    await runExecute(fake, { hasUI: true });
    expect(fake.ranSync).toHaveLength(1);
    expect(fake.startedBackground).toHaveLength(0);
  });

  test("settings syncMode never forces background even in a headless ctx", async () => {
    saveWorkflowSettings({ syncMode: "never" });
    const fake = makeFakeManager();
    await runExecute(fake, { hasUI: false });
    expect(fake.startedBackground).toHaveLength(1);
    expect(fake.ranSync).toHaveLength(0);
  });

  test("options.syncMode beats settings (options 优先)", async () => {
    saveWorkflowSettings({ syncMode: "never" });
    const fake = makeFakeManager();
    await runExecute(fake, { hasUI: true }, { syncMode: "always" });
    expect(fake.ranSync).toHaveLength(1);
    expect(fake.startedBackground).toHaveLength(0);
  });

  test("explicit background param still beats syncMode (最高优先)", async () => {
    saveWorkflowSettings({ syncMode: "always" });
    const cwd = mkdtempSync(join(tmpdir(), "omp-sync-mode-bg-"));
    try {
      const fake = makeFakeManager();
      const tool = createWorkflowTool({
        cwd,
        manager: fake.manager,
        storage: { load: () => undefined },
      } as never);
      await tool.execute("call-1", { script: SCRIPT, background: true } as never, undefined, undefined, {
        hasUI: false,
      } as never);
      expect(fake.startedBackground).toHaveLength(1);
      expect(fake.ranSync).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
