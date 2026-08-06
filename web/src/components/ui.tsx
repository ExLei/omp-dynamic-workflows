import clsx from "clsx";
import type { ReactNode } from "react";
import type { AgentStatus, RunStatus } from "../lib/types";

export const STATUS_COLOR: Record<string, string> = {
  running: "var(--color-busy)",
  pending: "var(--color-ink-300)",
  queued: "var(--color-ink-300)",
  skipped: "var(--color-ink-300)",
  paused: "var(--color-accent)",
  done: "var(--color-ok)",
  completed: "var(--color-ok)",
  error: "var(--color-bad)",
  failed: "var(--color-bad)",
  aborted: "var(--color-bad)",
};

export const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  pending: "等待中",
  queued: "排队中",
  skipped: "已跳过",
  paused: "已暂停",
  done: "已完成",
  completed: "已完成",
  error: "错误",
  failed: "失败",
  aborted: "已中止",
};

export function statusLabel(status: string | undefined): string {
  return status ? (STATUS_LABEL[status] ?? status) : "—";
}

export function locationLabel(location: string): string {
  return location === "project" ? "项目级" : "个人级";
}

export function StatusDot({ status, pulse }: { status: AgentStatus | RunStatus | string; pulse?: boolean }) {
  return (
    <span
      className={clsx("inline-block size-2 shrink-0 rounded-full", pulse && status === "running" && "animate-pulse")}
      style={{ background: STATUS_COLOR[status] ?? "var(--color-ink-300)" }}
    />
  );
}

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-ink-600 bg-ink-800 px-3 py-1.5">
        <h2 className="text-[11px] tracking-[0.12em] text-ink-300 uppercase">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "rounded border px-2 py-1 text-[13px] transition-colors",
        "disabled:cursor-default disabled:opacity-35",
        tone === "primary"
          ? "border-accent/60 bg-accent/10 text-accent hover:enabled:bg-accent/20"
          : tone === "danger"
            ? "border-bad/50 text-bad hover:enabled:bg-bad/10"
            : "border-ink-600 bg-ink-700 text-ink-100 hover:enabled:border-accent hover:enabled:text-accent",
      )}
    >
      {children}
    </button>
  );
}

export function fmtTokens(value: number | undefined): string {
  if (!value) return "0";
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function fmtCost(cost: number | undefined): string {
  if (!cost) return "";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function fmtElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
