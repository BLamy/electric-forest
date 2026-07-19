#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
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
const scratch = mkdtempSync(join(tmpdir(), "eforest-e2-t06-restart-"));
const original = join(scratch, "original");
const copied = join(scratch, "stream-store-copy");

async function start(dataDir) {
  const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
  const url = await server.start();
  return { server, streams: new OfficialStreamAdapter({ baseUrl: url }) };
}

async function snapshot(streams) {
  const rootEvents = await streams.read("ns:root");
  const orgEvents = { "ns:org:acme": await streams.read("ns:org:acme") };
  const state = composeNamespaceView(rootEvents, orgEvents);
  return {
    digest: namespaceViewDigest(state),
    org: resolvePath(state, "acme"),
    repo: resolvePath(state, "acme/forest"),
    branch: resolvePath(state, "acme/forest/main"),
  };
}

let live;
let restarted;
let copiedStore;
try {
  process.stderr.write("E2-T06 restart: create\n");
  live = await start(original);
  const dispatcher = new NamespaceDispatcher(live.streams);
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
  const before = await snapshot(live.streams);
  process.stderr.write("E2-T06 restart: stop live\n");
  await live.server.stop();
  live = undefined;

  process.stderr.write("E2-T06 restart: reopen\n");
  restarted = await start(original);
  const afterRestart = await snapshot(restarted.streams);
  assert.deepEqual(afterRestart, before, "same-data-dir restart changed namespace resolution");
  process.stderr.write("E2-T06 restart: stop reopened\n");
  await restarted.server.stop();
  restarted = undefined;

  process.stderr.write("E2-T06 restart: copy\n");
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
    "same-data-dir=identical",
    "stream-store-copy=identical",
    "E2_T06_RESTART_OK",
    "",
  ].join("\n");
  assert.equal(readFileSync(evidence, "utf8"), transcript, "restart evidence drifted");
  process.stdout.write(transcript);
} finally {
  await live?.server.stop();
  await restarted?.server.stop();
  await copiedStore?.server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
