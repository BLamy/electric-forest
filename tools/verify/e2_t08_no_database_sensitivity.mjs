#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const [flag, expected] of [
  ["--probe-database-dependency", /better-sqlite3.*storage tell list/],
  ["--probe-out-of-scope-write", /outside every allowed target:.*e3-t02-out-of-scope/],
]) {
  const result = spawnSync(process.execPath, ["tools/verify/e2_t08_no_database.mjs", flag], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${flag} must make the no-database sweep red`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${flag} must name the violation`);
  process.stdout.write(`EXPECTED_RED ${flag}\n`);
}

process.stdout.write("E2_T08_NO_DATABASE_SENSITIVITY_OK probes=2\n");
