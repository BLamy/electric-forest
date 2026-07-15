import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const capstoneBin = join(root, "tools/verify/e1_capstone.mjs");
const evidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/external-endpoint-summary.json",
);
const expectedAuthorization = "Bearer e1-t11-external-proof";
const clientHeader = "x-eforest-capstone-client";
const updateEvidence = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node tools/verify/e1_capstone_external.mjs [--update-evidence]",
);

const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t11-external-"));
const server = spawn(
  process.execPath,
  [serverBin, "--port=0", "--store=file", `--data-dir=${join(scratch, "state")}`],
  { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
let proxy;
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function endpoint() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const match = /LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    if (match !== null) return match[1];
    if (server.exitCode !== null) throw new Error(`external server exited: ${stderr}`);
    await sleep(25);
  }
  throw new Error("external server did not start");
}

async function runCapstone(baseUrl, repoName, sabotage, timeout = 90_000) {
  const arguments_ = [capstoneBin, `--base-url=${baseUrl}`, `--repo-name=${repoName}`];
  if (sabotage !== undefined) arguments_.push(`--sabotage=${sabotage}`);
  const child = spawn(process.execPath, arguments_, {
    cwd: root,
    env: { ...process.env, EFOREST_CAPSTONE_AUTHORIZATION: expectedAuthorization },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout.on("data", (chunk) => {
    childStdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const exit = await new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  clearTimeout(timer);
  return { ...exit, stderr: childStderr, stdout: childStdout };
}

function increment(counts, label) {
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

try {
  const upstreamUrl = await endpoint();
  const accepted = new Map();
  const rejected = new Map();
  proxy = createServer((request, response) => {
    const label = request.headers[clientHeader];
    const client = typeof label === "string" ? label : "unlabelled";
    if (request.headers.authorization !== expectedAuthorization) {
      increment(rejected, client);
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"capstone-auth-required"}\n');
      return;
    }
    increment(accepted, client);
    const target = new URL(request.url ?? "/", upstreamUrl);
    const headers = { ...request.headers, host: target.host };
    const forwarded = httpRequest(
      target,
      { headers, method: request.method },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    forwarded.on("error", (error) => response.destroy(error));
    request.pipe(forwarded);
  });
  await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
  const address = proxy.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const success = await runCapstone(baseUrl, "external-first-repository");
  assert.deepEqual(
    { code: success.code, signal: success.signal },
    { code: 0, signal: null },
    `${success.stdout}${success.stderr}`,
  );
  const summary = JSON.parse(success.stdout.trim());
  assert.equal(summary.endpointMode, "external");
  assert.equal(summary.externalEndpointConfigured, true);
  assert.equal(summary.authorizationConfigured, true);
  assert.equal(summary.configuredFetchExercised, true);
  assert.equal(summary.watcherConfiguredFetchExercised, true);
  assert.equal(summary.processRestarted, false);
  assert.equal(summary.wrongStorageRejected, false);
  assert.equal(summary.watcherCrashWindowRecovered, true);
  assert.equal(summary.materializedDigest, summary.finalDigest);
  assert.deepEqual(summary.conflictPaths, ["docs/readme.md"]);
  assert.deepEqual(summary.race, { loserRejected: true, winner: "B" });

  const observedClients = [...accepted.keys()].sort();
  assert.ok((accepted.get("application") ?? 0) > 0, "endpoint observed no application traffic");
  assert.ok(
    observedClients.some((label) => label.startsWith("watcher-")),
    "endpoint observed no watcher traffic",
  );
  assert.equal(rejected.size, 0, "successful scenario sent unauthorized traffic");

  const appMutation = await runCapstone(
    baseUrl,
    "external-app-auth-mutation",
    "app-auth-header",
    30_000,
  );
  assert.notEqual(appMutation.code, 0, "application auth-header mutation unexpectedly passed");
  assert.ok(
    (rejected.get("application") ?? 0) > 0,
    "endpoint did not reject the application auth-header mutation",
  );

  const watcherMutation = await runCapstone(
    baseUrl,
    "external-watcher-auth-mutation",
    "watcher-auth-header",
    30_000,
  );
  assert.notEqual(watcherMutation.code, 0, "watcher auth-header mutation unexpectedly passed");
  assert.ok(
    [...rejected.entries()].some(([label, count]) => label.startsWith("watcher-") && count > 0),
    "endpoint did not reject the watcher auth-header mutation",
  );

  const stable = {
    actualContentEventCount: summary.actualContentEventCount,
    actualContentStreamCount: summary.actualContentStreamCount,
    appAuthorizationMutationRejected: true,
    applicationTrafficObserved: true,
    applicationTransportConfiguration: summary.applicationTransportConfiguration,
    authorizationConfigured: summary.authorizationConfigured,
    branchIsolation: summary.branchIsolation,
    configuredFetchExercised: summary.configuredFetchExercised,
    conflictPaths: summary.conflictPaths,
    endpointMode: summary.endpointMode,
    eventCount: summary.eventCount,
    externalEndpointConfigured: summary.externalEndpointConfigured,
    finalDigest: summary.finalDigest,
    finalHead: summary.finalHead,
    materializedDigest: summary.materializedDigest,
    observedClients,
    processRestarted: summary.processRestarted,
    race: summary.race,
    watcherAuthorizationMutationRejected: true,
    watcherCrashWindowRecovered: summary.watcherCrashWindowRecovered,
    watcherConfiguredFetchExercised: summary.watcherConfiguredFetchExercised,
    watcherDigests: summary.watcherDigests,
    watcherTrafficObserved: true,
    wrongStorageRejected: summary.wrongStorageRejected,
  };
  const text = `${canonicalJson(stable)}\n`;
  if (updateEvidence) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, text, "utf8");
  } else {
    assert.ok(existsSync(evidence), "missing external endpoint evidence");
    assert.equal(text, readFileSync(evidence, "utf8"), "external endpoint evidence drifted");
  }
  process.stdout.write(text);
} finally {
  if (proxy !== undefined) {
    proxy.closeAllConnections();
    await new Promise((resolveClose) => proxy.close(resolveClose));
  }
  if (server.exitCode === null) {
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    server.kill("SIGTERM");
    await exited;
  }
  assert.equal(stderr, "");
  rmSync(scratch, { recursive: true, force: true });
}
