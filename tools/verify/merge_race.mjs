import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { StreamFs, createStreamFsServerOptions } from "../../packages/streamfs/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = join(root, ".eforest/tasks/epic-1-the-trunk/E1-T09-fast-forward-merge/evidence");
const updateEvidence = process.argv.includes("--update-evidence");

function frozen(name, value) {
  const path = join(evidence, name);
  if (updateEvidence) {
    writeFileSync(path, value, "utf8");
    return;
  }
  if (!existsSync(path) || readFileSync(path, "utf8") !== value) {
    throw new Error(`frozen evidence mismatch: ${name}`);
  }
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), createStreamFsServerOptions());
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("race server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function dispatch(baseUrl, streamId, event) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson(event),
  });
  return { status: response.status, body: await response.json() };
}

async function dump(baseUrl, streamId) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dump`);
  const text = await response.text();
  if (!response.ok || text.length === 0) return [];
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function runInterleaving(baseUrl, index, mergeFirst) {
  const repo = await new StreamFs({ baseUrl }).createRepo(`e1-t09-race-${index}`);
  await repo.createFile("a.txt", new TextEncoder().encode("main"));
  await repo.createBranch("feature");
  const source = await repo.openBranch("feature");
  const sourceDump = await source.dump();
  const forkOffset = sourceDump[0].payload.forkOffset;
  const merge = () =>
    dispatch(baseUrl, repo.metadataStreamId, {
      type: "fs.branch.merge",
      payload: {
        v: 1,
        sourceStreamId: source.metadataStreamId,
        forkOffset,
        mergedThroughOffset: forkOffset,
      },
      ts: 0,
    });
  const append = () =>
    dispatch(baseUrl, repo.metadataStreamId, {
      type: "fs.dir.create",
      payload: { v: 2, path: `race-${index}` },
      ts: 0,
    });
  const [first, second] = mergeFirst ? [merge(), append()] : [append(), merge()];
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const target = await dump(baseUrl, repo.metadataStreamId);
  const mergeIndex = target.findIndex((record) => record.type === "fs.branch.merge");
  const appendIndex = target.findIndex((record) => record.type === "fs.dir.create");
  const outcome =
    mergeIndex >= 0 && appendIndex > mergeIndex
      ? "merge-then-append"
      : mergeIndex < 0 && appendIndex >= 0
        ? "append-then-refusal"
        : "invalid";
  if (outcome === "invalid" || (outcome === "append-then-refusal" && secondResult.status === 201)) {
    throw new Error(`invalid race outcome ${index}: ${outcome}`);
  }
  return `${index + 1} order=${mergeFirst ? "merge,append" : "append,merge"} statuses=${firstResult.status},${secondResult.status} outcome=${outcome}`;
}

async function main() {
  mkdirSync(evidence, { recursive: true });
  const dataDir = resolve(`${process.env.TMPDIR ?? "/tmp"}/eforest-e1-t09-race-${process.pid}`);
  const { server, baseUrl } = await startServer(dataDir);
  try {
    const lines = [
      "Barrier: both raw HTTP dispatches are initiated before either promise is awaited; initiation order alternates to force both legal outcomes.",
      "RUN node tools/verify/merge_race.mjs --update-evidence",
    ];
    for (let index = 0; index < 20; index += 1) {
      lines.push(await runInterleaving(baseUrl, index, index % 2 === 0));
    }
    const body = `${lines.join("\n")}\n`;
    frozen("e1-t09-race.txt", body);
    const outcomes = new Set(lines.slice(2).map((line) => line.split(" outcome=")[1]));
    if (!outcomes.has("merge-then-append") || !outcomes.has("append-then-refusal")) {
      throw new Error("race did not exercise both legal outcomes");
    }
    console.log(`merge-race interleavings=20 outcomes=${[...outcomes].sort().join(",")}`);
  } finally {
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
}

await main();
