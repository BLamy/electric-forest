import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { eforestContent } from "./eforest-content.plugin.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Docstream and the editor ship compiled ESM from 1.5.0 on; keep the automatic JSX
  // runtime for any dependency that still ships TSX so no chunk needs a global `React`.
  esbuild: { jsx: "automatic" },
  // Tailwind v4 compiles `src/styles/app.css`: the owned registry blocks and every app
  // surface are listed there with explicit `@source` roots (the entry uses source(none)).
  plugins: [tailwindcss(), eforestContent({ root: repoRoot })],
  resolve: {
    // No package aliases: the app and @brett_lamy/ui@2.0.0 import the same single
    // @brett_lamy/docstream@1.5.0 / @brett_lamy/docstream-editor@1.5.0 copies through
    // their published `exports` (`/editor`, `/convert`, `/streamdown`, `/gitbook`).
    alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
  },
  server: {
    // The public site renders the repository's own markdown (`docs/`, `ROADMAP.md`,
    // `.eforest/`), which lives above the app root.
    fs: { allow: [repoRoot] },
  },
  build: {
    // Replay Chromium resolves an external source map through its debugger
    // process, outside the authenticated page request. Keep the mapping in the
    // recorded bundle so logout cannot cancel a pending `.map` fetch and turn
    // an otherwise clean session into requestfailed telemetry.
    sourcemap: "inline",
    rollupOptions: {
      // Docstream's playground imports @agent-wasm/core lazily; its worker asset does not
      // bundle. Leave it external — the app never renders live previews, and if one is
      // attempted Docstream reports the missing runtime instead of breaking the page.
      external: ["@agent-wasm/core"],
      output: {
        // Keep source locations in the inline map without embedding every
        // dependency's full source text in the eagerly loaded shell asset.
        sourcemapExcludeSources: true,
      },
    },
  },
});
