import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const capstoneBin = join(root, "tools/verify/e1_capstone.mjs");
const evidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/external-endpoint-summary.json",
);
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
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

try {
  const baseUrl = await endpoint();
  const result = spawnSync(
    process.execPath,
    [capstoneBin, `--base-url=${baseUrl}`, "--repo-name=external-first-repository"],
    { cwd: root, encoding: "utf8", env: process.env, timeout: 60_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.endpointMode, "external");
  assert.equal(summary.externalEndpointConfigured, true);
  assert.equal(summary.processRestarted, false);
  assert.equal(summary.wrongStorageRejected, false);
  assert.equal(summary.watcherCrashWindowRecovered, true);
  assert.equal(summary.materializedDigest, summary.finalDigest);
  assert.deepEqual(summary.conflictPaths, ["docs/readme.md"]);
  assert.deepEqual(summary.race, { loserRejected: true, winner: "B" });
  const stable = {
    actualContentEventCount: summary.actualContentEventCount,
    actualContentStreamCount: summary.actualContentStreamCount,
    applicationTransportConfiguration: summary.applicationTransportConfiguration,
    branchIsolation: summary.branchIsolation,
    conflictPaths: summary.conflictPaths,
    endpointMode: summary.endpointMode,
    eventCount: summary.eventCount,
    externalEndpointConfigured: summary.externalEndpointConfigured,
    finalDigest: summary.finalDigest,
    finalHead: summary.finalHead,
    materializedDigest: summary.materializedDigest,
    processRestarted: summary.processRestarted,
    race: summary.race,
    watcherCrashWindowRecovered: summary.watcherCrashWindowRecovered,
    watcherDigests: summary.watcherDigests,
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
  if (server.exitCode === null) {
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    server.kill("SIGTERM");
    await exited;
  }
  assert.equal(stderr, "");
  rmSync(scratch, { recursive: true, force: true });
}
