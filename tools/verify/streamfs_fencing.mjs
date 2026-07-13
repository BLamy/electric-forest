import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import {
  createDefaultActionValidatorRegistry,
  createHttpServer,
  FileStreamStore,
  MemoryStreamStore,
  streamLogPath,
} from "../../packages/server/dist/src/index.js";
import {
  BASE_NONE,
  createStreamFsReducerRegistry,
  createStreamFsServerOptions,
  diffText,
  FS_EVENT_VERSION,
} from "../../packages/streamfs/dist/src/index.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const evidenceRoot = join(
  repoRoot,
  ".eforest/tasks/epic-1-the-trunk/E1-T04-stale-write-fencing/evidence",
);
const goldenPath = join(evidenceRoot, "e1-t04-two-writer.events.jsonl");
const goldenDigestPath = join(evidenceRoot, "e1-t04-two-writer.digest");
const transcriptPath = join(evidenceRoot, "e1-t04-two-writer.txt");
const neutralityPath = join(evidenceRoot, "e1-t04-refusal-neutrality.txt");
const sensitivityPath = join(evidenceRoot, "e1-t04-sensitivity.md");

mkdirSync(evidenceRoot, { recursive: true });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value) {
  return encoder.encode(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function action(type, payload, ts) {
  return { type, payload, ts };
}

function full(path, base, value, ts) {
  const content = bytes(value);
  return action(
    "fs.file.write",
    {
      v: FS_EVENT_VERSION,
      path,
      base,
      contentSha256: digest(content),
      size: content.byteLength,
    },
    ts,
  );
}

function patch(path, base, previous, target, ts) {
  return action(
    "fs.file.patch",
    {
      v: FS_EVENT_VERSION,
      path,
      base,
      baseDigest: digest(previous),
      ops: diffText(decoder.decode(previous), decoder.decode(target)),
      resultDigest: digest(target),
    },
    ts,
  );
}

async function startServer(store, options) {
  const server = createHttpServer(store, options);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fencing verifier did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function request(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, text, body };
}

async function putStream(baseUrl, streamId, type = "fs-file-content") {
  const result = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: canonicalJson({ type, version: "fs-v2" }),
  });
  if (result.response.status !== 201) throw new Error(`stream create ${streamId}: ${result.text}`);
}

async function appendContent(baseUrl, streamId, value, ts) {
  const result = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": "0" },
    body: canonicalJson({
      events: [
        action(
          "fs.file.content",
          {
            v: FS_EVENT_VERSION,
            contentStreamId: streamId,
            contentBase64: Buffer.from(value).toString("base64"),
          },
          ts,
        ),
      ],
    }),
  });
  if (result.response.status !== 201) throw new Error(`content append ${streamId}: ${result.text}`);
}

async function dispatch(baseUrl, streamId, value) {
  return request(baseUrl, `/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson(value),
  });
}

async function dump(baseUrl, streamId) {
  return request(baseUrl, `/streams/${encodeURIComponent(streamId)}/dump`);
}

async function stateSnapshot(baseUrl, streamId) {
  const result = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}/state`);
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error(`state response is not an object: ${result.text}`);
  }
  const dumpResult = await dump(baseUrl, streamId);
  return {
    dumpBody: dumpResult.text,
    dumpSha256: digest(Buffer.from(dumpResult.text)),
    stateBody: result.text,
    head: dumpResult.response.headers.get("stream-next-offset"),
    count: dumpResult.text.length === 0 ? 0 : dumpResult.text.trimEnd().split("\n").length,
    treeDigest: stateDigest(result.body),
  };
}

function eventCount(records, path) {
  return records.filter(
    (record) =>
      record.payload?.path === path &&
      (record.type === "fs.file.write" || record.type === "fs.file.patch"),
  ).length;
}

function replayDigest(path) {
  return execFileSync(
    "pnpm",
    ["--silent", "ef", "replay", path, "--digest", "--reducer", "packages/streamfs/reducer.mjs"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
}

async function createBaseline(baseUrl, metadataStreamId, contentStreamId, path, value) {
  await putStream(baseUrl, contentStreamId);
  await appendContent(baseUrl, contentStreamId, value, 1);
  const created = await dispatch(
    baseUrl,
    metadataStreamId,
    action("fs.file.create", { v: FS_EVENT_VERSION, path, contentStreamId }, 2),
  );
  if (created.response.status !== 201) throw new Error(`baseline create: ${created.text}`);
  const written = await dispatch(
    baseUrl,
    metadataStreamId,
    full(path, BASE_NONE, decoder.decode(value), 3),
  );
  if (written.response.status !== 201) throw new Error(`baseline write: ${written.text}`);
  return written.body.event.offset;
}

async function verifyTwoWriterGolden() {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-e1-t04-golden-"));
  const store = new FileStreamStore(dataDir);
  const { server, baseUrl } = await startServer(store, createStreamFsServerOptions());
  const metadataStreamId = "fs:e1-t04-two-writer:main:meta";
  const contentStreamId = "fs:e1-t04-two-writer:main:file:1-fixed";
  const path = "contested.txt";
  const baseline = bytes("baseline");
  const targetA = bytes("writer A");
  const targetB = bytes("writer B");
  try {
    await putStream(baseUrl, metadataStreamId, "fs-meta");
    const revision = await createBaseline(
      baseUrl,
      metadataStreamId,
      contentStreamId,
      path,
      baseline,
    );
    const accepted = await dispatch(
      baseUrl,
      metadataStreamId,
      patch(path, revision, baseline, targetA, 4),
    );
    const refused = await dispatch(
      baseUrl,
      metadataStreamId,
      patch(path, revision, baseline, targetB, 5),
    );
    if (accepted.response.status !== 201 || refused.response.status !== 409) {
      throw new Error(`two-writer statuses ${accepted.response.status}/${refused.response.status}`);
    }
    const rebasedBase = refused.body.error.conflict.expectedBase;
    const rebased = await dispatch(
      baseUrl,
      metadataStreamId,
      patch(path, rebasedBase, targetA, targetB, 6),
    );
    if (rebased.response.status !== 201) throw new Error(`rebased write refused: ${rebased.text}`);

    const dumpResult = await dump(baseUrl, metadataStreamId);
    const records = dumpResult.text
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (eventCount(records, path) !== 3)
      throw new Error("golden does not contain exactly three content events");
    writeFileSync(goldenPath, dumpResult.text);
    const expectedDigest = replayDigest(goldenPath);
    writeFileSync(goldenDigestPath, `${expectedDigest}\n`);
    writeFileSync(
      transcriptPath,
      [
        "E1-T04 two-writer transcript",
        `baseline action=fs.file.write declaredBase=${BASE_NONE} status=201 established=${revision}`,
        `A action=fs.file.patch declaredBase=${revision} status=${accepted.response.status} established=${accepted.body.event.offset}`,
        `B action=fs.file.patch declaredBase=${revision} status=${refused.response.status} body=${canonicalJson(refused.body)}`,
        `B-rebased action=fs.file.patch declaredBase=${rebasedBase} status=${rebased.response.status} established=${rebased.body.event.offset}`,
        `final content=${decoder.decode(targetB)}`,
        `contentEventsForPath=${eventCount(records, path)}`,
        `replayDigest=${expectedDigest}`,
      ].join("\n") + "\n",
    );
  } finally {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function verifyRefusalNeutrality() {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-e1-t04-neutrality-"));
  const store = new FileStreamStore(dataDir);
  const { server, baseUrl } = await startServer(store, createStreamFsServerOptions());
  const metadataStreamId = "fs:e1-t04-neutrality:main:meta";
  try {
    await putStream(baseUrl, metadataStreamId, "fs-meta");
    const baseline = bytes("stable baseline");
    const currentBase = await createBaseline(
      baseUrl,
      metadataStreamId,
      "fs:e1-t04-neutrality:main:file:1-fixed",
      "note.txt",
      baseline,
    );
    const otherBase = await createBaseline(
      baseUrl,
      metadataStreamId,
      "fs:e1-t04-neutrality:main:file:2-fixed",
      "other.txt",
      bytes("other"),
    );
    const logPath = streamLogPath(dataDir, metadataStreamId);
    const rows = [];
    const refusalCases = [
      ["stale-full-write", full("note.txt", BASE_NONE, "stale", 10)],
      ["stale-patch", patch("note.txt", BASE_NONE, baseline, bytes("stale patch"), 11)],
      ["base-none-existing", full("note.txt", BASE_NONE, "stale sentinel", 12)],
      ["foreign-path-base", patch("note.txt", otherBase, baseline, bytes("foreign"), 13)],
      ["future-offset", full("note.txt", "future-offset", "future", 14)],
    ];
    for (const [name, candidate] of refusalCases) {
      const before = await stateSnapshot(baseUrl, metadataStreamId);
      const diskBefore = readFileSync(logPath);
      const result = await dispatch(baseUrl, metadataStreamId, candidate);
      const after = await stateSnapshot(baseUrl, metadataStreamId);
      const diskAfter = readFileSync(logPath);
      if (result.response.status !== 409 || result.body.error.reason !== "stale-base") {
        throw new Error(`${name}: ${result.text}`);
      }
      if (
        before.dumpBody !== after.dumpBody ||
        before.head !== after.head ||
        before.count !== after.count ||
        before.treeDigest !== after.treeDigest
      ) {
        throw new Error(`${name}: metadata changed after refusal`);
      }
      if (!diskBefore.equals(diskAfter)) throw new Error(`${name}: file log changed after refusal`);
      rows.push(
        `${name} status=409 head=${before.head} count=${before.count} treeDigest=${before.treeDigest} diskLogSha256=${digest(diskBefore)} dumpBodySha256=${before.dumpSha256} neutral=yes`,
      );
    }
    const burstBefore = await stateSnapshot(baseUrl, metadataStreamId);
    const diskBefore = readFileSync(logPath);
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        dispatch(
          baseUrl,
          metadataStreamId,
          index % 2 === 0
            ? full("note.txt", BASE_NONE, `burst-${index}`, 30 + index)
            : patch("note.txt", BASE_NONE, baseline, bytes(`burst-${index}`), 30 + index),
        ),
      ),
    );
    const burstAfter = await stateSnapshot(baseUrl, metadataStreamId);
    const diskAfter = readFileSync(logPath);
    if (
      !burst.every(
        (result) => result.response.status === 409 && result.body.error.reason === "stale-base",
      )
    ) {
      throw new Error("stale burst did not produce ten 409 stale-base responses");
    }
    if (
      !diskBefore.equals(diskAfter) ||
      burstBefore.dumpBody !== burstAfter.dumpBody ||
      burstBefore.head !== burstAfter.head ||
      burstBefore.count !== burstAfter.count ||
      burstBefore.treeDigest !== burstAfter.treeDigest
    ) {
      throw new Error("stale burst changed a refusal surface");
    }
    rows.push(
      `burst-10 status=all-409 head=${burstBefore.head} count=${burstBefore.count} treeDigest=${burstBefore.treeDigest} diskLogSha256=${digest(diskBefore)} dumpBodySha256=${burstBefore.dumpSha256} rawDiskBytesEqual=yes rawDumpBodyBytesEqual=yes`,
    );
    writeFileSync(neutralityPath, `${rows.join("\n")}\n`);
  } finally {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function verifySensitivity() {
  const { server, baseUrl } = await startServer(new MemoryStreamStore(), {
    reducerRegistry: createStreamFsReducerRegistry(),
    actionValidators: createDefaultActionValidatorRegistry(),
  });
  const streamId = "fs:e1-t04-sabotage:main:meta";
  try {
    const created = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: canonicalJson({ type: "fs-meta", version: "fs-v2" }),
    });
    if (created.response.status !== 201)
      throw new Error(`sensitivity stream create: ${created.text}`);
    const create = await dispatch(
      baseUrl,
      streamId,
      action(
        "fs.file.create",
        { v: FS_EVENT_VERSION, path: "x.txt", contentStreamId: "sabotage:x" },
        1,
      ),
    );
    if (create.response.status !== 201) throw new Error(`sensitivity create: ${create.text}`);
    const baseline = await dispatch(baseUrl, streamId, full("x.txt", BASE_NONE, "baseline", 2));
    if (baseline.response.status !== 201) throw new Error(`sensitivity baseline: ${baseline.text}`);
    const sabotaged = await dispatch(
      baseUrl,
      streamId,
      full("x.txt", BASE_NONE, "should refuse", 3),
    );
    if (sabotaged.response.status === 409)
      throw new Error("fencing apparatus stayed green under no-fencing registry");
    writeFileSync(
      sensitivityPath,
      [
        "# E1-T04 sensitivity",
        "",
        "Sabotage: replaced the registered stream-fs validator registry with an isolated registry that has no fencing validator.",
        `stale full write status=${sabotaged.response.status} EXPECTED-FAIL OK`,
        "The stale-refusal measurement turns red (the sabotaged door accepts the stale action), proving the committed refusal assertions are sensitive to the fence.",
      ].join("\n") + "\n",
    );
  } finally {
    await stopServer(server);
  }
}

await verifyTwoWriterGolden();
await verifyRefusalNeutrality();
await verifySensitivity();
const goldenDigest = readFileSync(goldenDigestPath, "utf8").trim();
if (replayDigest(goldenPath) !== goldenDigest)
  throw new Error("two-writer golden replay digest drifted");
console.log(
  `streamfs fencing golden=${goldenDigest} refusal-neutrality=OK sensitivity=EXPECTED-FAIL OK`,
);
