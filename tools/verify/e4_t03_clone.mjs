#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpusRoot = join(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/evidence",
);
const cli = join(root, "packages/cli/dist/src/bin.js");
const manifest = JSON.parse(readFileSync(join(corpusRoot, "corpus-manifest.json"), "utf8"));
const protocol = await import(`${resolve(root, "packages/protocol/dist/src/index.js")}?e4-t03`);
const client = await import(`${resolve(root, "packages/client/dist/src/index.js")}?e4-t03`);
const serverModule = await import(`${resolve(root, "packages/server/dist/src/index.js")}?e4-t03`);
const streamFs = await import(`${resolve(root, "packages/streamfs/dist/src/index.js")}?e4-t03`);
const cliModule = await import(`${resolve(root, "packages/cli/dist/src/clone-command.js")}?e4-t03`);

function streamUrl(baseUrl, streamId) {
  return `${baseUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
}

function recordsFor(key) {
  const entry = manifest.streams[key];
  assert.ok(entry, `missing corpus stream ${key}`);
  return readFileSync(join(corpusRoot, entry.dump), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runEf(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

async function appendRecord(baseUrl, streamId, record) {
  await client.appendDurableJson({ url: streamUrl(baseUrl, streamId) }, record, record.offset);
}

async function seedCorpus(baseUrl) {
  const keys = Object.keys(manifest.streams)
    .filter((key) => manifest.streams[key].stream.startsWith("fs:maple/reading-room:"))
    .sort();
  for (const key of keys) {
    const streamId = manifest.streams[key].stream;
    await client.createDurableJsonStream({ url: streamUrl(baseUrl, streamId) });
    for (const record of recordsFor(key)) await appendRecord(baseUrl, streamId, record);
  }
}

async function walk(rootPath, current = rootPath) {
  const result = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolute = join(current, entry.name);
    const name = relative(rootPath, absolute);
    if (entry.isDirectory()) {
      result.push(["directory", name]);
      result.push(...(await walk(rootPath, absolute)));
    } else {
      result.push(["file", name, (await readFile(absolute)).toString("base64")]);
    }
  }
  return result;
}

async function assertSameTree(left, right) {
  assert.deepEqual(await walk(left), await walk(right), `clone trees differ: ${left} ${right}`);
}

async function writeDump(path, records) {
  const text = records.map((record) => protocol.canonicalJson(record)).join("\n");
  await writeFile(path, text.length === 0 ? "" : `${text}\n`);
}

async function inProcessClone(args, environment, fetcher) {
  let stdout = "";
  let stderr = "";
  const status = await cliModule.runClone(
    args,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    { environment, fetcher },
  );
  return { status, stdout, stderr };
}

const official = serverModule.createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const officialUrl = await official.start();
const work = await mkdtemp(join(tmpdir(), "eforest-e4-t03-"));
const home = join(work, "home");
const env = { EF_SERVER: officialUrl, EF_STREAM_SERVER_URL: officialUrl, EF_HOME: home };
const mainKey = "fs_maple_reading-room_main_meta";
const branchKey = "fs_maple_reading-room_feature-typography_meta";
const mainDump = join(corpusRoot, manifest.streams[mainKey].dump);
const branchDump = join(corpusRoot, manifest.streams[branchKey].dump);
const mainStream = manifest.streams[mainKey].stream;
const mainHead = manifest.streams[mainKey].head_offset;
const branchHead = manifest.streams[branchKey].head_offset;
const forkOffset = manifest.anchors.fork_offset;

try {
  await seedCorpus(officialUrl);
  const mainExpected = runEf(["replay", mainDump, "--worktree-digest"]).stdout.trim();
  const branchExpected = runEf(["replay", branchDump, "--worktree-digest"]).stdout.trim();
  assert.match(mainExpected, /^[0-9a-f]{64}$/);
  assert.match(branchExpected, /^[0-9a-f]{64}$/);

  const mainOne = join(work, "main-one");
  const mainTwo = join(work, "main-two");
  const branch = join(work, "branch");
  const mainResult = await inProcessClone(["maple/reading-room", "main", mainOne], env, fetch);
  const repeatResult = await inProcessClone(["maple/reading-room", "main", mainTwo], env, fetch);
  const branchResult = await inProcessClone(
    ["maple/reading-room", "feature-typography", branch],
    env,
    fetch,
  );
  assert.equal(mainResult.stdout, `checkpoint ${mainHead}\n${mainExpected}\n`);
  assert.equal(repeatResult.stdout, mainResult.stdout);
  assert.equal(branchResult.stdout, `checkpoint ${branchHead}\n${branchExpected}\n`);
  assert.equal(runEf(["tree-digest", mainOne]).stdout.trim(), mainExpected);
  assert.equal(runEf(["tree-digest", branch]).stdout.trim(), branchExpected);
  runEf(["workspace", "check", mainOne]);
  runEf(["workspace", "check", branch]);
  await assertSameTree(mainOne, mainTwo);

  const historical = join(work, "historical");
  const historicalDump = join(work, "branch-at-fork.jsonl");
  await writeDump(
    historicalDump,
    recordsFor(branchKey).filter((record) => record.offset <= forkOffset),
  );
  const historicalExpected = runEf(["replay", historicalDump, "--worktree-digest"]).stdout.trim();
  const historicalResult = await inProcessClone(
    ["maple/reading-room", "feature-typography", historical, "--at", forkOffset],
    env,
    fetch,
  );
  assert.equal(historicalResult.stdout, `checkpoint ${forkOffset}\n${historicalExpected}\n`);

  const beforeMain = await (await fetch(streamUrl(officialUrl, mainStream))).text();
  const mainRecords = await client.readDurableJson({ url: streamUrl(officialUrl, mainStream) });
  const contentCreate = mainRecords.find((record) => record.type === "fs.file.create");
  assert.ok(contentCreate, "seeded main branch has no file-create event");
  const latestWrite = [...mainRecords]
    .reverse()
    .find(
      (record) =>
        record.type === "fs.file.write" && record.payload.path === contentCreate.payload.path,
    );
  assert.ok(latestWrite, "seeded main branch has no file-write event");
  const contentStream = contentCreate.payload.contentStreamId;
  const contentRecords = await client.readDurableJson({
    url: streamUrl(officialUrl, contentStream),
  });
  const appendedBytes = Buffer.from("post-seed clone append\n");
  await appendRecord(officialUrl, contentStream, {
    offset: `0000000000000000_${String(contentRecords.length).padStart(16, "0")}`,
    type: "fs.file.content",
    payload: {
      v: 2,
      contentStreamId: contentStream,
      contentBase64: appendedBytes.toString("base64"),
    },
    ts: 900,
  });
  const nextMainOffset = `0000000000000000_${String(mainRecords.length).padStart(16, "0")}`;
  await appendRecord(officialUrl, mainStream, {
    offset: nextMainOffset,
    type: "fs.file.write",
    payload: {
      v: 2,
      path: contentCreate.payload.path,
      base: latestWrite.offset,
      contentSha256: protocol.sha256Hex(appendedBytes),
      size: appendedBytes.byteLength,
    },
    ts: 901,
  });
  const afterMain = await (await fetch(streamUrl(officialUrl, mainStream))).text();
  assert.notEqual(afterMain, beforeMain);
  const liveMainDump = join(work, "main-after-append.jsonl");
  const liveMainRecords = await client.readDurableJson({ url: streamUrl(officialUrl, mainStream) });
  await writeDump(liveMainDump, liveMainRecords);
  const appendedExpected = runEf(["replay", liveMainDump, "--worktree-digest"]).stdout.trim();
  const appendedClone = join(work, "main-after-append");
  const appendedResult = await inProcessClone(
    ["maple/reading-room", "main", appendedClone],
    env,
    fetch,
  );
  assert.equal(appendedResult.stdout, `checkpoint ${nextMainOffset}\n${appendedExpected}\n`);
  assert.equal(runEf(["tree-digest", appendedClone]).stdout.trim(), appendedExpected);
  assert.equal(
    runEf(["replay", mainDump, "--worktree-digest", "--until", mainHead]).stdout.trim(),
    mainExpected,
  );
  assert.equal(runEf(["tree-digest", mainOne]).stdout.trim(), mainExpected);

  const snapshotRepo = new streamFs.StreamFsRepo(officialUrl, fetch, "maple/reading-room");
  const receipt = await snapshotRepo.createSnapshot();
  const snapshotRecords = await client.readDurableJson({ url: streamUrl(officialUrl, mainStream) });
  assert.equal(
    snapshotRecords.some((record) => record.type === "fs.snapshot"),
    true,
  );
  const snapshotDump = join(work, "main-after-snapshot.jsonl");
  await writeDump(snapshotDump, snapshotRecords);
  const snapshotExpected = runEf(["replay", snapshotDump, "--worktree-digest"]).stdout.trim();
  const snapshotClone = join(work, "main-after-snapshot");
  const snapshotResult = await inProcessClone(
    ["maple/reading-room", "main", snapshotClone],
    env,
    fetch,
  );
  assert.equal(
    snapshotResult.stdout,
    `checkpoint ${snapshotRecords.at(-1).offset}\n${snapshotExpected}\n`,
  );
  assert.equal(runEf(["tree-digest", snapshotClone]).stdout.trim(), snapshotExpected);

  const corruptionTarget = join(work, "corrupt");
  const corruptFetcher = async (input, init) => {
    const response = await fetch(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(`/streams/${encodeURIComponent(receipt.contentRef)}?`)) {
      const body = await response.json();
      const record = body[0];
      record.payload.contentBase64 = `${record.payload.contentBase64.slice(0, -2)}AA`;
      return globalThis.Response.json(body);
    }
    return response;
  };
  const corruption = await inProcessClone(
    ["maple/reading-room", "main", corruptionTarget],
    env,
    corruptFetcher,
  );
  assert.notEqual(corruption.status, 0);
  assert.match(corruption.stderr, /^ESNAPSHOT_INTEGRITY:/);
  assert.equal(existsSync(join(corruptionTarget, ".ef", "complete")), false);

  const refusedTarget = join(work, "refused");
  const refusedFetcher = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/namespaces/"))
      return globalThis.Response.json({ error: "refused" }, { status: 401 });
    if (url.includes("/api/repos/"))
      return globalThis.Response.json({ error: "not found" }, { status: 404 });
    return fetch(input);
  };
  const refusal = await inProcessClone(
    ["maple/secret-garden", "main", refusedTarget],
    { EF_SERVER: "http://gateway.test", EF_STREAM_SERVER_URL: officialUrl, EF_HOME: home },
    refusedFetcher,
  );
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr, /^EREFUSED:/);
  assert.equal(existsSync(refusedTarget), false);

  process.stdout.write(
    [
      `E4_T03_CLONE_OK main=${mainExpected} branch=${branchExpected}`,
      `heads=${mainHead},${branchHead} fork=${forkOffset}`,
      `snapshot=${receipt.snapshotEventOffset} corruption=ESNAPSHOT_INTEGRITY refusal=EREFUSED`,
      "Replay: N/A (CLI + stream-layer change; no browser-reaching surface) + mitigation: committed clone integration tests, corpus replay digests, live offset transcript, and corruption/refusal checks.",
    ].join("\n") + "\n",
  );
} finally {
  await rm(work, { recursive: true, force: true });
  await official.stop();
}
