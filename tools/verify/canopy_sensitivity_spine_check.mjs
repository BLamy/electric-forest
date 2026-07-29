#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.resolve(process.argv[2] ?? path.join(ROOT, "tools/verify/canopy_verify.mjs"));
const text = fs.readFileSync(source, "utf8");
const required = [
  "const sensitivityReceipt = sensitivityChecks(EVIDENCE);",
  "assert.equal(sensitivityReceipt, SENSITIVITY_RECEIPT);",
  "process.stdout.write(`${sensitivityReceipt}\\n`);",
  'const SENSITIVITY_RECEIPT = "E3_T01_SENSITIVITY_STAGE_OK cases=9";',
];
const missing = required.filter((marker) => text.split(marker).length !== 2);
if (missing.length > 0) {
  process.stderr.write(
    `CANOPY_SENSITIVITY_SPINE_MISSING source=${source} markers=${JSON.stringify(missing)}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("CANOPY_SENSITIVITY_SPINE_OK\n");
}
