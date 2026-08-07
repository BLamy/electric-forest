import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { canonicalJson, sha256Hex } = await import("../../packages/protocol/dist/src/index.js");
const { offsetForOrdinal } = await import("../../packages/protocol/dist/src/offset-allocation.js");
const { appendDurableJson, createDurableJsonStream } =
  await import("../../packages/client/dist/src/index.js");
const { emptyView } = await import("../../packages/identity/dist/src/index.js");
const {
  createPlatformServer,
  listenPlatformServer,
  OfficialStreamAdapter,
  PlatformGateway,
  UnauthorizedError,
} = await import("../../packages/platform/dist/src/index.js");
const { createDurableStreamTestServer } = await import("../../packages/server/dist/src/index.js");
const { runClone, DownlinkEngine, verifyApplyJournal } =
  await import("../../packages/cli/dist/src/index.js");
const { StreamFsRepo, chooseWriteEvent, readStreamDump, worktreeDigest } =
  await import("../../packages/streamfs/dist/src/index.js");
const { worktreeDigestDirectory } =
  await import("../../packages/streamfs/dist/src/worktree-node.js");
const { load: loadWorkspace } = await import("../../packages/workspace/dist/src/index.js");

const cli = join(process.cwd(), "packages/cli/dist/src/bin.js");
const corpusRoot = join(
  process.cwd(),
  ".eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/evidence",
);
const corpusManifest = JSON.parse(readFileSync(join(corpusRoot, "corpus-manifest.json"), "utf8"));

function recordsForCorpus(key) {
  const entry = corpusManifest.streams[key];
  assert.ok(entry, `missing corpus stream ${key}`);
  return readFileSync(join(corpusRoot, entry.dump), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function seedCorpus(baseUrl) {
  const keys = Object.keys(corpusManifest.streams)
    .filter((key) => corpusManifest.streams[key].stream.startsWith("fs:maple/reading-room:main:"))
    .sort();
  for (const key of keys) {
    const streamId = corpusManifest.streams[key].stream;
    await createDurableJsonStream({ url: streamUrl(baseUrl, streamId) });
    for (const record of recordsForCorpus(key)) {
      await appendDurableJson({ url: streamUrl(baseUrl, streamId) }, record, record.offset);
    }
  }
}

function streamUrl(baseUrl, streamId) {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHead(workspace, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (loadWorkspace(workspace).headOffset === expected) return;
    await sleep(50);
  }
  throw new Error(`downlink did not reach checkpoint ${expected}`);
}

function contentStreamIds(records) {
  return new Set(
    records.flatMap((record) => {
      const payload = record.payload ?? {};
      return typeof payload.contentStreamId === "string" && record.type !== "fs.file.content"
        ? [payload.contentStreamId]
        : [];
    }),
  );
}

async function streamProof(repo, metadataRecords, scratch, phase) {
  const streamIds = [repo.metadataStreamId, ...contentStreamIds(metadataRecords)].sort();
  const proof = {};
  for (const [index, streamId] of streamIds.entries()) {
    const records =
      streamId === repo.metadataStreamId ? metadataRecords : await readStreamDump(repo, streamId);
    const dump = join(scratch, `${phase}-${String(index).padStart(2, "0")}.jsonl`);
    writeFileSync(dump, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
    const digest = execFileSync(process.execPath, [cli, "replay", dump, "--digest"], {
      encoding: "utf8",
    }).trim();
    proof[streamId] = {
      head: records.at(-1)?.offset ?? "-1",
      digest,
      records,
    };
  }
  return proof;
}

async function dispatchFs(platformBaseUrl, token, streamId, event) {
  const response = await fetch(`${platformBaseUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-eforest-dispatch-receipt": "offset",
    },
    body: JSON.stringify({ streamId, event }),
  });
  const body = await response.text();
  assert.equal(response.status, 202, `dispatch ${event.type}: ${body}`);
  return body.length === 0 ? {} : JSON.parse(body);
}

async function appendContent(repo, baseUrl, streamId, bytes, timestamp, clientContentAppends) {
  const records = await readStreamDump(repo, streamId);
  const offset = offsetForOrdinal(records.length);
  const record = {
    offset,
    type: "fs.file.content",
    payload: {
      v: 2,
      contentStreamId: streamId,
      contentBase64: Buffer.from(bytes).toString("base64"),
    },
    ts: timestamp,
  };
  await appendDurableJson({ url: streamUrl(baseUrl, streamId) }, record, offset);
  if (clientContentAppends !== undefined) {
    const appends = clientContentAppends.get(streamId) ?? [];
    appends.push(record);
    clientContentAppends.set(streamId, appends);
  }
  return record;
}

async function dispatchWrite(
  repo,
  baseUrl,
  platformBaseUrl,
  token,
  path,
  bytes,
  timestamp,
  clientContentAppends,
) {
  const tree = await repo.tree();
  const file = tree.files[path];
  assert.ok(file, `missing file for write ${path}`);
  const before = await repo.readFile(path);
  const choice = chooseWriteEvent(before, bytes, path, file.lastContentOffset);
  if (choice.type === "fs.file.write") {
    await appendContent(
      repo,
      baseUrl,
      file.contentStreamId,
      bytes,
      timestamp,
      clientContentAppends,
    );
  }
  await dispatchFs(platformBaseUrl, token, repo.metadataStreamId, {
    ...choice,
    ts: timestamp,
  });
  return choice;
}

async function dispatchFullWrite(
  repo,
  baseUrl,
  platformBaseUrl,
  token,
  path,
  bytes,
  timestamp,
  clientContentAppends,
) {
  const tree = await repo.tree();
  const file = tree.files[path];
  assert.ok(file, `missing file for full write ${path}`);
  await appendContent(repo, baseUrl, file.contentStreamId, bytes, timestamp, clientContentAppends);
  await dispatchFs(platformBaseUrl, token, repo.metadataStreamId, {
    type: "fs.file.write",
    payload: {
      v: 2,
      path,
      base: file.lastContentOffset,
      contentSha256: sha256Hex(bytes),
      size: bytes.byteLength,
    },
    ts: timestamp,
  });
}

async function dispatchCreate(
  repo,
  baseUrl,
  platformBaseUrl,
  token,
  path,
  bytes,
  streamId,
  timestamp,
  clientContentAppends,
) {
  await createDurableJsonStream({ url: streamUrl(baseUrl, streamId) });
  await appendContent(repo, baseUrl, streamId, bytes, timestamp, clientContentAppends);
  await dispatchFs(platformBaseUrl, token, repo.metadataStreamId, {
    type: "fs.file.create",
    payload: { v: 2, path, contentStreamId: streamId },
    ts: timestamp + 1,
  });
  await dispatchFs(platformBaseUrl, token, repo.metadataStreamId, {
    type: "fs.file.write",
    payload: {
      v: 2,
      path,
      base: "BASE_NONE",
      contentSha256: sha256Hex(bytes),
      size: bytes.byteLength,
    },
    ts: timestamp + 2,
  });
}

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t07-watch-down-"));
const workspace = join(scratch, "workspace");
const home = join(scratch, "home");
let engine;
let runPromise;
let platformServer;

try {
  const baseUrl = await server.start();
  await seedCorpus(baseUrl);
  const dispatchToken = "e4-t07-dispatch-token";
  const verifier = {
    async verifyAuthorization(header) {
      if (header !== `Bearer ${dispatchToken}`) throw new UnauthorizedError("invalid_signature");
      return { sub: "e4-t07-dispatcher" };
    },
    async authorizationContext(header) {
      if (header !== `Bearer ${dispatchToken}`) throw new UnauthorizedError("invalid_signature");
      return {
        principal: { kind: "identified", sub: "e4-t07-dispatcher" },
        identity: emptyView(),
        identityOffset: "-1",
      };
    },
  };
  platformServer = createPlatformServer((request) =>
    new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl }),
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      decideAuthorization: (input) => ({
        allowed: true,
        operation: input.operation,
        identityOffset: input.identityOffset,
        basis: "grant:write",
        streamId: input.target.kind === "repo" ? input.target.streamId : "test",
      }),
    }).handle(request),
  );
  const platformBaseUrl = await listenPlatformServer(platformServer);
  const repoName = "maple/reading-room";
  const repo = new StreamFsRepo(baseUrl, fetch, repoName, "main");

  mkdirSync(home, { recursive: true });
  const cloneStdout = [];
  const cloneStderr = [];
  const cloneStatus = await runClone(
    [repoName, "main", workspace],
    {
      stdout: (text) => cloneStdout.push(text),
      stderr: (text) => cloneStderr.push(text),
    },
    {
      environment: {
        EF_HOME: home,
        EF_SERVER: baseUrl,
        EF_STREAM_SERVER_URL: baseUrl,
      },
      fetcher: fetch,
    },
  );
  assert.equal(cloneStatus, 0, `${cloneStdout.join("")}\n${cloneStderr.join("")}`);
  assert.deepEqual(cloneStderr, []);

  const beforeHead = (await repo.rawDump()).at(-1)?.offset;
  assert.ok(beforeHead, "clone must have a metadata checkpoint");
  const beforeServerRecords = await repo.rawDump();
  const beforeStreamProof = await streamProof(repo, beforeServerRecords, scratch, "before");
  engine = new DownlinkEngine({
    root: workspace,
    streamServerUrl: baseUrl,
    accessToken: "e4-t07-read-only-token",
    fetcher: fetch,
  });
  await engine.start();
  runPromise = engine.run();

  let eventTimestamp = 1_800_000_000_000;
  const timestamp = () => eventTimestamp++;
  const chapterOne = new TextDecoder().decode(await repo.readFile("docs/chapter-one.md"));
  const patchA = new TextEncoder().encode(chapterOne.replace("deterministic", "repeatable"));
  const patchB = new TextEncoder().encode(
    new TextDecoder().decode(patchA).replace("independent", "separate"),
  );
  const patchC = new TextEncoder().encode(
    new TextDecoder().decode(patchB).replace("replay", "replayable"),
  );
  const clientContentAppends = new Map();
  const dispatchStartedAt = performance.now();
  assert.equal(
    (
      await dispatchWrite(
        repo,
        baseUrl,
        platformBaseUrl,
        dispatchToken,
        "docs/chapter-one.md",
        patchA,
        timestamp(),
        clientContentAppends,
      )
    ).type,
    "fs.file.patch",
  );
  const firstDispatchedHead = (await repo.rawDump()).at(-1)?.offset;
  assert.ok(firstDispatchedHead, "first live dispatch must advance the metadata stream");
  await waitForHead(workspace, firstDispatchedHead);
  const liveTailLatencyMs = performance.now() - dispatchStartedAt;
  assert.ok(
    liveTailLatencyMs <= 2000,
    `live tail latency ${liveTailLatencyMs.toFixed(1)}ms exceeded 2000ms`,
  );
  assert.equal(
    (
      await dispatchWrite(
        repo,
        baseUrl,
        platformBaseUrl,
        dispatchToken,
        "docs/chapter-one.md",
        patchB,
        timestamp(),
        clientContentAppends,
      )
    ).type,
    "fs.file.patch",
  );
  assert.equal(
    (
      await dispatchWrite(
        repo,
        baseUrl,
        platformBaseUrl,
        dispatchToken,
        "docs/chapter-one.md",
        patchC,
        timestamp(),
        clientContentAppends,
      )
    ).type,
    "fs.file.patch",
  );
  await dispatchFullWrite(
    repo,
    baseUrl,
    platformBaseUrl,
    dispatchToken,
    "README.md",
    new TextEncoder().encode("# Reading Room\n\nA rewritten landing page.\n"),
    timestamp(),
    clientContentAppends,
  );
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.dir.create",
    payload: { v: 2, path: "new-nested" },
    ts: timestamp(),
  });
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.rename",
    payload: { v: 2, from: "guide.md", to: "new-nested/guide.md" },
    ts: timestamp(),
  });
  await dispatchWrite(
    repo,
    baseUrl,
    platformBaseUrl,
    dispatchToken,
    "new-nested/guide.md",
    new TextEncoder().encode("renamed guide, then edited\n"),
    timestamp(),
    clientContentAppends,
  );
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.file.delete",
    payload: { v: 2, path: "LICENSE" },
    ts: timestamp(),
  });
  await dispatchCreate(
    repo,
    baseUrl,
    platformBaseUrl,
    dispatchToken,
    "LICENSE",
    new TextEncoder().encode("recreated license\n"),
    "fs:maple/reading-room:main:file:e4-t07-license",
    timestamp(),
    clientContentAppends,
  );
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.dir.create",
    payload: { v: 2, path: "new-nested/deeper" },
    ts: timestamp(),
  });
  await dispatchCreate(
    repo,
    baseUrl,
    platformBaseUrl,
    dispatchToken,
    "new-nested/deeper/leaf.txt",
    new TextEncoder().encode("leaf\n"),
    "fs:maple/reading-room:main:file:e4-t07-leaf",
    timestamp(),
    clientContentAppends,
  );
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.rename",
    payload: { v: 2, from: "new-nested/deeper/leaf.txt", to: "new-nested/deeper/renamed.txt" },
    ts: timestamp(),
  });
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.file.delete",
    payload: { v: 2, path: "new-nested/deeper/renamed.txt" },
    ts: timestamp(),
  });
  await dispatchFs(platformBaseUrl, dispatchToken, repo.metadataStreamId, {
    type: "fs.dir.remove",
    payload: { v: 2, path: "new-nested/deeper" },
    ts: timestamp(),
  });

  const finalRecords = await repo.rawDump();
  const finalHead = finalRecords.at(-1)?.offset;
  assert.ok(finalHead, "scripted edit sequence must advance the metadata stream");
  const sequence = finalRecords.filter(({ offset }) => offset > beforeHead);
  assert.ok(sequence.filter((record) => record.type === "fs.file.patch").length >= 3);
  assert.ok(sequence.some((record) => record.type === "fs.rename"));
  await waitForHead(workspace, finalHead);
  if (process.env.EFOREST_T07_PLANT_APPEND === "1") {
    const sensitivityStreamId = Object.keys(beforeStreamProof).find(
      (streamId) => streamId !== repo.metadataStreamId && !clientContentAppends.has(streamId),
    );
    assert.ok(sensitivityStreamId, "need an untouched content stream for proof sensitivity");
    const sensitivityRecords = await readStreamDump(repo, sensitivityStreamId);
    const last = sensitivityRecords.at(-1);
    assert.ok(last, "sensitivity stream must have a baseline record");
    const planted = {
      ...last,
      offset: offsetForOrdinal(sensitivityRecords.length),
      ts: Number(last.ts) + 1,
    };
    await appendDurableJson(
      { url: streamUrl(baseUrl, sensitivityStreamId) },
      planted,
      planted.offset,
    );
  }
  const afterStreamProof = await streamProof(repo, finalRecords, scratch, "after");
  const journalFile = join(workspace, ".ef", "apply-journal");
  const journal = verifyApplyJournal(journalFile);
  assert.deepEqual(
    journal.map(({ offset }) => offset),
    finalRecords.filter(({ offset }) => offset > beforeHead).map(({ offset }) => offset),
  );
  const tree = await repo.treeAt(finalHead);
  assert.equal(worktreeDigestDirectory(workspace), worktreeDigest(tree));
  const metadataDump = join(scratch, "branch-meta.jsonl");
  writeFileSync(
    metadataDump,
    `${finalRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const contentStreamIds = new Set(
    finalRecords.flatMap((record) => {
      const payload = record.payload ?? {};
      return typeof payload.contentStreamId === "string" && record.type !== "fs.file.content"
        ? [payload.contentStreamId]
        : [];
    }),
  );
  const contentRecords = [];
  for (const streamId of contentStreamIds) {
    contentRecords.push(...(await readStreamDump(repo, streamId)));
  }
  const contentDump = join(scratch, "branch-content.jsonl");
  writeFileSync(
    contentDump,
    `${contentRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const materialized = join(scratch, "materialized");
  const cliTreeDigest = execFileSync(process.execPath, [cli, "tree-digest", workspace], {
    encoding: "utf8",
  }).trim();
  const cliMaterializeDigest = execFileSync(
    process.execPath,
    [
      cli,
      "materialize",
      metadataDump,
      "--content",
      contentDump,
      "--out",
      materialized,
      "--at",
      finalHead,
      "--worktree-digest",
    ],
    { encoding: "utf8" },
  ).trim();
  const cliJournalVerify = execFileSync(process.execPath, [cli, "journal", "verify", workspace], {
    encoding: "utf8",
  }).trim();
  assert.equal(cliJournalVerify, `verified ${journal.length} apply journal entries`);
  assert.equal(cliTreeDigest, worktreeDigestDirectory(workspace));
  assert.equal(cliMaterializeDigest, cliTreeDigest);
  const afterServerRecords = await repo.rawDump();
  assert.deepEqual(afterServerRecords, finalRecords);
  assert.deepEqual(
    finalRecords.slice(0, beforeServerRecords.length),
    beforeServerRecords,
    "downlink must not rewrite the metadata prefix",
  );
  const expectedRecordsByStream = new Map();
  expectedRecordsByStream.set(repo.metadataStreamId, [...beforeServerRecords, ...sequence]);
  for (const [streamId, appends] of clientContentAppends) {
    expectedRecordsByStream.set(streamId, [
      ...(beforeStreamProof[streamId]?.records ?? []),
      ...appends,
    ]);
  }
  for (const [streamId, proof] of Object.entries(beforeStreamProof)) {
    if (!expectedRecordsByStream.has(streamId)) {
      expectedRecordsByStream.set(streamId, proof.records);
    }
  }
  assert.deepEqual(
    Object.keys(afterStreamProof).sort(),
    [...expectedRecordsByStream.keys()].sort(),
    "downlink must not create or remove a stream outside the scripted client writes",
  );
  for (const [streamId, expectedRecords] of expectedRecordsByStream) {
    const actual = afterStreamProof[streamId];
    assert.ok(actual, `stream disappeared while downlink was running: ${streamId}`);
    assert.deepEqual(
      actual.records,
      expectedRecords,
      `stream ${streamId} changed outside the scripted client append set`,
    );
    assert.equal(actual.head, expectedRecords.at(-1)?.offset ?? "-1");
    const expectedDump = join(
      scratch,
      `expected-${streamId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`,
    );
    writeFileSync(
      expectedDump,
      `${expectedRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
    );
    const expectedReplayDigest = execFileSync(
      process.execPath,
      [cli, "replay", expectedDump, "--digest"],
      {
        encoding: "utf8",
      },
    ).trim();
    assert.equal(actual.digest, expectedReplayDigest, `stream replay digest changed: ${streamId}`);
  }
  const streamProofSummary = Object.fromEntries(
    Object.keys(afterStreamProof)
      .sort()
      .map((streamId) => [
        streamId,
        {
          beforeHead: beforeStreamProof[streamId]?.head ?? "-1",
          afterHead: afterStreamProof[streamId].head,
          beforeReplayDigest: beforeStreamProof[streamId]?.digest ?? "-",
          afterReplayDigest: afterStreamProof[streamId].digest,
        },
      ]),
  );
  const evidenceDir = process.env.EFOREST_EVIDENCE_DIR;
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "e4-t07-live-journal.jsonl"),
      `${journal.map((record) => canonicalJson(record)).join("\n")}\n`,
    );
    writeFileSync(
      join(evidenceDir, "e4-t07-live-workspace.json"),
      `${canonicalJson(loadWorkspace(workspace))}\n`,
    );
  }
  process.stdout.write(
    `E4-T07 live convergence OK checkpoint=${finalHead} applied=${journal.length} ` +
      `worktree=${cliTreeDigest} materialize=${cliMaterializeDigest} ` +
      `live-latency-ms=${liveTailLatencyMs.toFixed(1)} ` +
      `${cliJournalVerify} ` +
      `server-head-before=${beforeServerRecords.at(-1)?.offset} server-head-after=${afterServerRecords.at(-1)?.offset}\n` +
      `stream-proofs=${canonicalJson(streamProofSummary)}\n`,
  );
} finally {
  if (engine !== undefined) {
    await engine.close();
    if (runPromise !== undefined) {
      await runPromise.catch((error) => {
        if (!(error instanceof Error && /abort/i.test(error.message))) throw error;
      });
    }
  }
  if (platformServer !== undefined) {
    await new Promise((resolveClose, rejectClose) => {
      platformServer.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  }
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
