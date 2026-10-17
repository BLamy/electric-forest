import { TanStackDevtools } from "@tanstack/react-devtools";
import { useSyncExternalStore, type ReactNode } from "react";

/** The frame's compact breakpoint (ChatShell `breakpoint={880}`). */
const COMPACT = "(max-width: 879px)";

function subscribeCompact(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useCompact(): boolean {
  return useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT).matches,
    () => false,
  );
}

/**
 * Stream diagnostics live in the TanStack Devtools panel, not the page layout.
 *
 * The devtools shell only mounts a plugin while its panel is open, but the identity and
 * proof regions are evidence surfaces: harnesses read their data-ef-* triples on load. So
 * the same diagnostics also render into a visually-hidden anchor that stays in the DOM and
 * the accessibility tree (no aria-hidden: refusals keep role="alert").
 */
export function StreamDevtools(props: {
  readonly diagnostics: ReactNode;
  readonly inspector?: ReactNode;
}): React.JSX.Element {
  // The trigger sits on the workspace rail's empty mid-left edge, clear of the composer and
  // the page chrome. On compact widths every edge covers content, so the trigger is hidden
  // there (the panel still opens with the devtools hotkey; the anchor below stays mounted).
  const compact = useCompact();
  return (
    <>
      <div className="sr-only" data-testid="stream-diagnostics-anchor">
        {props.diagnostics}
      </div>
      <TanStackDevtools
        config={{
          position: "middle-left",
          triggerMode: "fixed",
          triggerHidden: compact,
          theme: "dark",
        }}
        plugins={[
          {
            id: "eforest-stream-diagnostics",
            name: "Stream diagnostics",
            defaultOpen: true,
            render: (
              <div className="grid gap-3 p-3 text-[12px]">
                {props.diagnostics}
                {props.inspector}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
