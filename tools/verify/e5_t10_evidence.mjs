#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_REFUSAL_REASONS,
  attachmentInitialStateForStream,
  attachmentReducer,
  contentBytes,
  contentInitialStateForStream,
  contentReducer,
  decodeCanonicalBase64,
  encodeCanonicalBase64,
} from "../../packages/evidence/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T10-evidence-attachment-model/evidence",
);
const worker = join(root, "tools/verify/e5_t10_replay_worker.mjs");
const digestPath = join(evidence, "e5-t10-digests.txt");
const protectedNames = [
  "e5-t10-attachments.jsonl",
  "e5-t10-authz.txt",
  "e5-t10-boundaries.txt",
  "e5-t10-concurrency.txt",
  "e5-t10-content.jsonl",
  "e5-t10-digests.txt",
  "e5-t10-lifecycle.txt",
  "e5-t10-lying-seal.jsonl",
  "e5-t10-property.txt",
  "e5-t10-refusals.txt",
  "e5-t10-roundtrip.txt",
  "e5-t10-sensitivity.md",
  "e5-t10-source.jsonl",
];
const protectedPaths = protectedNames.map((name) => join(evidence, name));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readCanonicalEvents(path) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.endsWith("\n"), `${path}: missing trailing newline`);
  assert.ok(!source.includes("\r"), `${path}: CRLF is forbidden`);
  return source
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      const parsed = JSON.parse(line);
      assert.equal(canonicalJson(parsed), line, `${path}:${index + 1}: non-canonical JSON`);
      return parsed;
    });
}

function runWorker(kind, path, streamId, cwd, timezone) {
  const environment = { ...process.env, LANG: "C", TZ: timezone };
  delete environment.NODE_ENV;
  delete environment.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [worker, kind, path, streamId], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(result.status, 0, `${path}: replay failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${path}: replay wrote stderr`);
  const output = JSON.parse(result.stdout);
  assert.match(output.digest, /^[0-9a-f]{64}$/);
  return output;
}

function canonicalDump(events) {
  return `${events.map(canonicalJson).join("\n")}\n`;
}

const beforeHashes = new Map(protectedPaths.map((path) => [path, sha256(path)]));
const digestRows = readFileSync(digestPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split(" "));
const expected = new Map(digestRows);
const goldens = [
  {
    name: "e5-t10-attachments.jsonl",
    kind: "evidence",
    streamId: "evidence:maple/reading-room/issue/e5-t10-golden",
  },
  {
    name: "e5-t10-content.jsonl",
    kind: "evidence-content",
    streamId: "evidence-content:maple/reading-room/issue-golden",
  },
  {
    name: "e5-t10-lying-seal.jsonl",
    kind: "evidence-content",
    streamId: "evidence-content:maple/reading-room/lying-seal",
  },
];
const results = new Map();
for (const golden of goldens) {
  const path = join(evidence, golden.name);
  const one = runWorker(golden.kind, path, golden.streamId, tmpdir(), "Pacific/Kiritimati");
  const two = runWorker(golden.kind, path, golden.streamId, root, "UTC");
  assert.equal(one.digest, two.digest, `${golden.name}: separate replay processes diverged`);
  assert.equal(one.digest, expected.get(golden.name), `${golden.name}: committed digest drifted`);
  results.set(golden.name, one);
}
const attachmentResult = results.get("e5-t10-attachments.jsonl");
assert.equal(attachmentResult.state.attachments.length, 2);
assert.equal(attachmentResult.state.attachments[0].detachedAtOffset, "0000000000000000_0000000000000002");
assert.equal(attachmentResult.state.attachments[1].type, "reference");
assert.equal("sha256" in attachmentResult.state.attachments[1], false);
assert.equal("contentStream" in attachmentResult.state.attachments[1], false);
const contentResult = results.get("e5-t10-content.jsonl");
assert.deepEqual(
  {
    sealed: contentResult.state.sealed,
    sealError: contentResult.state.sealError,
    size: contentResult.state.size,
    chunks: contentResult.state.chunks,
  },
  { sealed: true, sealError: undefined, size: 802, chunks: 1 },
);
const lyingResult = results.get("e5-t10-lying-seal.jsonl");
assert.deepEqual(
  {
    sealed: lyingResult.state.sealed,
    sealError: lyingResult.state.sealError,
    size: lyingResult.state.size,
    chunks: lyingResult.state.chunks,
    sha256: lyingResult.state.sha256,
  },
  {
    sealed: false,
    sealError: "digest-mismatch",
    size: 3,
    chunks: 1,
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  },
);

const sourcePath = join(evidence, "e5-t10-source.jsonl");
const sourceBytes = readFileSync(sourcePath);
assert.equal(sourceBytes.byteLength, Number(expected.get("source-size")));
assert.equal(sha256(sourcePath), expected.get("source-sha256"));
const contentEvents = readCanonicalEvents(join(evidence, "e5-t10-content.jsonl"));
const contentState = contentEvents.reduce(
  contentReducer,
  contentInitialStateForStream("evidence-content:maple/reading-room/issue-golden"),
);
assert.equal(contentState.sealed, true);
assert.deepEqual(Buffer.from(contentBytes(contentState)), sourceBytes);
const contentSeal = contentEvents.at(-1).payload;
const attachmentEvents = readCanonicalEvents(join(evidence, "e5-t10-attachments.jsonl"));
const attachmentState = attachmentEvents.reduce(
  attachmentReducer,
  attachmentInitialStateForStream("evidence:maple/reading-room/issue/e5-t10-golden"),
);
const contentAttachment = attachmentState.attachments[0];
const roundtrip = [
  "source=e5-t10-source.jsonl",
  "content=e5-t10-content.jsonl",
  "attachment=e5-t10-attachments.jsonl",
  `source-bytes=${sourceBytes.byteLength}`,
  `chunks=${contentState.chunks}`,
  `source-sha256=${sha256(sourcePath)}`,
  `seal-sha256=${contentSeal.sha256}`,
  `attachment-sha256=${contentAttachment.sha256}`,
  `reducer-sha256=${contentState.sha256}`,
  "cmp=0",
  "digest-chain=equal",
  "",
].join("\n");
assert.equal(roundtrip, readFileSync(join(evidence, "e5-t10-roundtrip.txt"), "utf8"));
assert.equal(contentSeal.sha256, sha256(sourcePath));
assert.equal(contentAttachment.sha256, sha256(sourcePath));
assert.equal(contentState.sha256, sha256(sourcePath));

const refusalLines = readFileSync(join(evidence, "e5-t10-refusals.txt"), "utf8")
  .trim()
  .split("\n");
assert.equal(refusalLines.length, 14, "refusal transcript must contain fourteen blocks");
const refusalReasons = refusalLines.map((line) => {
  assert.ok(line.startsWith("E5_T10_REFUSAL "));
  const record = JSON.parse(line.slice("E5_T10_REFUSAL ".length));
  assert.equal(record.status, 409);
  assert.deepEqual(JSON.parse(record.responseBody), {
    error: { class: "validator-rejected", reason: record.reason },
  });
  assert.deepEqual(record.after, record.before, `${record.reason}: refusal moved a watched log`);
  assert.equal(typeof JSON.parse(record.requestBody).streamId, "string");
  for (const stream of record.before) {
    assert.match(stream.dumpSha256, /^[0-9a-f]{64}$/);
    assert.match(stream.headOffset, /^(?:-1|[0-9]{16}_[0-9]{16})$/);
  }
  return record.reason;
});
assert.deepEqual(refusalReasons, EVIDENCE_REFUSAL_REASONS);

const propertyLines = readFileSync(join(evidence, "e5-t10-property.txt"), "utf8")
  .trim()
  .split("\n");
const seeds = propertyLines.filter((line) => line.startsWith("seed="));
const casesPerSeed = Number(
  propertyLines.find((line) => line.startsWith("cases-per-seed="))?.split("=")[1],
);
const totalCases = Number(
  propertyLines.find((line) => line.startsWith("total-cases="))?.split("=")[1],
);
assert.equal(seeds.length * casesPerSeed, totalCases);
assert.ok(totalCases >= 500);
assert.equal(new Set(seeds).size, seeds.length);

const authz = readFileSync(join(evidence, "e5-t10-authz.txt"), "utf8");
assert.equal((authz.match(/ log-neutral=true/g) ?? []).length, 6);
assert.match(authz, /credential=missing status=401 reason=missing_bearer_token/);
assert.match(authz, /credential=no-scope status=403 reason=authz\/write-grant-required/);
assert.match(authz, /credential=wrong-branch status=403 reason=authz\/write-grant-required/);
const lifecycle = readFileSync(join(evidence, "e5-t10-lifecycle.txt"), "utf8");
assert.match(lifecycle, /issue-source=.* lifecycle=opened .* unchanged=true/);
assert.match(lifecycle, /pr-source=.* lifecycle=opened,approved,merged status=merged .* unchanged=true/);
assert.match(lifecycle, /issue-evidence=.* entries=2 content=1 references=1 .* byte-parity=true/);
assert.match(lifecycle, /pr-evidence=.* entries=2 content=1 references=1 .* byte-parity=true/);
assert.match(lifecycle, /reference-events=2 exact-roundtrip=true bytes-fields=absent/);
assert.match(lifecycle, /committed-issue-goldens=fresh-dispatch-byte-equal/);
assert.match(lifecycle, /source-entity-logs-moved=0/);
const boundaries = readFileSync(join(evidence, "e5-t10-boundaries.txt"), "utf8");
assert.match(boundaries, /exact-chunk=524288 status=202/);
assert.match(boundaries, /over-chunk=524289 status=409 .* log-neutral=true/);
assert.match(boundaries, /exact-total=16777216 chunks=32 sealed=true/);
assert.match(boundaries, /over-total=16777217 status=409 .* log-neutral=true/);
const concurrency = readFileSync(join(evidence, "e5-t10-concurrency.txt"), "utf8");
assert.match(concurrency, /race-runs=16/);
assert.match(concurrency, /accepted-total=48/);
assert.match(concurrency, /refused-total=48/);
assert.match(concurrency, /illegal-logs=0/);

const temporary = mkdtempSync(join(tmpdir(), "eforest-e5-t10-mutation-"));
try {
  const mutatedContent = structuredClone(contentEvents);
  const originalChunk = decodeCanonicalBase64(mutatedContent[0].payload.bytes);
  assert.ok(originalChunk && originalChunk.byteLength > 0);
  const changedChunk = originalChunk.slice();
  changedChunk[0] ^= 0x01;
  mutatedContent[0].payload.bytes = encodeCanonicalBase64(changedChunk);
  const mutatedContentPath = join(temporary, "content.jsonl");
  writeFileSync(mutatedContentPath, canonicalDump(mutatedContent));
  const mutatedContentResult = runWorker(
    "evidence-content",
    mutatedContentPath,
    "evidence-content:maple/reading-room/issue-golden",
    temporary,
    "UTC",
  );
  assert.notEqual(mutatedContentResult.digest, expected.get("e5-t10-content.jsonl"));
  assert.equal(mutatedContentResult.state.sealed, false);
  assert.equal(mutatedContentResult.state.sealError, "digest-mismatch");
  assert.notEqual(mutatedContentResult.state.sha256, contentSeal.sha256);
  console.log("MUTATION fixture=e5-t10-content byte=0 digest-mismatch EXPECTED-FAIL OK");

  const mutatedAttachments = structuredClone(attachmentEvents);
  mutatedAttachments[1].payload.title = "Browser proog";
  const mutatedAttachmentPath = join(temporary, "attachments.jsonl");
  writeFileSync(mutatedAttachmentPath, canonicalDump(mutatedAttachments));
  const mutatedAttachmentResult = runWorker(
    "evidence",
    mutatedAttachmentPath,
    "evidence:maple/reading-room/issue/e5-t10-golden",
    temporary,
    "UTC",
  );
  assert.notEqual(mutatedAttachmentResult.digest, expected.get("e5-t10-attachments.jsonl"));
  console.log(
    "MUTATION fixture=e5-t10-attachments byte=reference-title digest-mismatch EXPECTED-FAIL OK",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

for (const path of protectedPaths) {
  assert.equal(sha256(path), beforeHashes.get(path), `${path}: verifier rewrote committed evidence`);
}
console.log(
  `E5_T10_EVIDENCE_OK goldens=${goldens.length} digest-processes=${goldens.length * 2} refusal-blocks=${refusalLines.length} property-cases=${totalCases} roundtrip-bytes=${sourceBytes.byteLength}`,
);
