#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  composeNamespaceView,
  NamespaceDispatcher,
  namespaceViewDigest,
  OfficialStreamAdapter,
  resolvePath,
} from "../../packages/platform/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-restart.txt",
);
const serverWorker = resolve(root, "tools/verify/e2_t06_restart_server.mjs");
const replayWorker = resolve(root, "tools/verify/e2_t06_restart_replay.mjs");
const scratch = mkdtempSync(join(tmpdir(), "eforest-e2-t06-restart-"));
const original = join(scratch, "original");
const copied = join(scratch, "stream-store-copy");

async function startAbruptTarget(dataDir) {
  const child = spawn(process.execPath, [serverWorker, dataDir], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((accept, reject) => {
    const marker = "E2_T06_READY ";
    function onExit(code, signal) {
      reject(new Error(`restart worker exited before ready: code=${code} signal=${signal}`));
    }
    child.once("exit", onExit);
    function onLine(line) {
      if (!line.startsWith(marker)) return;
      child.off("exit", onExit);
      lines.off("line", onLine);
      accept(JSON.parse(line.slice(marker.length)));
    }
    lines.on("line", onLine);
  });
  const { url } = await ready;
  lines.close();
  return { child, streams: new OfficialStreamAdapter({ baseUrl: url }) };
}

async function start(dataDir) {
  const { createDurableStreamTestServer } = await import("../../packages/server/dist/src/index.js");
  const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
  const url = await server.start();
  return { server, streams: new OfficialStreamAdapter({ baseUrl: url }) };
}

async function rawDump(streams) {
  return {
    rootEvents: await streams.read("ns:root"),
    orgStreams: { "ns:org:acme": await streams.read("ns:org:acme") },
  };
}

function snapshotFromDump(dump) {
  const state = composeNamespaceView(dump.rootEvents, dump.orgStreams);
  return {
    digest: namespaceViewDigest(state),
    org: resolvePath(state, "acme"),
    repo: resolvePath(state, "acme/forest"),
    branch: resolvePath(state, "acme/forest/main"),
  };
}

async function snapshot(streams) {
  return snapshotFromDump(await rawDump(streams));
}

function replayInFreshProcess(dump) {
  const result = spawnSync(process.execPath, [replayWorker], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(dump),
  });
  assert.equal(result.status, 0, `fresh replay process failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function killAbruptly(target) {
  const exited = once(target.child, "exit");
  assert.equal(target.child.kill("SIGKILL"), true, "failed to deliver SIGKILL to stream server");
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

let abrupt;
let restarted;
let copiedStore;
try {
  process.stderr.write("E2-T06 restart: create child process\n");
  abrupt = await startAbruptTarget(original);
  const dispatcher = new NamespaceDispatcher(abrupt.streams);
  await dispatcher.dispatch(
    "ns:root",
    { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 },
    "auth0|alice",
  );
  await dispatcher.dispatch(
    "ns:org:acme",
    { type: "ns.project.create", payload: { v: 1, name: "core" }, ts: 2 },
    "auth0|alice",
  );
  await dispatcher.dispatch(
    "ns:org:acme",
    {
      type: "ns.repo.create",
      payload: { v: 1, name: "forest", project: "core", visibility: "private" },
      ts: 3,
    },
    "auth0|bob",
  );
  const dump = await rawDump(abrupt.streams);
  const before = snapshotFromDump(dump);
  const fromFreshProcess = replayInFreshProcess(dump);
  assert.deepEqual(fromFreshProcess, before, "fresh-process raw replay changed namespace state");

  process.stderr.write("E2-T06 restart: SIGKILL child\n");
  await killAbruptly(abrupt);
  abrupt = undefined;

  process.stderr.write("E2-T06 restart: reopen after SIGKILL\n");
  restarted = await start(original);
  const afterRestart = await snapshot(restarted.streams);
  assert.deepEqual(afterRestart, before, "SIGKILL restart changed namespace resolution");
  await restarted.server.stop();
  restarted = undefined;

  process.stderr.write("E2-T06 restart: copy raw stream store\n");
  cpSync(original, copied, { recursive: true });
  copiedStore = await start(copied);
  const afterCopy = await snapshot(copiedStore.streams);
  assert.deepEqual(afterCopy, before, "stream-store-only copy changed namespace resolution");

  const transcript = [
    "E2-T06 namespace restart proof",
    `view-digest=${before.digest}`,
    `org=${JSON.stringify(before.org)}`,
    `repo=${JSON.stringify(before.repo)}`,
    `branch=${JSON.stringify(before.branch)}`,
    "abrupt-sigkill=identical",
    "fresh-process-raw-replay=identical",
    "stream-store-copy=identical",
    "E2_T06_RESTART_OK",
    "",
  ].join("\n");
  assert.equal(readFileSync(evidence, "utf8"), transcript, "restart evidence drifted");
  process.stdout.write(transcript);
} finally {
  if (abrupt !== undefined) {
    if (abrupt.child.exitCode === null && abrupt.child.signalCode === null) {
      abrupt.child.kill("SIGKILL");
      await once(abrupt.child, "exit");
    }
  }
  await restarted?.server.stop();
  await copiedStore?.server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
