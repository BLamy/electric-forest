import type { ReactNode } from "react";
import { TouchKitProvider } from "@brett_lamy/ui";
import { TOUCHKIT_DARK_TOKEN_BRIDGE } from "../mobile/MobileProductShell.js";

/**
 * Desktop host for `@brett_lamy/ui` overlays and controls. The package's tokens are
 * bridged to the Electric Forest token layer exactly as the mobile shell does, so a
 * Credenza, SearchField, or Segmented control reads identically at every width. The
 * host itself is layout-neutral (`display: contents`) and restores text selection that
 * TouchKitProvider disables by default.
 */
export function DesktopTouchKit(props: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <TouchKitProvider
      dark
      tint="var(--accent-primary)"
      className="desktop-touchkit"
      style={TOUCHKIT_DARK_TOKEN_BRIDGE}
    >
      {props.children}
    </TouchKitProvider>
  );
}
