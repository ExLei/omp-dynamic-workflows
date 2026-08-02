import { useReactFlow, useStore } from "@xyflow/react";
import { useEffect } from "react";

/**
 * Re-fit the viewport when the graph's *shape* changes (a phase or agent
 * appears) or its pane is resized — but never when a node's numbers tick.
 * Keyed on a caller-supplied signature so token updates do not yank the view
 * out from under a user who panned somewhere on purpose.
 */
export function AutoFit({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    // Debounced: a pane drag emits a size per frame.
    const timer = setTimeout(() => void fitView({ padding: 0.12, maxZoom: 1, duration: 180 }), 90);
    return () => clearTimeout(timer);
  }, [signature, width, height, fitView]);
  return null;
}
