#!/usr/bin/env node
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "../..");
const {
  authorizeCapability,
  capabilityBaseDigest,
  capabilityForLease,
  capabilityTokenDigest,
  capabilityTokenForFence,
  scanSecrets,
} = await import(join(root, "packages/loop/dist/src/index.js"));

const token = capabilityTokenForFence("basefixture0123456789abcdef", 1);
const lease = {
  v: 1,
  leaseId: "lease-sensitivity",
  org: "maple",
  repo: "reading-room",
  taskId: "E6-T07",
  runId: "run-sensitivity",
  actor: "builder-sensitivity",
  role: "builder",
  branch: {
    stream: "fs:maple/reading-room:e6-t07-run:meta",
    head: "0000000000000000_0000000000000000",
  },
  evidenceStream: "evidence:maple/reading-room/issue/E6-T07",
  queueProofDigest: "a".repeat(64),
  projectOffset: "-1",
  capabilityId: "cap-sensitivity",
  capabilityBaseDigest: capabilityBaseDigest(token),
  capabilityTokenDigest: capabilityTokenDigest(token),
  fence: 1,
  createdAt: 1_000,
};
const capability = capabilityForLease(lease, token);
const state = {
  v: 1,
  stream: "agent-lease:maple/reading-room/E6-T07",
  head: "-1",
  nextFence: 2,
  active: lease,
  lastLeaseId: lease.leaseId,
  terminal: null,
};

const decision = (
  operation,
  target,
  suppliedCapability = capability,
  suppliedLease = lease,
  suppliedState = state,
  suppliedToken = token,
) =>
  authorizeCapability({
    capability: suppliedCapability,
    token: suppliedToken,
    lease: suppliedLease,
    leaseState: suppliedState,
    operation,
    target,
  });

assert.equal(
  decision("branch.write", {
    kind: "branch",
    stream: "fs:maple/reading-room:e6-t07-run:file:README.md",
  }).allowed,
  true,
);
assert.deepEqual(
  decision("branch.write", {
    kind: "branch",
    stream: "fs:maple/reading-room:main:meta",
  }),
  { allowed: false, reason: "capability/foreign-target" },
);
assert.deepEqual(
  decision(
    "branch.write",
    {
      kind: "branch",
      stream: "fs:maple/reading-room:e6-t07-run:file:README.md",
    },
    {
      ...capability,
      role: "critic",
    },
  ),
  { allowed: false, reason: "capability/branch-read-only" },
);
const advancedToken = capabilityTokenForFence(token, 2);
const advancedLease = {
  ...lease,
  fence: 2,
  capabilityTokenDigest: capabilityTokenDigest(advancedToken),
};
assert.deepEqual(
  decision("run.append", { kind: "run", stream: capability.runStream }, capability, advancedLease, {
    ...state,
    nextFence: 3,
    active: advancedLease,
  }),
  { allowed: false, reason: "capability/stale-fence" },
);
assert.ok(scanSecrets("Authorization: Bearer canary-fixture-token").length > 0);
assert.equal(scanSecrets("digest: a".repeat(64)).length, 0);
console.log(
  "E6_T07_SENSITIVITY capability scope, role isolation, stale fences, and canary scan: OK",
);
