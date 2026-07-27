#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import { bootWorld } from "../../packages/browser-verify/dist/src/index.js";
import { createPlatformProductionRuntime } from "../../packages/platform/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/evidence/e3-t02-production-runtime.txt",
);
const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const streamUrl = await official.start();
const child = spawn(process.execPath, [resolve(root, "packages/platform/dist/src/bin.js")], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    EF_OIDC_ISSUER: "http://127.0.0.1:9",
    EF_OIDC_CLIENT_ID: "e3-t02-production-probe",
    EF_SESSION_SECRET: "e3-t02-production-probe-secret-at-least-32-bytes",
    EF_SESSION_TTL: "60",
    EFOREST_SERVER_URL: streamUrl,
    EF_WEB_ROOT: resolve(root, "apps/web/dist"),
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});
const platformUrl = await new Promise((resolveListening, reject) => {
  let stdout = "";
  const timeout = setTimeout(() => reject(new Error(`platform timeout: ${stderr}`)), 15_000);
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    const match = /LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    if (match?.[1]) {
      clearTimeout(timeout);
      resolveListening(match[1]);
    }
  });
  child.once("exit", (code) => reject(new Error(`platform exited ${String(code)}: ${stderr}`)));
});

try {
  const response = await fetch(`${platformUrl}/`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login");
  assert.equal(await response.text(), "");
  const proof = await fetch(`${platformUrl}/__proof/e3-t02`);
  assert.equal(proof.status, 404);
  assert.deepEqual(await proof.json(), {
    error: { class: "auth-refused", reason: "bad-state" },
  });

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  await assert.rejects(
    bootWorld({ root, fixtureLogin: true }),
    /browser-verify emulator fixtures are forbidden in production/,
  );
  await assert.rejects(
    createPlatformProductionRuntime(
      {
        EF_OIDC_ISSUER: "http://127.0.0.1:9",
        EF_OIDC_CLIENT_ID: "e3-t02-production-probe",
        EF_SESSION_SECRET: "e3-t02-production-probe-secret-at-least-32-bytes",
        EF_SESSION_TTL: "60",
        EFOREST_SERVER_URL: streamUrl,
        EF_WEB_ROOT: resolve(root, "apps/web/dist"),
      },
      { testProofReceipt: async () => ({ forbidden: true }) },
    ),
    /test proof receipt is forbidden in production/,
  );
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;

  const transcript =
    "E3-T02 production topology proof\n" +
    "entrypoint=packages/platform/dist/src/bin.js\n" +
    "composition=createPlatformProductionRuntime\n" +
    "config=EF_WEB_ROOT absolute apps/web/dist\n" +
    "unauthenticated-root status=302 location=/auth/login body-bytes=0\n" +
    "test-proof-route production-status=404 env-config=absent runtime-option=refused\n" +
    "fixture-production=one-click-refused-before-emulator-or-seed\n" +
    "E3_T02_PRODUCTION_OK\n";
  await mkdir(resolve(evidence, ".."), { recursive: true });
  await writeFile(evidence, transcript);
  process.stdout.write(transcript);
} finally {
  child.kill("SIGTERM");
  await official.stop();
}
