#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { URLSearchParams } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "vendor/emulate/packages/emulate/dist/index.js");
const port = 45470;
const origin = `http://127.0.0.1:${port}`;
const callbackUrl = "http://127.0.0.1:45471/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const work = await mkdtemp(join(tmpdir(), "e2-t02-cli-"));
const seedPath = join(work, "auth0-seed.json");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator/evidence/e2-t02-cli.txt",
);

const privateJwk = JSON.parse(
  await readFile(
    resolve(
      root,
      "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.private.jwk.json",
    ),
    "utf8",
  ),
);
const publicJwk = JSON.parse(
  await readFile(
    resolve(root, "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.public.jwk.json"),
    "utf8",
  ),
);
const privatePem = createPrivateKey({ key: privateJwk, format: "jwk" })
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicPem = createPublicKey({ key: publicJwk, format: "jwk" })
  .export({ format: "pem", type: "spki" })
  .toString();

await writeFile(
  seedPath,
  `${JSON.stringify(
    {
      auth0: {
        users: [
          {
            email: "cli@example.test",
            password: "CliTest1234!",
            user_id: "cli-user",
            name: "CLI User",
            email_verified: true,
          },
        ],
        oauth_clients: [
          {
            client_id: "cli-client",
            client_secret: "cli-secret",
            redirect_uris: [callbackUrl],
            grant_types: ["authorization_code"],
            audience: "eforest-api",
          },
        ],
        signing_key: {
          private_key_pem: privatePem,
          public_key_pem: publicPem,
          kid: "eforest-test-2026",
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const childEnv = {
  ...process.env,
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "127.0.0.1,localhost,::1",
  http_proxy: "http://127.0.0.1:1",
  https_proxy: "http://127.0.0.1:1",
  no_proxy: "127.0.0.1,localhost,::1",
};

function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitUntilReady(processRun) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processRun.child.exitCode !== null) {
      const output = processRun.output();
      throw new Error(
        `CLI exited before ready (${processRun.child.exitCode})\n${output.stderr}${output.stdout}`,
      );
    }
    try {
      const response = await fetch(`${origin}/.well-known/openid-configuration`);
      if (response.status === 200) return;
    } catch {
      // The process has not bound its loopback listener yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("CLI did not become ready");
}

async function stop(processRun) {
  if (processRun.child.exitCode !== null) return;
  processRun.child.kill("SIGTERM");
  await new Promise((resolveExit, reject) => {
    processRun.child.once("exit", resolveExit);
    processRun.child.once("error", reject);
  });
}

async function deterministicRun() {
  const processRun = launch([
    "start",
    "--service",
    "auth0",
    "--port",
    String(port),
    "--base-url",
    origin,
    "--seed",
    seedPath,
    "--now",
    "1700000000",
    "--seed-material",
    "e2-t02-cli-seed",
  ]);
  try {
    await waitUntilReady(processRun);
    const authorization = await fetch(`${origin}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: "cli-client",
        client_secret: "cli-secret",
        redirect_uri: callbackUrl,
        scope: "openid profile email",
        audience: "eforest-api",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "cli-state&=%",
        nonce: "cli-nonce",
        email: "cli@example.test",
        password: "CliTest1234!",
      }),
    });
    assert.equal(authorization.status, 302);
    const location = new URL(authorization.headers.get("location"));
    assert.equal(location.searchParams.get("state"), "cli-state&=%");
    const code = location.searchParams.get("code");
    assert(code);
    const token = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "cli-client",
        client_secret: "cli-secret",
        redirect_uri: callbackUrl,
        code,
        code_verifier: verifier,
      }),
    });
    assert.equal(token.status, 200);
    const body = await token.json();
    return {
      code,
      access_token: body.access_token,
      id_token: body.id_token,
      token_type: body.token_type,
    };
  } finally {
    await stop(processRun);
  }
}

try {
  const first = await deterministicRun();
  const second = await deterministicRun();
  assert.deepEqual(second, first, "CLI flags did not produce byte-identical OAuth output");

  const invalid = launch([
    "start",
    "--service",
    "auth0",
    "--port",
    String(port),
    "--now",
    "not-an-integer",
  ]);
  const invalidExit = await new Promise((resolveExit, reject) => {
    invalid.child.once("exit", (code) => resolveExit(code));
    invalid.child.once("error", reject);
  });
  assert.equal(invalidExit, 1);
  assert.match(invalid.output().stderr, /Invalid Unix time: not-an-integer/);

  const evidence = [
    "cli_process_boundary=OK",
    "runs=2",
    "byte_identical=true",
    `authorization_code=${first.code}`,
    `access_token_sha256=${createHash("sha256").update(first.access_token).digest("hex")}`,
    `id_token_sha256=${createHash("sha256").update(first.id_token).digest("hex")}`,
    `token_type=${first.token_type}`,
    "invalid_now_exit=1",
    "invalid_now_message=Invalid Unix time: not-an-integer",
  ].join("\n");
  await writeFile(evidencePath, `${evidence}\n`, "utf8");
  console.log(evidence);
} finally {
  await rm(work, { recursive: true, force: true });
}
