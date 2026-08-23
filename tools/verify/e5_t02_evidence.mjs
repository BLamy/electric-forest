#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".eforest/tasks/epic-5-the-meadow/E5-T02-pr-event-model/evidence");
const cli = join(root, "packages/cli/dist/src/bin.js");
const worker = join(root, "tools/verify/e5_t02_replay_worker.mjs");
const digestPath = join(evidence, "e5-t02-digests.txt");
const refusalPath = join(evidence, "e5-t02-refusals.txt");
const seedPath = join(evidence, "e5-t02-seeds.txt");
const lifecycle = [
  {
    file: "e5-t02-lifecycle-closed.jsonl",
    types: ["pr.opened", "pr.approved", "pr.changes-requested", "pr.approved", "pr.closed"],
  },
  {
    file: "e5-t02-lifecycle-merged.jsonl",
    types: [
      "pr.opened",
      "pr.review-comment",
      "pr.changes-requested",
      "pr.review-comment",
      "pr.approved",
      "pr.merged",
    ],
  },
];
const refusalReasons = [
  "pr/first-event-must-be-opened",
  "pr/already-opened",
  "pr/unknown-branch",
  "pr/same-branch",
  "pr/fork-offset-out-of-range",
  "pr/merge-without-approval",
  "pr/terminal",
  "pr/duplicate-verdict",
  "pr/self-review",
  "pr/reply-to-unknown-comment",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runDigest(args, cwd, timezone) {
  const environment = { ...process.env, LANG: "C", TZ: timezone };
  delete environment.NODE_ENV;
  delete environment.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(
    result.status,
    0,
    `digest process failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(result.stderr, "", `digest process wrote stderr: ${args.join(" ")}`);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
  return result.stdout.trim();
}

const protectedPaths = [
  digestPath,
  refusalPath,
  seedPath,
  ...lifecycle.map(({ file }) => join(evidence, file)),
];
const beforeHashes = new Map(protectedPaths.map((path) => [path, sha256(path)]));
const expectedDigests = new Map(
  readFileSync(digestPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\S+) ([0-9a-f]{64})$/.exec(line);
      assert.ok(match, `malformed digest row: ${line}`);
      return [match[1], match[2]];
    }),
);
assert.equal(expectedDigests.size, 2, "digest evidence must name exactly two goldens");

for (const [index, golden] of lifecycle.entries()) {
  const path = join(evidence, golden.file);
  const contents = readFileSync(path, "utf8");
  assert.ok(contents.endsWith("\n"), `${golden.file}: missing trailing newline`);
  assert.ok(!contents.includes("\r"), `${golden.file}: CRLF is forbidden`);
  const records = contents
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.type),
    golden.types,
    `${golden.file}: event vocabulary/order drifted`,
  );
  assert.deepEqual(
    records.map((record) => record.offset),
    records.map((_, ordinal) => `0000000000000000_${String(ordinal).padStart(16, "0")}`),
    `${golden.file}: application offsets drifted`,
  );
  const expected = expectedDigests.get(golden.file);
  assert.ok(expected, `${golden.file}: committed digest is missing`);
  const streamId = `pr:maple/reading-room/evidence-${index}`;
  const observed = [
    runDigest([cli, "replay", path, "--digest"], tmpdir(), "Pacific/Kiritimati"),
    runDigest(
      [cli, "replay", path, "--digest", "--stream-id", streamId],
      join(root, "packages/pr"),
      "UTC",
    ),
    runDigest(
      [cli, "replay", path, "--digest", "--reducer", "pr", "--stream-id", streamId],
      tmpdir(),
      "America/New_York",
    ),
    runDigest([worker, path], tmpdir(), "Pacific/Kiritimati"),
    runDigest([worker, path], join(root, "packages/pr"), "UTC"),
  ];
  assert.deepEqual(
    observed,
    Array.from({ length: observed.length }, () => expected),
    `${golden.file}: process/cwd/TZ/reducer resolution changed the digest`,
  );
}

const refusalLines = readFileSync(refusalPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.length > 0);
assert.equal(refusalLines.length, refusalReasons.length, "refusal block count drifted");
const observedReasons = refusalLines.map((line) => {
  assert.ok(line.startsWith("E5_T02_REFUSAL "), "refusal line prefix drifted");
  const record = JSON.parse(line.slice("E5_T02_REFUSAL ".length));
  assert.equal(record.status, 409, `${record.reason}: HTTP status drifted`);
  const request = JSON.parse(record.requestBody);
  const response = JSON.parse(record.responseBody);
  assert.equal(request.event.type.startsWith("pr."), true, `${record.reason}: request drifted`);
  assert.deepEqual(response, {
    error: { class: "validator-rejected", reason: record.reason },
  });
  assert.deepEqual(record.after, record.before, `${record.reason}: refusal moved the log`);
  assert.match(record.before.digest, /^[0-9a-f]{64}$/);
  assert.match(record.before.dumpSha256, /^[0-9a-f]{64}$/);
  return record.reason;
});
assert.deepEqual(observedReasons, refusalReasons, "refusal reason order/vocabulary drifted");

const seeds = readFileSync(seedPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
assert.equal(new Set(seeds).size, seeds.length, "property seeds must be unique");
for (const seed of seeds) assert.match(seed, /^0x[0-9a-f]{8}$/);
assert.ok(seeds.length * 128 >= 500, "committed seeds cover fewer than 500 sequences");

for (const path of protectedPaths) {
  assert.equal(sha256(path), beforeHashes.get(path), `${path}: verifier rewrote evidence`);
}
console.log(
  `E5_T02_EVIDENCE_OK goldens=${lifecycle.length} digest-processes=${lifecycle.length * 5} refusal-blocks=${refusalLines.length} property-sequences=${seeds.length * 128}`,
);
