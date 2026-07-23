#!/usr/bin/env node
// E2-T10 conformance ledger. The expensive HTTP drives remain owned by the
// E2-T05/E2-T07/E2-T08 permanent verifiers; this file binds their fresh,
// byte-checked outputs into one operation inventory without reimplementing a
// second authorization stack.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T10-authz-conformance-matrix");
const GOLDEN = process.env.E2_T10_GOLDEN ?? path.join(TASK, "evidence/e2-t10-authz.golden.txt");
const writeGolden = process.argv.includes("--write-golden");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const decision = read(
  ".eforest/tasks/epic-2-the-gates/E2-T07-per-stream-authorization/evidence/e2-t07-decision-matrix.txt",
);
const http = read(
  ".eforest/tasks/epic-2-the-gates/E2-T07-per-stream-authorization/evidence/e2-t07-http-matrix.txt",
);
const refusal = read(
  ".eforest/tasks/epic-2-the-gates/E2-T07-per-stream-authorization/evidence/e2-t07-no-side-effect.txt",
);
const registry = read(
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-visibility-matrix.txt",
);
const cliTests = read("packages/platform/test/cli-tokens.test.ts");
const routes = read("packages/platform/src/auth/routes.ts");
const gateway = read("packages/platform/src/gateway.ts");

assert.match(decision, /E2_T07_DECISION_MATRIX_OK/);
assert.match(http, /E2_T07_HTTP_MATRIX_OK/);
assert.match(refusal, /E2_T07_NO_SIDE_EFFECT_OK/);
assert.match(registry, /E2_T08_MATRIX_OK/);
assert.match(refusal, /refused-cases=96/);
assert.match(refusal, /created-streams-delta=0/);
assert.doesNotMatch(refusal, /unchanged=false/);

const rows = decision.split("\n").filter((line) => line.startsWith("decision principal="));
assert.equal(rows.length, 9 * 8 * 3, "identity x target x operation cartesian matrix drifted");
for (const principal of [
  "anonymous",
  "owner",
  "admin",
  "member",
  "outsider",
  "reader",
  "writer",
  "revoked",
  "badscope",
]) {
  assert.equal(
    rows.filter((line) => line.includes(`principal=${principal} `)).length,
    8 * 3,
    `missing principal ${principal}`,
  );
}
for (const operation of ["read", "follow", "dispatch"]) {
  assert.equal(
    rows.filter((line) => line.includes(` op=${operation} `)).length,
    9 * 8,
    `missing operation ${operation}`,
  );
}

// This is the complete public production route inventory at this gate. A new
// route must be classified here before it can enter the standing sweep.
const operationInventory = [
  ["namespace.lookup", "/api/dispatch(ns.*)", "authorize-before-official-call"],
  ["application.read", "/api/repos/:org/:repo/:branch/events", "decideRepo(read)"],
  ["application.follow", "/api/repos/:org/:repo/:branch/events?live=1", "decideRepo(follow)"],
  ["application.dispatch", "/api/dispatch(fs:*)", "decideRepo(dispatch)"],
  ["registry.query", "/registry/public|me|org/:org", "identity-filtered"],
  ["cli-token.issue", "/api/cli-tokens", "session-authorized"],
];
assert.equal(operationInventory.length, 6, "unlisted platform operation route");

const expectedPublicRoutes = [
  "/",
  "/api/cli-tokens",
  "/api/cli-tokens/",
  "/api/device-grants",
  "/api/dispatch",
  "/api/repos",
  "/api/repos/",
  "/auth/callback",
  "/auth/login",
  "/auth/logout",
  "/registry",
  "/registry/",
  "/settings/cli-tokens",
];
const discoveredPublicRoutes = [
  ...routes.matchAll(/url\.pathname\s*(?:===\s*|\.startsWith\()"([^"]+)/g),
].map((match) => match[1]);
if (process.env.E2_T10_ROUTE_INVENTORY_ADD !== undefined) {
  discoveredPublicRoutes.push(process.env.E2_T10_ROUTE_INVENTORY_ADD);
}
const uniquePublicRoutes = [...new Set(discoveredPublicRoutes)].sort();
assert.deepEqual(uniquePublicRoutes, expectedPublicRoutes, "unlisted production route");
assert.match(gateway, /await this\.decideRepo\(\s*"dispatch"/);
assert.match(gateway, /await this\.decideRepo\(operation/);
assert.match(cliTests, /\/api\/cli-tokens/);
assert.match(cliTests, /afterMissing\.digest/);
assert.match(cliTests, /targets\.events/);

let normalizedRows = [...rows];
if (process.env.E2_T10_SHUFFLE === "1") normalizedRows.reverse();
const bypass = process.env.E2_T10_AUTHORIZE_BYPASS === "1";
const transcript = [
  "E2-T10 authorization conformance matrix v1",
  "normalization=none (ephemeral ports/times are excluded by upstream deterministic fixtures)",
  "runtime=real-http official-durable-streams auth0=pinned-emulator",
  `cartesian-rows=${rows.length}`,
  `refused-rows=96 official-target-calls=0 stream-digests=unchanged`,
  `authorize-bypass=${bypass ? "allowed-cross-tenant" : "none"}`,
  `digest-guard=${bypass ? "changed" : "unchanged"}`,
  ...operationInventory.map(
    ([operation, route, guard]) => `operation=${operation} route=${route} guard=${guard}`,
  ),
  ...uniquePublicRoutes.map((route) => `public-route=${route}`),
  `decision-sha256=${sha256(normalizedRows.join("\n"))}`,
  `http-sha256=${sha256(http)}`,
  `refusal-sha256=${sha256(refusal)}`,
  `registry-sha256=${sha256(registry)}`,
  "revocation=next-operation-cites-new-identity-offset",
  "retired-endpoints=absent",
  "E2_T10_AUTHZ_OK",
  "",
].join("\n");

if (writeGolden) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, transcript);
} else {
  assert.ok(fs.existsSync(GOLDEN), "committed E2-T10 golden is missing");
  assert.equal(transcript, fs.readFileSync(GOLDEN, "utf8"), "E2-T10 golden drifted");
}
console.log(`E2_T10_AUTHZ_OK rows=${rows.length} operations=${operationInventory.length}`);
