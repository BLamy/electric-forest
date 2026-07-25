#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readPlatformEnvironment } from "../../packages/platform/dist/src/index.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.ok(separator > 0, `invalid deployment environment line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const deployment = parseEnvironment(
  await readFile(resolve(root, "deploy/platform.production.env.example"), "utf8"),
);
const config = readPlatformEnvironment(deployment);
const issuer = new URL(config.EF_OIDC_ISSUER);
const streams = new URL(config.EFOREST_SERVER_URL);
assert.equal(issuer.protocol, "https:");
assert.match(issuer.hostname, /auth0\.com$/);
assert.equal(streams.protocol, "https:");
assert.match(streams.hostname, /electric\.run$/);
assert.ok(!["127.0.0.1", "localhost", "::1"].includes(issuer.hostname));
assert.ok(!["127.0.0.1", "localhost", "::1"].includes(streams.hostname));

const [
  production,
  platformBin,
  official,
  serverBoundary,
  platformPackage,
  clientPackage,
  serverPackage,
] = await Promise.all([
  readFile(resolve(root, "packages/platform/src/production.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/src/bin.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/src/official.ts"), "utf8"),
  readFile(resolve(root, "packages/server/src/upstream.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/package.json"), "utf8"),
  readFile(resolve(root, "packages/client/package.json"), "utf8"),
  readFile(resolve(root, "packages/server/package.json"), "utf8"),
]);
assert.match(platformBin, /createPlatformProductionRuntime\(\)/);
assert.match(production, /new OfficialStreamAdapter\(\{ baseUrl: config\.EFOREST_SERVER_URL \}\)/);
assert.match(production, /issuer: config\.EF_OIDC_ISSUER/);
assert.doesNotMatch(production, /NODE_ENV|emulat|localhost|127\.0\.0\.1/);
assert.match(official, /@eforest\/client/);
assert.match(serverBoundary, /DurableStreamTestServer.*@durable-streams\/server/s);
assert.doesNotMatch(platformPackage, /@durable-streams\/server/);
assert.match(clientPackage, /"@durable-streams\/client": "\^0\.2\.6"/);
assert.match(serverPackage, /"@durable-streams\/server": "\^0\.3\.7"/);

const productPaths = ["packages/platform/src", "packages/client/src", "packages/server/src"];
const emulatorSearch = await run("git", [
  "grep",
  "-n",
  "-E",
  "vendor/emulate|@emulators/auth0",
  "--",
  ...productPaths,
]).catch((error) => error);
assert.equal(emulatorSearch.code, 1, String(emulatorSearch.stdout ?? emulatorSearch.stderr ?? ""));
process.stdout.write(
  `E2_T12_PORTABILITY_OK entrypoint=packages/platform/src/bin.ts composition=createPlatformProductionRuntime auth0=${issuer.origin} streams=${streams.origin} client=@durable-streams/client@^0.2.6 local-server=@durable-streams/server@^0.3.7 code-path-divergence=0 emulator-product-imports=0 custom-platform-transport=0\n`,
);
