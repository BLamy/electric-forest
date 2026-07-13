import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHttpServer, MemoryStreamStore } from "../../packages/server/dist/src/index.js";
import { createStreamFsServerOptions } from "../../packages/streamfs/dist/src/index.js";

const repoRoot = join(new URL("../..", import.meta.url).pathname);
const corpusRoot = join(repoRoot, ".eforest/tasks/epic-1-the-trunk/E1-T02-directory-ops/evidence/fuzz");
const cliPath = join(repoRoot, "packages/cli/dist/src/bin.js");
const reducerPath = join(repoRoot, "packages/streamfs/reducer.mjs");
const server = createHttpServer(new MemoryStreamStore(), createStreamFsServerOptions());
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("directory corpus server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
const temp = mkdtempSync(join(tmpdir(), "eforest-streamfs-directory-refusals-"));

async function stop() {
  rmSync(temp, { recursive: true, force: true });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function metadataId(name) {
  return `fs:${name}:main:meta`;
}

async function createStream(streamId) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "fs-meta", version: "fs-v2" }),
  });
  if (response.status !== 201) throw new Error(`${streamId}: stream create ${response.status}`);
}

async function dispatch(streamId, action) {
  return fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}

async function snapshot(streamId) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dump`);
  return { body: await response.text(), head: response.headers.get("stream-next-offset") };
}

let checked = 0;
try {
  const files = readdirSync(corpusRoot).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const testCase = JSON.parse(readFileSync(join(corpusRoot, file), "utf8"));
    const streamId = metadataId(`dir-fuzz-${testCase.name}`);
    await createStream(streamId);
    for (const [index, setup] of (testCase.setup ?? []).entries()) {
      const response = await dispatch(streamId, { ...setup, ts: setup.ts ?? index + 1 });
      if (response.status !== 201) throw new Error(`${testCase.name}: setup refused ${response.status}`);
    }
    const before = await snapshot(streamId);
    const refused = await dispatch(streamId, testCase.action);
    const body = await refused.json();
    if (refused.status !== testCase.expectedStatus) {
      throw new Error(`${testCase.name}: status ${refused.status} != ${testCase.expectedStatus}`);
    }
    if (body?.error?.class !== testCase.expectedClass) {
      throw new Error(`${testCase.name}: class ${JSON.stringify(body)} != ${testCase.expectedClass}`);
    }
    const after = await snapshot(streamId);
    if (after.body !== before.body || after.head !== before.head) {
      throw new Error(`${testCase.name}: refusal changed metadata head or dump`);
    }
    const followUp = await dispatch(streamId, {
      type: "fs.file.create",
      payload: { v: 2, path: `valid-${checked}`, contentStreamId: `follow-up-${checked}` },
      ts: 1000 + checked,
    });
    if (followUp.status !== 201) throw new Error(`${testCase.name}: valid follow-up ${followUp.status}`);
    checked += 1;
  }

  async function rawCorrupt(name, action) {
    const streamId = metadataId(name);
    await createStream(streamId);
    const append = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: JSON.stringify({ events: [action] }),
    });
    if (append.status !== 201) throw new Error(`${name}: raw append ${append.status}`);
    const state = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/state`);
    const stateBody = await state.text();
    if (state.status < 400 || !/reducer_error/.test(stateBody) || !/offset/.test(stateBody)) {
      throw new Error(`${name}: state folded corrupt log ${state.status} ${stateBody}`);
    }
    const dump = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dump`);
    const dumpPath = join(temp, `${name}.jsonl`);
    writeFileSync(dumpPath, await dump.text());
    const replay = spawnSync(process.execPath, [cliPath, "replay", dumpPath, "--digest", "--reducer", reducerPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (replay.status === 0 || !/line 1/.test(replay.stderr)) {
      throw new Error(`${name}: ef replay accepted corrupt log: ${replay.status} ${replay.stderr}`);
    }
  }

  await rawCorrupt("raw-v1-directory", {
    type: "fs.dir.create",
    payload: { v: 1, path: "old" },
    ts: 1,
  });
  await rawCorrupt("raw-occupied-rename", {
    type: "fs.rename",
    payload: { v: 2, from: "missing", to: "target" },
    ts: 1,
  });
  console.log(`streamfs directory refusal corpus cases=${checked} raw-bypass=2 head-neutral follow-ups=all OK`);
} finally {
  await stop();
}
