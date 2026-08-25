#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, "package.json"))) {
  const parent = dirname(root);
  assert.notEqual(parent, root, "repository root not found");
  root = parent;
}

const output = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
assert.ok(output, "usage: script.ts <empty-output-directory>");
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "output directory must be empty");

const platform = await import(
  pathToFileURL(join(root, "packages/platform/dist/src/index.js")).href
);
const serverPackage = await import(
  pathToFileURL(join(root, "packages/server/dist/src/index.js")).href
);
const issues = await import(pathToFileURL(join(root, "packages/issues/dist/src/index.js")).href);
const protocol = await import(
  pathToFileURL(join(root, "packages/protocol/dist/src/index.js")).href
);
const offsets = await import(
  pathToFileURL(join(root, "packages/protocol/dist/src/offset-allocation.js")).href
);

const { IssueBoardMaterializer, OfficialStreamAdapter, PlatformGateway, boardCachePath } = platform;
const { createDurableStreamTestServer } = serverPackage;
const { boardDigest, deriveBoard, repoIssuesStreamId, repoLabelsStreamId, replayIssueCatalog } =
  issues;
const { canonicalJson } = protocol;
const { offsetForOrdinal } = offsets;

const org = "maple";
const repo = "golden-board";
const dataDir = join(output, ".server");
const cacheDir = join(output, ".cache");
const logsDir = join(output, "logs");
await mkdir(logsDir, { recursive: true });

const durable = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
const baseUrl = await durable.start();
const streams = new OfficialStreamAdapter({ baseUrl });
const materializer = new IssueBoardMaterializer({ streams, cacheDir });
const gateway = new PlatformGateway({
  verifier: { verifyAuthorization: async () => ({ sub: "e5-t03-evidence" }) },
  streams,
  decideAuthorization: (input) => ({
    allowed: true,
    operation: input.operation,
    identityOffset: "-1",
    basis: "grant:write",
    streamId: "streamId" in input.target ? input.target.streamId : "",
  }),
  namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
  issueBoards: materializer,
});

const labelStream = repoLabelsStreamId(org, repo);
const catalogStream = repoIssuesStreamId(org, repo);
const issueStreams = Array.from(
  { length: 7 },
  (_, index) => `issue:${org}/${repo}/i-${String(index).padStart(2, "0")}`,
);

function event(type, payload, ts) {
  return { type, payload, ts };
}

async function dispatch(streamId, current) {
  const response = await gateway.handle(
    new Request("https://platform.test/api/dispatch", {
      method: "POST",
      headers: {
        authorization: "Bearer evidence",
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: JSON.stringify({ streamId, event: current }),
    }),
  );
  const source = await response.text();
  assert.equal(response.status, 202, source);
  const receipt = JSON.parse(source);
  assert.equal(typeof receipt.offset, "string");
  return receipt.offset;
}

async function dispatchNamespace(streamId, current) {
  const response = await gateway.handle(
    new Request("https://platform.test/api/dispatch", {
      method: "POST",
      headers: { authorization: "Bearer evidence", "content-type": "application/json" },
      body: JSON.stringify({ streamId, event: current }),
    }),
  );
  const source = await response.text();
  assert.equal(response.status, 202, source);
}

async function endpoint() {
  const response = await gateway.handle(
    new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
      headers: { authorization: "Bearer evidence" },
    }),
  );
  const source = await response.text();
  assert.equal(response.status, 200, source);
  assert.equal(source, canonicalJson(JSON.parse(source)), "endpoint must emit canonical JSON");
  const body = JSON.parse(source);
  assert.deepEqual(Object.keys(body).sort(), ["board", "digest", "provenance"]);
  assert.equal(body.digest, boardDigest(body.board));
  return body;
}

async function writeJsonl(path, records) {
  await writeFile(path, `${records.map((record) => canonicalJson(record)).join("\n")}\n`, "utf8");
}

async function assertProvenanceAtHeads(body) {
  const expectedStreams = [catalogStream, labelStream, ...issueStreams].sort();
  assert.deepEqual(
    body.provenance.inputs.map((input) => input.streamId),
    expectedStreams,
  );
  for (const input of body.provenance.inputs) {
    const records = await streams.read(input.streamId);
    const expected = records.length === 0 ? "-1" : offsetForOrdinal(records.length - 1);
    assert.equal(input.offset, expected, `${input.streamId}: stale provenance`);
  }
}

let ts = 1;
try {
  await dispatchNamespace("ns:root", event("ns.org.create", { v: 1, name: org }, 1));
  await dispatchNamespace(`ns:org:${org}`, event("ns.project.create", { v: 1, name: "meadow" }, 2));
  await dispatchNamespace(
    `ns:org:${org}`,
    event("ns.repo.create", { v: 1, name: repo, project: "meadow", visibility: "public" }, 3),
  );
  await streams.create(labelStream);
  for (const issueStream of issueStreams) await streams.create(issueStream);

  await dispatch(
    labelStream,
    event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "#d73a4a" }, ts++),
  );
  await dispatch(
    labelStream,
    event("label.created", { v: 1, labelId: "docs", name: "Docs", color: "#0075ca" }, ts++),
  );
  await dispatch(
    labelStream,
    event("label.created", { v: 1, labelId: "priority", name: "Priority", color: "#b60205" }, ts++),
  );
  for (const [index, streamId] of issueStreams.entries()) {
    await dispatch(
      streamId,
      event("issue.opened", { v: 1, title: `Golden issue ${index}`, body: "" }, ts++),
    );
  }
  for (const [index, labelId] of [
    [0, "bug"],
    [1, "bug"],
    [2, "docs"],
    [3, "priority"],
    [4, "docs"],
  ]) {
    await dispatch(issueStreams[index], event("issue.labeled", { v: 1, label: labelId }, ts++));
  }
  await dispatch(issueStreams[3], event("issue.unlabeled", { v: 1, label: "priority" }, ts++));
  await dispatch(issueStreams[3], event("issue.labeled", { v: 1, label: "bug" }, ts++));
  await dispatch(
    labelStream,
    event("label.renamed", { v: 1, labelId: "bug", name: "Defect" }, ts++),
  );
  await dispatch(
    labelStream,
    event("label.recolored", { v: 1, labelId: "docs", color: "#5319e7" }, ts++),
  );
  await dispatch(issueStreams[1], event("issue.state-changed", { v: 1, to: "in-progress" }, ts++));
  await dispatch(issueStreams[2], event("issue.state-changed", { v: 1, to: "done" }, ts++));
  await dispatch(issueStreams[3], event("issue.closed", { v: 1 }, ts++));
  await dispatch(issueStreams[4], event("issue.state-changed", { v: 1, to: "wont-do" }, ts++));
  await dispatch(issueStreams[6], event("issue.state-changed", { v: 1, to: "in-progress" }, ts++));
  await dispatch(issueStreams[6], event("issue.state-changed", { v: 1, to: "done" }, ts++));

  assert.deepEqual(materializer.materializationActivity(org, repo), {
    coldRebuilds: 1,
    incrementalUpdates: 24,
  });
  const before = await endpoint();
  await assertProvenanceAtHeads(before);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(before.board.columns).map(([state, column]) => [state, column.count]),
    ),
    { open: 2, "in-progress": 1, done: 2, closed: 1, "wont-do": 1 },
  );
  await writeFile(join(output, "board.json"), `${canonicalJson(before.board)}\n`, "utf8");
  await writeFile(join(output, "board.digest"), `${before.digest}\n`, "utf8");

  const catalogRecords = await streams.read(catalogStream);
  const labelRecords = await streams.read(labelStream);
  const catalog = replayIssueCatalog(catalogStream, catalogRecords);
  assert.deepEqual(Object.keys(catalog.issues).sort(), [...issueStreams].sort());
  await writeJsonl(join(logsDir, "repo-issues.jsonl"), catalogRecords);
  await writeJsonl(join(logsDir, "repo-labels.jsonl"), labelRecords);
  await writeJsonl(join(logsDir, "ns-root.jsonl"), await streams.read("ns:root"));
  await writeJsonl(join(logsDir, "ns-org-maple.jsonl"), await streams.read(`ns:org:${org}`));
  const issueLogs = [];
  for (const [index, streamId] of issueStreams.entries()) {
    const records = await streams.read(streamId);
    issueLogs.push({ streamId, events: records });
    await writeJsonl(join(logsDir, `issue-i-${String(index).padStart(2, "0")}.jsonl`), records);
  }

  const foldDigests = [
    issueLogs,
    [...issueLogs].reverse(),
    [...issueLogs.slice(3), ...issueLogs.slice(0, 3)],
  ].map((logs) => boardDigest(deriveBoard(labelRecords, logs)));
  assert.deepEqual(foldDigests, [before.digest, before.digest, before.digest]);
  console.log(`FOLD digest=${before.digest} permutations=3 identical OK`);

  materializer.dropMaterializedCopy(org, repo);
  await rm(boardCachePath(cacheDir, org, repo));
  const rebuilt = await endpoint();
  await assertProvenanceAtHeads(rebuilt);
  assert.equal(rebuilt.digest, before.digest);
  assert.equal(canonicalJson(rebuilt.board), canonicalJson(before.board));
  console.log(`REBUILD digest=${rebuilt.digest} identical OK`);

  const changed = event("issue.state-changed", { v: 1, to: "in-progress" }, ts++);
  const changedStream = issueStreams[0];
  const activityBeforeLive = materializer.materializationActivity(org, repo);
  const changedOffset = await dispatch(changedStream, changed);
  const liveCopy = materializer.materializedCopy(org, repo);
  const activityAfterLive = materializer.materializationActivity(org, repo);
  assert.deepEqual(activityAfterLive, {
    coldRebuilds: activityBeforeLive.coldRebuilds,
    incrementalUpdates: activityBeforeLive.incrementalUpdates + 1,
  });
  assert.ok(liveCopy, "post-append hook did not maintain the in-memory board copy");
  assert.equal(
    liveCopy.provenance.inputs.find((input) => input.streamId === changedStream)?.offset,
    changedOffset,
    "materialized copy did not consume the accepted issue offset",
  );
  assert.notEqual(liveCopy.digest, before.digest);
  const after = await endpoint();
  await assertProvenanceAtHeads(after);
  assert.notEqual(after.digest, before.digest);
  assert.equal(after.digest, liveCopy.digest);
  assert.equal(
    after.provenance.inputs.find((input) => input.streamId === changedStream)?.offset,
    changedOffset,
  );
  await writeFile(join(output, "after-state-change.digest"), `${after.digest}\n`, "utf8");
  await writeFile(
    join(output, "live-update.txt"),
    [
      `pre-digest ${before.digest}`,
      `event ${canonicalJson(changed)}`,
      `stream ${changedStream}`,
      `offset ${changedOffset}`,
      `cold-rebuilds ${activityAfterLive.coldRebuilds}`,
      `incremental-updates ${activityAfterLive.incrementalUpdates}`,
      `post-digest ${after.digest}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`LIVE offset=${changedOffset} digest=${after.digest} OK`);
} finally {
  gateway.terminate();
  await durable.stop();
}
