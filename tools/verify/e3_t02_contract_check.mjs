import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const suite = await readFile("apps/web/test/shell.pw.ts", "utf8");
const harness = await readFile("packages/browser-verify/src/index.ts", "utf8");
const identity = await readFile("apps/web/src/identity.tsx", "utf8");
const production = await readFile("packages/platform/src/production.ts", "utf8");
const recorder = await readFile("tools/replay/record-e3-t02.sh", "utf8");
const walkthrough = await readFile("tools/replay/e3_t02_walkthrough.js", "utf8");
const finalTelemetry = await readFile("tools/replay/e3_t02_final_telemetry.js", "utf8");
const recorderSensitivity = await readFile("tools/verify/e3_t02_recorder_sensitivity.mjs", "utf8");
const viteConfig = await readFile("apps/web/vite.config.ts", "utf8");

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
for (const failureClass of ["console.error", "pageerror", "requestfailed"]) {
  assert.match(walkthrough, new RegExp(failureClass.replace(".", "\\.")));
  assert.match(recorderSensitivity, new RegExp(failureClass.replace(".", "\\.")));
}
assert.match(walkthrough, /Object\.defineProperty\(page, "__eforestE3T02Telemetry"/);
assert.match(walkthrough, /if \(telemetryState\.failures\.length > 0\)/);
assert.match(walkthrough, /throw new Error\(\s*`recording tripwire/);
assert.match(walkthrough, /source-map requests did not settle/);
assert.match(finalTelemetry, /page\.__eforestE3T02Telemetry/);
assert.match(finalTelemetry, /stableSamples < 2/);
assert.match(finalTelemetry, /telemetryFailures: telemetryState\.failures\.map/);
assert.match(viteConfig, /sourcemap:\s*["']inline["']/);
assert.match(suite, /source-map inline=true external-js-map-assets=0/);
assert.match(
  recorder,
  /e3_t02_playwright_expression\.mjs[\s\S]*run-code --filename "\$walkthrough_expression"/,
);
assert.match(
  recorder,
  /tools\/replay\/e3_t02_publish_guard\.sh[\s\S]*node "\$skill_root\/scripts\/browser-close\.js"/,
);
assert.match(
  recorder,
  /requests >"\$work\/requests\.txt"[\s\S]*run-code --filename "\$final_telemetry_expression"[\s\S]*e3_t02_publish_guard\.sh/,
);
process.stdout.write(
  "E3_T02_CONTRACT_OK harness=production-composition wire=full tripwire=persistent+final-record-guard triple=complete pkce=covered\n",
);
