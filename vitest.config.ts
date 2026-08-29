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
const identityRoot = fileURLToPath(new URL("./packages/identity/src/index.ts", import.meta.url));
const issuesRoot = fileURLToPath(new URL("./packages/issues/src/index.ts", import.meta.url));
const prRoot = fileURLToPath(new URL("./packages/pr/src/index.ts", import.meta.url));
const serverRoot = fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url));
const platformRoot = fileURLToPath(new URL("./packages/platform/src/index.ts", import.meta.url));
const streamFsRoot = fileURLToPath(new URL("./packages/streamfs/src/index.ts", import.meta.url));
const streamFsNodeWorktree = fileURLToPath(
  new URL("./packages/streamfs/src/worktree-node.ts", import.meta.url),
);
const reducersRoot = fileURLToPath(new URL("./packages/reducers/src/index.ts", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("./packages/workspace/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@eforest/protocol/fixtures/reducer", replacement: protocolReducer },
      { find: "@eforest/protocol/offset-allocation", replacement: protocolOffsetAllocation },
      { find: "@eforest/protocol", replacement: protocolRoot },
      { find: "@eforest/client", replacement: clientRoot },
      { find: "@eforest/identity", replacement: identityRoot },
      { find: "@eforest/issues", replacement: issuesRoot },
      { find: "@eforest/pr", replacement: prRoot },
      { find: "@eforest/server", replacement: serverRoot },
      { find: "@eforest/platform", replacement: platformRoot },
      { find: "@eforest/reducers", replacement: reducersRoot },
      { find: "@eforest/streamfs/worktree-node", replacement: streamFsNodeWorktree },
      { find: "@eforest/streamfs", replacement: streamFsRoot },
      { find: "@eforest/workspace", replacement: workspaceRoot },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    // Harness scheduling budgets, NOT product budgets: sized for a heavily
    // contended host (E2-T08 run 2 saw this suite red under the verification
    // workflow's own parallel fan-out at host load 34-58). Every frozen
    // product budget — e.g. the registry's 2000 ms live budget — is still
    // asserted literally inside the tests; these timeouts only decide when a
    // stalled test counts as hung.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
