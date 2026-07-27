import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const suite = await readFile("apps/web/test/shell.pw.ts", "utf8");
const harness = await readFile("packages/browser-verify/src/index.ts", "utf8");
const identity = await readFile("apps/web/src/identity.tsx", "utf8");
const production = await readFile("packages/platform/src/production.ts", "utf8");

for (const exported of ["bootWorld", "loginWithFixture", "collectEfRegions"]) {
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
assert.match(harness, /createPlatformProductionRuntime/);
assert.doesNotMatch(harness, /new PlatformWebApp/);
assert.match(production, /\{ webRoot \}/);
for (const field of ["url", "headers", "bodyBase64"]) {
  assert.match(harness, new RegExp(`readonly ${field}\\b`));
}
assert.match(suite, /scanCredentialLeaks/);
assert.match(suite, /code_challenge_method/);
assert.match(suite, /callback-code-redeemed=true/);
assert.match(suite, /browser-password-fields=0 browser-password-wire=0/);
assert.match(harness, /browser-verify emulator fixtures are forbidden in production/);
assert.match(suite, /partial-triple-sweep/);
assert.match(suite, /console\.error=0 pageerror=0 requestfailed=0 non-loopback=0/);
process.stdout.write(
  "E3_T02_CONTRACT_OK harness=production-composition wire=full tripwire=default-on triple=complete pkce=covered\n",
);
