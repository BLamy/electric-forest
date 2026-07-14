import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const protocolRoot = fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url));
const protocolReducer = fileURLToPath(
  new URL("./packages/protocol/fixtures/reducer.ts", import.meta.url),
);
const protocolOffsetAllocation = fileURLToPath(
  new URL("./packages/protocol/src/offset-allocation.ts", import.meta.url),
);
const clientRoot = fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url));
const serverRoot = fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@eforest/protocol/fixtures/reducer", replacement: protocolReducer },
      { find: "@eforest/protocol/offset-allocation", replacement: protocolOffsetAllocation },
      { find: "@eforest/protocol", replacement: protocolRoot },
      { find: "@eforest/client", replacement: clientRoot },
      { find: "@eforest/server", replacement: serverRoot },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
