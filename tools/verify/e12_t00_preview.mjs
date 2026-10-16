#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { URLSearchParams } from "node:url";
import { createPreviewRuntime, PREVIEW_README } from "../../packages/platform/dist/src/preview.js";
import { readPlatformEnvironment } from "../../packages/platform/dist/src/production.js";
import { readPreviewEnvironment } from "../../packages/platform/dist/src/preview.js";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import {
  chatChannelInitialState,
  chatChannelReducer,
  fileContentInitialState,
  fileContentReducer,
} from "../../packages/reducers/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-12-first-light/E12-T00-railway-preview");
const frozenReadme = await readFile(
  resolve(root, "packages/platform/fixtures/preview/README.md"),
  "utf8",
);
assert.equal(PREVIEW_README, frozenReadme);
const output = resolve(process.argv[2] ?? resolve(task, "work/http"));
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(resolve(output, "data-"));
const otherDataDir = await mkdtemp(resolve(output, "isolated-"));
const partialDataDir = await mkdtemp(resolve(output, "partial-"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const environment = {
  EF_DEPLOYMENT_MODE: "preview",
  EF_PREVIEW_AUTH: "fixture",
  EF_BUILD_REVISION: revision,
  EF_PUBLIC_ORIGIN: origin,
  EF_PREVIEW_DATA_DIR: dataDir,
  PORT: String(port),
};
let runtime;
const records = [];
const timed = async (name, work) => {
  const start = performance.now();
  const result = await work();
  const ms = Math.round(performance.now() - start);
  assert.ok(ms < 60000, `${name} exceeded 60 seconds`);
  records.push({ name, ms });
  return result;
};
const login = async (subject = "ada") => {
  const response = await fetch(`${origin}/auth/preview`, {
    method: "POST",
    redirect: "manual",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subject, next: "/preview/forest" }),
  });
  assert.equal(response.status, 303, await response.clone().text());
  assert.equal(response.headers.get("location"), "/preview/forest");
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  return cookie.split(";")[0];
};
const dump = async (cookie) => {
  const response = await fetch(
    `${origin}/api/chat/preview/welcome?projection=1&reducer=chat-channel`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
try {
  runtime = await timed("startup", async () => {
    const instance = await createPreviewRuntime(environment);
    await instance.start();
    return instance;
  });
  assert.equal(runtime.server.address().address, "0.0.0.0");
  for (const route of ["/healthz", "/readyz", "/api/build"]) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, "preview");
    assert.equal(body.revision, revision);
    assert.equal(body.agents, "off");
    assert.equal(body.integrations, "off");
    assert.match(body.artifactDigest, /^[a-f0-9]{64}$/);
  }
  const deployment = await (await fetch(`${origin}/api/deployment`)).json();
  for (const item of deployment.artifact.files) {
    const bytes = await readFile(resolve(root, item.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
  assert.equal(
    createHash("sha256").update(JSON.stringify(deployment.artifact.files)).digest("hex"),
    deployment.artifactDigest,
  );
  await writeFile(resolve(output, "artifact.json"), `${JSON.stringify(deployment, null, 2)}\n`);
  const deep = await fetch(`${origin}/preview/forest/blob/main/README.md`, { redirect: "manual" });
  assert.equal(deep.status, 302);
  assert.equal(
    deep.headers.get("location"),
    "/auth/login?next=%2Fpreview%2Fforest%2Fblob%2Fmain%2FREADME.md",
  );
  const notice = await (await fetch(`${origin}${deep.headers.get("location")}`)).text();
  assert.match(notice, /PUBLIC PREVIEW/);
  assert.match(notice, /DISPOSABLE DATA/);
  assert.match(notice, /SHARED FIXTURE/);
  const absent = await fetch(`${origin}/api/whoami`);
  assert.equal(absent.status, 401);
  for (const path of [
    "/streams/__identity__",
    "/streams/ns%3Aroot",
    "/admin",
    "/__admin",
    "/.env",
    "/.git/config",
  ]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /sessionSecret|PRIVATE KEY|synthetic-secret-canary/);
  }
  const denied = await fetch(`${origin}/auth/preview`, {
    method: "POST",
    headers: { origin: "https://other.test", "content-type": "application/x-www-form-urlencoded" },
    body: "subject=ada",
  });
  assert.equal(denied.status, 403);
  const cookie = await login();
  const fixtureFile = await fetch(
    `${origin}/api/repos/preview/forest/main/blob/README.md?projection=1&reducer=file-content`,
    {
      headers: { cookie },
    },
  );
  assert.equal(fixtureFile.status, 200, await fixtureFile.clone().text());
  const file = await fixtureFile.json();
  assert.equal(
    file.events.reduce(fileContentReducer, fileContentInitialState).text,
    PREVIEW_README,
  );
  const before = await dump(cookie);
  const mutation = {
    streamId: "chat:preview/welcome",
    event: {
      type: "chat.message.post",
      payload: {
        v: 1,
        id: "http-persistent-message",
        body: "HTTP acceptance persists through restart.",
      },
      ts: 1700000000000,
    },
  };
  const response = await fetch(`${origin}/api/dispatch`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const accepted = await dump(await login("grace"));
  assert.equal(accepted.events.length, before.events.length + 1);
  const reduced = accepted.events.reduce(chatChannelReducer, chatChannelInitialState);
  const digest = stateDigest(reduced);
  await writeFile(
    resolve(output, "accepted.jsonl"),
    `${accepted.events.map(canonicalJson).join("\n")}\n`,
  );
  await writeFile(resolve(output, "accepted-state.json"), `${canonicalJson(reduced)}\n`);
  const seedStateBefore = await readFile(resolve(dataDir, "preview-state.json"), "utf8");
  await timed("shutdown", () => runtime.close());
  runtime = undefined;
  runtime = await timed("restart", async () => {
    const instance = await createPreviewRuntime(environment);
    await instance.start();
    return instance;
  });
  const restarted = await dump(cookie);
  assert.deepEqual(restarted.events, accepted.events);
  assert.equal(
    stateDigest(restarted.events.reduce(chatChannelReducer, chatChannelInitialState)),
    digest,
  );
  assert.equal(await readFile(resolve(dataDir, "preview-state.json"), "utf8"), seedStateBefore);
  const logout = await fetch(`${origin}/auth/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin },
  });
  assert.equal(logout.status, 302);
  assert.equal((await fetch(`${origin}/api/whoami`, { headers: { cookie } })).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/api/dispatch`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(mutation),
      })
    ).status,
    401,
  );
  const second = await createPreviewRuntime({
    ...environment,
    EF_PREVIEW_DATA_DIR: otherDataDir,
    PORT: "0",
  });
  await second.start();
  try {
    const records = await (
      await fetch(`${second.streamUrl}/streams/chat%3Apreview%2Fwelcome?offset=-1`)
    ).text();
    assert.doesNotMatch(records, /HTTP acceptance persists/);
  } finally {
    await second.close();
  }
  await writeFile(
    resolve(partialDataDir, "preview-state.json"),
    JSON.stringify({
      version: 1,
      fixture: "railway-first-light-v1",
      bootstrap: "initializing",
      sessionSecret: "a".repeat(64),
    }),
  );
  await assert.rejects(
    createPreviewRuntime({ ...environment, EF_PREVIEW_DATA_DIR: partialDataDir }),
    /bootstrap is incomplete/,
  );
  await assert.rejects(
    createPreviewRuntime({ ...environment, EF_WEB_ROOT: resolve(output, "missing-assets") }),
  );
  for (const [name, value] of [
    ["EFOREST_SERVER_URL", "https://production.example.test"],
    ["EF_OIDC_ISSUER", "https://production.auth0.com"],
    ["EF_AGENT_RESPONDER", "harness"],
    ["EF_RESEND_API_KEY", "synthetic-secret-canary"],
    ["OPENAI_API_KEY", "synthetic-secret-canary"],
    ["CODEX_HOME", "/Users/synthetic/.codex"],
  ]) {
    assert.throws(() => readPreviewEnvironment({ ...environment, [name]: value }));
    await assert.rejects(createPreviewRuntime({ ...environment, [name]: value }));
  }
  assert.throws(() => readPlatformEnvironment(environment), /preview configuration/);
  const summary = {
    revision,
    origin,
    assertions: [
      "real-platform-runtime",
      "private-reference-streams",
      "fixture-notice-before-data",
      "real-gateway-mutation",
      "independent-second-fixture-read",
      "restart-preserves-session-secret-and-events",
      "separate-volume-isolation",
      "partial-bootstrap-refusal",
      "missing-assets-refusal",
      "configuration-refusal-before-listen",
      "ended-session-refusal",
    ],
    records,
    stream: "chat:preview/welcome",
    offset: accepted.checkpoint,
    digest,
    eventCount: accepted.events.length,
    readmeSha256: createHash("sha256").update(PREVIEW_README).digest("hex"),
  };
  await writeFile(resolve(output, "http.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`E12_T00_HTTP_OK ${JSON.stringify(summary)}\n`);
} finally {
  await runtime?.close();
  await Promise.all(
    [dataDir, otherDataDir, partialDataDir].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
}
