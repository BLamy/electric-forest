import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHttpServer, MemoryStreamStore } from "../../packages/server/dist/src/index.js";
import { createStreamFsServerOptions } from "../../packages/streamfs/dist/src/index.js";

const repoRoot = join(new URL("../..", import.meta.url).pathname);
const evidenceRoot = join(repoRoot, ".eforest/tasks/epic-1-the-trunk/E1-T01-streamfs-core-tree-digest/evidence");
const corpusRoot = join(evidenceRoot, "fuzz");
const cliPath = join(repoRoot, "packages/cli/dist/src/bin.js");
const reducerPath = join(repoRoot, "packages/streamfs/reducer.mjs");
const server = createHttpServer(new MemoryStreamStore(), createStreamFsServerOptions());
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("refusal corpus server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
const temp = mkdtempSync(join(tmpdir(), "eforest-streamfs-refusals-"));

async function stop() {
  rmSync(temp, { recursive: true, force: true });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function getDump(streamId) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dump`);
  return { body: await response.text(), head: response.headers.get("stream-next-offset") };
}

async function dispatch(streamId, action) {
  return fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}

function metadataId(name) {
  return `fs:${name}:main:meta`;
}

let checked = 0;
try {
  const files = readdirSync(corpusRoot).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const testCase = JSON.parse(readFileSync(join(corpusRoot, file), "utf8"));
    const streamId = metadataId(`fuzz-${testCase.name}`);
    const created = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fs-meta", version: "fs-v2" }),
    });
    if (created.status !== 201) throw new Error(`${testCase.name}: stream create ${created.status}`);
    for (const setup of testCase.setup ?? []) {
      const response = await dispatch(streamId, setup);
      if (response.status !== 201) throw new Error(`${testCase.name}: setup refused ${response.status}`);
    }
    const before = await getDump(streamId);
    const refused = await dispatch(streamId, testCase.action);
    const refusedBody = await refused.json();
    if (refused.status !== testCase.expectedStatus) {
      throw new Error(`${testCase.name}: status ${refused.status} != ${testCase.expectedStatus}`);
    }
    if (refusedBody?.error?.class !== testCase.expectedClass) {
      throw new Error(`${testCase.name}: class ${JSON.stringify(refusedBody)} != ${testCase.expectedClass}`);
    }
    const after = await getDump(streamId);
    if (after.body !== before.body || after.head !== before.head) {
      throw new Error(`${testCase.name}: refusal changed metadata head or dump`);
    }
    const valid = await dispatch(streamId, {
      type: "fs.file.create",
      payload: { v: 2, path: `valid-${checked}`, contentStreamId: `content-${checked}` },
      ts: 100 + checked,
    });
    if (valid.status !== 201) throw new Error(`${testCase.name}: valid follow-up ${valid.status}`);
    checked += 1;
  }

  async function rawCorrupt(name, action) {
    const streamId = metadataId(name);
    const created = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fs-meta", version: "fs-v2" }),
    });
    if (created.status !== 201) throw new Error(`${name}: stream create ${created.status}`);
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

  await rawCorrupt("raw-schema-bypass", {
    type: "fs.file.create",
    payload: { v: 1, path: "bad", contentStreamId: "c" },
    ts: 1,
  });
  await rawCorrupt("raw-precondition-bypass", {
    type: "fs.file.write",
    payload: { v: 2, path: "missing", contentSha256: "0".repeat(64), size: 0 },
    ts: 1,
  });
  console.log(`streamfs refusal corpus cases=${checked} raw-bypass=2 head-neutral follow-ups=all OK`);
} finally {
  await stop();
}
