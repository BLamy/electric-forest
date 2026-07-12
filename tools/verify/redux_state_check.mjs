#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { createHttpServer } from "../../packages/server/dist/src/index.js";
import { MemoryStreamStore } from "../../packages/server/dist/src/store/memory.js";
import { StateCache } from "../../packages/server/dist/src/redux/state-cache.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidenceDir = resolve(
  root,
  ".eforest/tasks/epic-0-the-seed/E0-T10-redux-state-and-events/evidence",
);
mkdirSync(evidenceDir, { recursive: true });

const cache = new StateCache();
const server = createHttpServer(new MemoryStreamStore(), { stateCache: cache });
await new Promise((resolveStart, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveStart);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("verify server did not bind");
const base = `http://127.0.0.1:${address.port}`;

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { response, body: await response.text() };
}

function runReplay(path) {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "packages/cli/dist/src/bin.js"), "replay", path, "--digest"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ef replay failed for ${path}: ${result.stderr}`);
  return result.stdout.trim();
}

function assertEqual(label, left, right) {
  if (left !== right) throw new Error(`${label} diverged: ${left} != ${right}`);
}

try {
  const create = await request("/streams/redux-check", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fixture" }),
  });
  if (create.response.status !== 201) throw new Error(`create failed: ${create.body}`);

  const actions = [
    { type: "set", payload: 10, ts: 1 },
    { type: "push", payload: { unicode: "✓", nested: [1, { z: true }] }, ts: 2 },
    { type: "increment", payload: 2, ts: 3 },
    { type: "meta", payload: { z: 1, a: "canonical" }, ts: 4 },
    { type: "push", payload: "fifth", ts: 5 },
    { type: "increment", payload: 5, ts: 6 },
  ];
  for (const [sequence, action] of actions.entries()) {
    const appended = await request("/streams/redux-check", {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": String(sequence) },
      body: JSON.stringify({ events: [action] }),
    });
    if (appended.response.status !== 201)
      throw new Error(`append ${sequence} failed: ${appended.body}`);
  }

  const raw = await request("/streams/redux-check?offset=-1");
  const events = await request("/streams/redux-check/events?offset=-1");
  if (raw.response.status !== 200 || events.response.status !== 200) {
    throw new Error(`read failed: raw=${raw.body} events=${events.body}`);
  }
  assertEqual("/events parity", events.body, raw.body);
  const records = JSON.parse(raw.body);
  const dumpPath = resolve(evidenceDir, "e0-t10-events.jsonl");
  writeFileSync(dumpPath, records.map((record) => canonicalJson(record)).join("\n") + "\n");
  const writerDigest = runReplay(dumpPath);
  const eventsDigest = runReplay(dumpPath);
  assertEqual("writer vs /events digest", writerDigest, eventsDigest);

  const checks = [];
  for (const record of records) {
    const state = await request(
      `/streams/redux-check/state?offset=${encodeURIComponent(record.offset)}`,
    );
    const statePath = resolve(evidenceDir, `e0-t10-state-${record.offset}.jsonl`);
    const prefix = records.filter((candidate) => candidate.offset <= record.offset);
    writeFileSync(statePath, prefix.map((candidate) => canonicalJson(candidate)).join("\n") + "\n");
    const replayDigest = runReplay(statePath);
    const stateDigestValue = stateDigest(JSON.parse(state.body));
    assertEqual(`state at ${record.offset}`, stateDigestValue, replayDigest);
    assertEqual(
      `state header at ${record.offset}`,
      state.response.headers.get("stream-offset"),
      record.offset,
    );
    checks.push({
      offset: record.offset,
      replayDigest,
      stateDigest: stateDigestValue,
      cachedBody: state.body,
    });
  }

  const head = await request("/streams/redux-check/state");
  const bypass = await request("/streams/redux-check/state?cache=bypass");
  assertEqual("cached head vs bypass", head.body, bypass.body);

  const raceCreate = await request("/streams/redux-race", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fixture" }),
  });
  if (raceCreate.response.status !== 201) throw new Error(`race create failed: ${raceCreate.body}`);
  const concurrent = [];
  for (let sequence = 0; sequence < 20; sequence += 1) {
    const attempts = [1, 2].map((payload) =>
      request("/streams/redux-race", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": String(sequence) },
        body: JSON.stringify({ events: [{ type: "increment", payload, ts: sequence }] }),
      }),
    );
    const results = await Promise.all(attempts);
    if (results.filter(({ response }) => response.status === 201).length !== 1) {
      throw new Error(`race ${sequence} did not produce exactly one accepted append`);
    }
    const raceEvents = await request("/streams/redux-race/events?offset=-1");
    const raceRecords = JSON.parse(raceEvents.body);
    const raceState = await request("/streams/redux-race/state");
    const raceOffset = raceState.response.headers.get("stream-offset");
    const prefix = raceRecords.filter((record) => record.offset <= raceOffset);
    const prefixPath = resolve(evidenceDir, `e0-t10-concurrent-${sequence}.jsonl`);
    writeFileSync(prefixPath, prefix.map((record) => canonicalJson(record)).join("\n") + "\n");
    const replayDigest = runReplay(prefixPath);
    const bodyDigest = stateDigest(JSON.parse(raceState.body));
    assertEqual(`concurrent state at ${sequence}`, bodyDigest, replayDigest);
    concurrent.push({ offset: raceOffset, bodyDigest, replayDigest });
  }
  const transcript = {
    stream: "redux-check",
    writerDigest,
    eventsDigest,
    headDigest: stateDigest(JSON.parse(head.body)),
    bypassDigest: stateDigest(JSON.parse(bypass.body)),
    offsets: checks,
    concurrent,
    cache: cache.stats(),
  };
  writeFileSync(
    resolve(evidenceDir, "e0-t10-state-transcript.json"),
    JSON.stringify(transcript, null, 2) + "\n",
  );
  writeFileSync(
    resolve(evidenceDir, "e0-t10-digests.txt"),
    [
      `writer /events: ${writerDigest}`,
      `raw /events:    ${eventsDigest}`,
      `state head:     ${transcript.headDigest}`,
      `state bypass:   ${transcript.bypassDigest}`,
      `cache:          ${JSON.stringify(transcript.cache)}`,
    ].join("\n") + "\n",
  );
  console.log(JSON.stringify(transcript, null, 2));
} finally {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
