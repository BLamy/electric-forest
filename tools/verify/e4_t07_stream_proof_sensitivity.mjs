import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const verifier = join(process.cwd(), "tools/verify/e4_t07_watch_down.mjs");
const environment = { ...process.env, EFOREST_T07_PLANT_APPEND: "1" };
delete environment.EFOREST_EVIDENCE_DIR;
const result = spawnSync(process.execPath, [verifier], {
  cwd: process.cwd(),
  env: environment,
  encoding: "utf8",
});
const output = `${result.stdout}\n${result.stderr}`;
assert.notEqual(result.status, 0, "a planted content append stayed green");
assert.match(output, /changed outside the scripted client append set/);
process.stdout.write("E4-T07 stream-proof append sensitivity: EXPECTED-FAIL OK\n");
