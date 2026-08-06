import type { ExtensionContext } from "./omp-api.js";
import type { WorkflowSnapshot } from "./display.js";

/**
 * ACP 会话（或任何无 TUI 的 headless 会话）检测。TUI 模式 hasUI=true；
 * ACP 的 ExtensionUIContext 无组件面，hasUI=false。缺省视为无 UI（headless 安全默认）。
 *
 * 参数取 `Partial<Pick<...>>`（hasUI 可选）：调用侧拿到的 ctx 常是弱化形状
 * （workflow-tool 的 uiCtx 把 hasUI 声明为可选），且「缺省视为无 UI」本身
 * 就要求函数能接受没有 hasUI 字段的对象。
 */
export function isAcpOrHeadlessSession(ctx: Partial<Pick<ExtensionContext, "hasUI">> | undefined): boolean {
  return ctx?.hasUI !== true;
}

/**
 * 进度帧：结构化 ASCII 流程图，ACP 客户端 tool 面板内滚动可见。
 * 快照的 phases 为标题字符串数组（见 display.ts `WorkflowSnapshot.phases`）。
 * 阶段图标/next 以真实快照字段 currentPhase 为准（workflow-manager 的 onPhase
 * 实时写入，见 workflow-manager.ts），tokens 读 tokenUsage.total——不依赖快照上
 * 不存在的扩展字段（phaseIndex/tokenTotal）。
 */
export function renderProgressFrame(snapshot: WorkflowSnapshot): string {
  const phases = snapshot.phases ?? [];
  const currentIndex = snapshot.currentPhase === undefined ? -1 : phases.indexOf(snapshot.currentPhase);
  const lines = [`Workflow: ${snapshot.name} · run ${snapshot.runId ?? "-"}`];
  phases.forEach((title, i) => {
    const agents = snapshot.agents.filter((a) => a.phase === title);
    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const skipped = agents.filter((a) => a.status === "skipped").length;
    const icon = currentIndex < 0 ? "⏳" : i < currentIndex ? "✓" : i === currentIndex ? "◐" : "⏳";
    let line = `${icon} Phase ${i + 1}/${phases.length}: ${title}`;
    if (agents.length > 0) {
      line += `  ▸ ${done}/${agents.length} agents`;
      if (running > 0) line += ` · ${running} running`;
      if (errors > 0) line += ` · ${errors} errors`;
      if (skipped > 0) line += ` · ${skipped} skipped`;
    }
    if (i === currentIndex && phases[i + 1]) line += `  · next: ${phases[i + 1]}`;
    lines.push(line);
  });
  if (snapshot.tokenUsage?.total) lines.push(`Tokens: ${(snapshot.tokenUsage.total / 1000).toFixed(1)}k`);
  return lines.join("\n");
}

/** 节流发射器：可调用（emit 当前帧），且带 cancel() 清除未触发的 pending 尾帧。 */
export type ThrottledFrameEmitter = (() => void) & { cancel(): void };

/**
 * 1s 节流包装：ACP 进度帧每秒至多一帧，避免消息风暴。
 * 窗口内被抑制的调用在窗口结束后补发一次（trailing edge），保证最后状态不丢。
 * cancel() 清除 pending 定时器：运行结束后（完成/中止路径）必须先 cancel 再发终帧，
 * 否则残留的 trailing 定时器会在结束后越界补发一帧。
 */
export function throttleFrames(emit: () => void, intervalMs = 1000): ThrottledFrameEmitter {
  let last = 0;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const throttled = () => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      emit();
      return;
    }
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!pending) return;
      pending = false;
      last = Date.now();
      emit();
    }, intervalMs - (now - last));
  };
  throttled.cancel = () => {
    pending = false;
    clearTimeout(timer);
  };
  return throttled;
}
