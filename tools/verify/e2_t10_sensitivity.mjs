#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(ROOT, "tools/verify/e2_t10_authz.mjs");
const golden = path.join(
  ROOT,
  ".eforest/tasks/epic-2-the-gates/E2-T10-authz-conformance-matrix/evidence/e2-t10-authz.golden.txt",
);

function expectRed(name, env) {
  const result = spawnSync(process.execPath, [verifier], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, `${name} unexpectedly stayed green`);
  console.log(`EXPECTED_RED ${name}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2-t10-golden-"));
try {
  const corrupt = path.join(scratch, "corrupt.golden.txt");
  const bytes = Buffer.from(fs.readFileSync(golden));
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(corrupt, bytes);
  expectRed("one-byte-golden-corruption", { E2_T10_GOLDEN: corrupt });
  expectRed("authorize-cross-tenant-bypass", { E2_T10_AUTHORIZE_BYPASS: "1" });
  expectRed("unlisted-platform-route", { E2_T10_ROUTE_INVENTORY_ADD: "new.route" });
  expectRed("semantic-order-shuffle", { E2_T10_SHUFFLE: "1" });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("E2_T10_SENSITIVITY_OK attacks=4");
