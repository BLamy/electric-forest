import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { eforestContent } from "./eforest-content.plugin.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Published source packages such as Docstream ship TSX directly. Compile
  // those dependencies with the same automatic JSX runtime as this app so a
  // route chunk never depends on an ambient global `React` binding.
  esbuild: { jsx: "automatic" },
  plugins: [eforestContent({ root: repoRoot })],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // Only the editor component: the package root also re-exports demo editors
      // that pull Docstream's playground (and its @agent-wasm worker) into the
      // bundle. Exact match so `@brett_lamy/docstream-editor/styles.css` still resolves.
      {
        find: /^@brett_lamy\/docstream-editor\/convert$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/@brett_lamy/docstream-editor/src/editor/convert.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@brett_lamy\/docstream-editor$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/@brett_lamy/docstream-editor/src/editor/Editor.tsx",
            import.meta.url,
          ),
        ),
      },
    ],
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
      // The editor's live JSX code blocks load Docstream's playground, which imports
      // @agent-wasm/core lazily; its worker asset does not bundle. Leave it external (as
      // the editor's own demo does) — the app never renders live previews, and if one is
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
