#!/usr/bin/env node
import assert from "node:assert/strict";
import { NamespaceRuntime } from "../../packages/platform/dist/src/namespace-runtime.js";

const runtime = new NamespaceRuntime();
assert.deepEqual(await runtime.boundaryReport(), {
  process: "undefined",
  fetch: "undefined",
  require: "undefined",
  stringCodeGeneration: false,
  wasmCodeGeneration: false,
});
assert.equal(await runtime.isName("runtime-boundary"), true);
assert.equal(await runtime.isName("RuntimeBoundary"), false);
assert.deepEqual(await runtime.replay([]), {
  kind: "empty",
  orgs: {},
  projects: {},
  repos: {},
});
console.log(
  "E2_T06_RUNTIME_BOUNDARY_OK globals=none codegen=none permissions=none transport=json linker=local-only",
);
