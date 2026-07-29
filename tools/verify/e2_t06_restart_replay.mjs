#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  composeNamespaceView,
  namespaceViewDigest,
  resolvePath,
} from "../../packages/platform/dist/src/index.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const dump = JSON.parse(input);
assert.ok(Array.isArray(dump.rootEvents), "raw replay requires rootEvents");
assert.ok(dump.orgStreams !== null && typeof dump.orgStreams === "object");
const state = composeNamespaceView(dump.rootEvents, dump.orgStreams);
process.stdout.write(
  JSON.stringify({
    digest: namespaceViewDigest(state),
    org: resolvePath(state, "acme"),
    repo: resolvePath(state, "acme/forest"),
    branch: resolvePath(state, "acme/forest/main"),
  }),
);
