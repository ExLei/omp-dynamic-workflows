import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

/**
 * Themed wrappers around react-resizable-panels. Every region of the console is
 * a pane in one of these groups, and each group persists its own layout under a
 * stable id so a resize survives a reload.
 */
export function SplitGroup({
  id,
  orientation,
  className,
  children,
}: {
  id: string;
  orientation: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  // Persist only what the user actually dragged: an auto-computed mount layout
  // must not overwrite the declared defaults on a first visit.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `wf-layout:${id}`,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group
      id={id}
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={className ?? "h-full min-h-0 w-full min-w-0"}
    >
      {children}
    </Group>
  );
}

export function SplitPane({
  id,
  children,
  defaultSize,
  minSize,
  className,
}: {
  id: string;
  children: ReactNode;
  defaultSize?: number | string;
  minSize?: number | string;
  className?: string;
}) {
  return (
    <Panel
      id={id}
      defaultSize={defaultSize}
      minSize={minSize}
      className={className ?? "min-h-0 min-w-0"}
      style={{ overflow: "hidden" }}
    >
      {children}
    </Panel>
  );
}

/**
 * The visible grab bar. The library widens the hit target beyond these pixels,
 * so the line can stay hairline-thin without becoming hard to grab.
 */
export function SplitHandle({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const base =
    "relative bg-ink-600 transition-colors data-[separator=hover]:bg-accent data-[separator=drag]:bg-accent data-[separator=focus]:bg-accent";
  return (
    <Separator
      className={
        orientation === "horizontal"
          ? `${base} w-px hover:w-px after:absolute after:inset-y-0 after:-left-1 after:w-2 after:content-['']`
          : `${base} h-px after:absolute after:inset-x-0 after:-top-1 after:h-2 after:content-['']`
      }
    />
  );
}
