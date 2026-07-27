import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const suite = await readFile("apps/web/test/shell.pw.ts", "utf8");
const harness = await readFile("packages/browser-verify/src/index.ts", "utf8");
const identity = await readFile("apps/web/src/identity.tsx", "utf8");

for (const exported of ["bootWorld", "loginAs", "collectEfRegions"]) {
  assert.match(harness, new RegExp(`export async function ${exported}\\b`));
  assert.match(suite, new RegExp(`\\b${exported}\\b`));
}
assert.doesNotMatch(suite, /\b(?:spawn|execFileSync|createServer)\s*\(/);
assert.doesNotMatch(suite, /\.on\(\s*["']console["']/);
assert.doesNotMatch(suite, /ignoreConsole|allowConsole|silenceConsole|tripwire.*false/i);
for (const attribute of ["data-ef-stream", "data-ef-offset", "data-ef-digest"]) {
  assert.match(identity, new RegExp(attribute));
}
assert.match(suite, /cliDigest\(activeWorld\)/);
assert.match(suite, /partial-triple-sweep/);
assert.match(suite, /console\.error=0 pageerror=0 requestfailed=0 non-loopback=0/);
process.stdout.write("E3_T02_CONTRACT_OK harness=imported tripwire=default-on triple=complete\n");
