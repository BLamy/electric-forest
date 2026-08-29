import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Replay Chromium resolves an external source map through its debugger
    // process, outside the authenticated page request. Keep the mapping in the
    // recorded bundle so logout cannot cancel a pending `.map` fetch and turn
    // an otherwise clean session into requestfailed telemetry.
    sourcemap: "inline",
  },
});
