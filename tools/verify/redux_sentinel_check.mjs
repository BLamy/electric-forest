#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const replayPath = resolve(root, "packages/protocol/dist/src/replay.js");
const evidenceDir = resolve(
  root,
  ".eforest/tasks/epic-0-the-seed/E0-T10-redux-state-and-events/evidence",
);
mkdirSync(evidenceDir, { recursive: true });

const original = readFileSync(replayPath, "utf8");
const needle = "  return state;\n}";
if (!original.includes(needle)) throw new Error("protocol replay source shape changed");
const sentinelSource = original.replace(
  needle,
  '  if (state && typeof state === "object" && !Array.isArray(state)) state = { ...state, __sentinel: "protocol-replay-v1" };\n  return state;\n}',
);
writeFileSync(replayPath, sentinelSource);

let server;
try {
  const serverModule = await import(
    `../../packages/server/dist/src/index.js?redux-sentinel=${Date.now()}`
  );
  const { createDefaultReducerRegistry, createHttpServer, MemoryStreamStore } = serverModule;
  server = createHttpServer(new MemoryStreamStore(), {
    reducerRegistry: createDefaultReducerRegistry(),
  });
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sentinel server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  async function request(path, init = {}) {
    const response = await fetch(`${base}${path}`, init);
    return { response, body: await response.text() };
  }

  const create = await request("/streams/sentinel", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fixture" }),
  });
  if (create.response.status !== 201) throw new Error(`sentinel create failed: ${create.body}`);
  const events = [
    { type: "set", payload: 3, ts: 1 },
    { type: "increment", payload: 2, ts: 2 },
    { type: "push", payload: "sentinel", ts: 3 },
  ];
  const append = await request("/streams/sentinel", {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": "0" },
    body: JSON.stringify({ events }),
  });
  if (append.response.status !== 201) throw new Error(`sentinel append failed: ${append.body}`);
  const dump = await request("/streams/sentinel/events?offset=-1");
  const records = JSON.parse(dump.body);
  const interior = records[0].offset;
  const head = records.at(-1).offset;
  const rows = [];

  async function check(label, path, expectedOffset) {
    const result = await request(path);
    if (result.response.status !== 200) throw new Error(`${label} failed: ${result.body}`);
    const state = JSON.parse(result.body);
    if (state.__sentinel !== "protocol-replay-v1") {
      throw new Error(`${label} did not observe the mutated protocol replay core`);
    }
    if (result.response.headers.get("stream-offset") !== expectedOffset) {
      throw new Error(`${label} reflected the wrong offset`);
    }
    rows.push({
      label,
      offset: expectedOffset,
      digest: createHash("sha256").update(result.body, "utf8").digest("hex"),
      sentinel: state.__sentinel,
    });
  }

  await check(
    "interior-cold",
    `/streams/sentinel/state?offset=${encodeURIComponent(interior)}`,
    interior,
  );
  await check(
    "interior-warm-hit",
    `/streams/sentinel/state?offset=${encodeURIComponent(interior)}`,
    interior,
  );
  await check("head-nearest-ancestor", "/streams/sentinel/state", head);
  await check("head-bypass-cold", "/streams/sentinel/state?cache=bypass", head);
  await check("head-warm-hit", "/streams/sentinel/state", head);

  const evidence = {
    mutation: "packages/protocol/dist/src/replay.js injected __sentinel after protocol replay",
    stream: "sentinel",
    rows,
    result: "sentinel propagated through interior cold, warm hit, nearest-ancestor incremental, bypass cold, and head warm hit",
  };
  writeFileSync(
    resolve(evidenceDir, "e0-t10-sentinel-transcript.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (server) {
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
  writeFileSync(replayPath, original);
}
