import { TanStackDevtools } from "@tanstack/react-devtools";
import type { ReactNode } from "react";

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
  return (
    <>
      <div className="stream-diagnostics-anchor" data-testid="stream-diagnostics-anchor">
        {props.diagnostics}
      </div>
      <TanStackDevtools
        config={{ position: "bottom-right", theme: "dark" }}
        plugins={[
          {
            id: "eforest-stream-diagnostics",
            name: "Stream diagnostics",
            defaultOpen: true,
            render: (
              <div className="stream-devtools-panel">
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
