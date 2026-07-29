#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(ROOT, "tools/verify/canopy_verify.mjs");
const checker = path.join(ROOT, "tools/verify/canopy_sensitivity_spine_check.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eforest-e3-spine-sabotage-"));
try {
  const mutant = path.join(scratch, "canopy_verify.mjs");
  const source = fs.readFileSync(verifier, "utf8");
  const invocation = "    const sensitivityReceipt = sensitivityChecks(EVIDENCE);\n";
  assert.equal(source.split(invocation).length, 2, "sensitivity invocation is not unique");
  fs.writeFileSync(mutant, source.replace(invocation, ""));
  const result = spawnSync(process.execPath, [checker, mutant], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "deleted sensitivity invocation stayed green");
  assert.match(`${result.stdout}${result.stderr}`, /CANOPY_SENSITIVITY_SPINE_MISSING/);
  process.stdout.write("CANOPY_SENSITIVITY_SPINE_SABOTAGE_OK mutation=delete-invocation\n");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
