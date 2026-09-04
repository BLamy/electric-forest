import type { CSSProperties } from "react";

/** Bridge the shared TouchKit controls to the product's dark token layer. */
export const TOUCHKIT_DARK_TOKEN_BRIDGE = {
  "--tk-bg": "var(--surface-canvas)",
  "--tk-bg2": "var(--surface-subtle)",
  "--tk-card": "var(--surface-raised)",
  "--tk-label": "var(--content-primary)",
  "--tk-label2": "var(--content-secondary)",
  "--tk-label3": "var(--content-tertiary)",
  "--tk-sep": "var(--border-subtle)",
  "--tk-fill": "var(--control-fill)",
  "--tk-fill2": "var(--control-fill-strong)",
  "--tk-bar": "var(--surface-chrome-translucent)",
  "--tk-press": "var(--control-fill-strong)",
  "--tk-stick": "var(--surface-sticky-translucent)",
  "--tk-side": "var(--surface-sidebar)",
  "--tk-red": "var(--status-danger)",
  "--tk-green": "var(--status-success)",
  "--tk-scrim": "var(--overlay-scrim)",
  "--tk-tint": "var(--accent-primary)",
} as CSSProperties;
