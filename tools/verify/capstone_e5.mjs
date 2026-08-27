#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const fixture = resolve(root, "packages/cli/fixtures/sessions/issue-to-merge");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const dumpPath = (stream) => resolve(fixture, `${encodeURIComponent(stream)}.events.jsonl`);
const readDump = (stream) =>
  readFileSync(dumpPath(stream), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const expected = readJson(resolve(fixture, "expected.json"));
const streams = Object.freeze({
  issue: "issue:maple/reading-room/negotiation",
  pr: "pr:maple/reading-room/negotiation",
  branch: "fs:maple/reading-room:feature-negotiation:meta",
  main: "fs:maple/reading-room:main:meta",
  wiki: "fs:maple/reading-room:wiki:meta",
  evidence: "evidence:maple/reading-room/pr/negotiation",
  content: "evidence-content:maple/reading-room/session-log",
});

const dumps = Object.fromEntries(
  Object.entries(streams).map(([role, stream]) => [role, readDump(stream)]),
);

function one(records, predicate, description) {
  const matches = records.filter(predicate);
  assert.equal(matches.length, 1, `${description}: expected one record, found ${matches.length}`);
  return matches[0];
}

function verifyClose(issueRecords = dumps.issue) {
  const merged = one(dumps.pr, (record) => record.type === "pr.merged", "merged PR event");
  const done = one(
    issueRecords,
    (record) => record.type === "issue.state-changed" && record.payload?.to === "done",
    "merge-driven done transition",
  );
  assert.equal(done.payload?.via?.prStream, streams.pr, "done transition must cite the PR stream");
  assert.equal(
    done.payload?.via?.prMergedOffset,
    merged.offset,
    "done transition must cite the exact opaque merge offset",
  );
  assert.equal(
    issueRecords.filter((record) => record.type === "issue.closed").length,
    0,
    "manual issue close events are forbidden",
  );
  return { done, merged };
}

function attachmentBytes(contentRecords = dumps.content) {
  const chunks = contentRecords
    .filter((record) => record.type === "content.chunk")
    .sort((left, right) => left.payload.seq - right.payload.seq)
    .map((record) => Buffer.from(record.payload.bytes, "base64"));
  return Buffer.concat(chunks);
}

function verifyAttachment(contentRecords = dumps.content) {
  const bytes = attachmentBytes(contentRecords);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sealed = one(
    contentRecords,
    (record) => record.type === "content.sealed",
    "sealed content",
  );
  const attached = one(
    dumps.evidence,
    (record) => record.type === "evidence.attached",
    "attachment",
  );
  assert.equal(sealed.payload.sha256, digest, "sealed content hash must match replayed bytes");
  assert.equal(attached.payload.sha256, digest, "attachment hash must match replayed bytes");
  assert.equal(
    attached.payload.contentStream,
    streams.content,
    "attachment must cite its content stream",
  );
  assert.equal(
    attached.payload.size,
    bytes.byteLength,
    "attachment size must match replayed bytes",
  );
  return { digest, bytes };
}

const opened = one(dumps.pr, (record) => record.type === "pr.opened", "opened PR event");
assert.deepEqual(opened.payload.closes, [{ entity: "issue", stream: streams.issue }]);
const fork = one(dumps.branch, (record) => record.type === "fs.branch.fork", "branch fork event");
const mainHead = dumps.main.at(-1)?.offset;
assert.equal(fork.payload.parentStreamId, streams.main, "fix branch must fork main");
assert.equal(
  fork.payload.forkOffset,
  mainHead,
  "fork point must resolve to the committed main dump",
);

const { done, merged } = verifyClose();
const { digest: attachmentDigest, bytes: attachment } = verifyAttachment();
const wikiWrite = one(dumps.wiki, (record) => record.type === "fs.file.write", "wiki edit");

const cli = spawnSync(
  process.execPath,
  [resolve(root, "packages/cli/dist/src/bin.js"), "replay", "--session", fixture],
  { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 },
);
assert.equal(cli.status, 0, `E5-T12 session replay failed:\n${cli.stdout}\n${cli.stderr}`);
const composite = /^COMPOSITE digest=([a-f0-9]{64})$/m.exec(cli.stdout)?.[1];
assert.equal(composite, expected.composite, "session replay must reproduce the promoted composite");

const steps = [
  ["issue-filed", dumps.issue[0]],
  ["issue-in-progress", dumps.issue[2]],
  ["branch-forked", dumps.branch[0]],
  ["fix-landed", dumps.branch.at(-1)],
  ["pr-opened", dumps.pr[0]],
  ["review-commented", dumps.pr[1]],
  ["pr-approved", dumps.pr[2]],
  ["pr-merged", merged],
  ["evidence-attached", dumps.evidence[0]],
  ["wiki-edited", wikiWrite],
];
for (const [index, [name, record]] of steps.entries()) {
  assert.ok(record?.offset, `${name} must resolve to a committed event`);
  process.stdout.write(`STEP n=${index + 1} name=${name} offset=${record.offset} replayed OK\n`);
}

process.stdout.write(`COMPOSITE digest=${composite} promoted=${expected.composite} OK\n`);
process.stdout.write(
  `CLOSE offset=${done.offset} via=${done.payload.via.prMergedOffset} count=1 OK\n`,
);
process.stdout.write(
  `ATTACH sha256=${attachmentDigest} bytes=${attachment.byteLength} replayed OK\n`,
);
process.stdout.write(`WIKI offset=${wikiWrite.offset} replayed OK\n`);
process.stdout.write(
  `FORK parent=${fork.payload.parentStreamId} offset=${fork.payload.forkOffset} main=${mainHead} OK\n`,
);

const closeMutation = structuredClone(dumps.issue);
closeMutation.at(-1).payload.via.prMergedOffset = "0000000000000000_0000000000009999";
assert.throws(() => verifyClose(closeMutation), /exact opaque merge offset/);
process.stdout.write("CLOSE-OFFSET EXPECTED-FAIL OK\n");

const contentMutation = structuredClone(dumps.content);
contentMutation[0].payload.bytes = Buffer.from("mutated evidence\n").toString("base64");
assert.throws(() => verifyAttachment(contentMutation), /hash must match replayed bytes/);
process.stdout.write("ATTACH-BYTE EXPECTED-FAIL OK\n");

process.stdout.write("E5_T13_STREAM_COMPOSITION_OK scope=promoted-golden browser=not-rerun\n");
