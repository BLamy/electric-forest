#!/usr/bin/env node
// verify-E6-T01: dump the frozen task log, replay it in independent processes to the
// committed tasks/v1 digest, hold every refusal transcript to byte-identical head and
// dump, replay the 1,000-sequence property corpus in two fresh processes, and prove
// the apparatus is sensitive to a one-byte mutation of every frozen event kind.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import {
  TASK_REFUSAL_REASONS,
  replayTaskLog,
  taskInitialStateForStream,
  validateTaskEvent,
} from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".eforest/tasks/epic-6-the-loop/E6-T01-task-event-model/evidence");
const ef = join(root, "packages/cli/dist/src/bin.js");
const streamId = "issue:maple/reading-room/E6-T01-golden";
const protectedNames = [
  "e6-t01-task.jsonl",
  "e6-t01-task.state.json",
  "e6-t01-task.digest",
  "e6-t01-invalid.jsonl",
  "e6-t01-refusals.txt",
  "e6-t01-property.txt",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = (name) => join(evidence, name);
const before = new Map(protectedNames.map((name) => [name, sha256(readFileSync(artifact(name)))]));

function readCanonicalJsonl(name) {
  const source = readFileSync(artifact(name), "utf8");
  assert.ok(source.endsWith("\n"), `${name}: missing trailing newline`);
  assert.ok(!source.includes("\r"), `${name}: CRLF forbidden`);
  return source
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      const parsed = JSON.parse(line);
      assert.equal(canonicalJson(parsed), line, `${name}:${index + 1}: non-canonical JSON`);
      return parsed;
    });
}

function freshProcess(args, cwd, timezone) {
  const env = { ...process.env, LANG: "C", TZ: timezone };
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${args.join(" ")} wrote stderr`);
  return result.stdout;
}

function cliDigest(path, cwd, timezone) {
  const digest = freshProcess(
    [ef, "replay", path, "--digest", "--reducer", "tasks/v1", "--stream-id", streamId],
    cwd,
    timezone,
  ).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  return digest;
}

// 1. Task-log dump + canonical digest.
const log = readCanonicalJsonl("e6-t01-task.jsonl");
const expectedDigest = readFileSync(artifact("e6-t01-task.digest"), "utf8").trim();
assert.match(expectedDigest, /^[0-9a-f]{64}$/);
console.log(`E6_T01_TASK_LOG stream=${streamId} events=${log.length}`);
for (const record of log) console.log(`  ${record.offset} ${record.type}`);
const state = replayTaskLog(streamId, log);
assert.equal(canonicalJson(state), readFileSync(artifact("e6-t01-task.state.json"), "utf8").trim());
assert.equal(stateDigest(state), expectedDigest);
assert.equal(state.status, "verified");
assert.equal(state.attempts.length, 2);
assert.equal(state.verification.claim, log[8].offset);
assert.equal(state.attempts[1].claim.offset, log[8].offset);
assert.equal(state.verification.critic.run, log[9].payload.by.run);
assert.equal(state.attempts[0].verdict.findings.length, 2);
assert.ok(
  log.every(
    (record, index) => record.offset === `0000000000000000_${String(index).padStart(16, "0")}`,
  ),
);
console.log(`E6_T01_DIGEST ${expectedDigest}`);

// 2. Two independent replay processes (foreign cwd + time zone vs repository cwd).
const scratch = mkdtempSync(join(tmpdir(), "e6-t01-"));
try {
  const one = cliDigest(artifact("e6-t01-task.jsonl"), scratch, "Pacific/Kiritimati");
  const two = cliDigest(artifact("e6-t01-task.jsonl"), join(root, "packages/tasks"), "UTC");
  assert.equal(one, expectedDigest, "process one digest");
  assert.equal(two, expectedDigest, "process two digest");
  assert.equal(one, two);
  console.log(`E6_T01_REPLAY processes=2 digest=${one} byte-identical=true`);

  // 3. Refusal transcripts: every refusal left head and dump untouched.
  const transcript = readFileSync(artifact("e6-t01-refusals.txt"), "utf8");
  assert.ok(transcript.endsWith("\n"));
  const refusals = transcript
    .trimEnd()
    .split("\n")
    .map((line) => {
      assert.ok(line.startsWith("E6_T01_REFUSAL "), "transcript line prefix");
      return JSON.parse(line.slice("E6_T01_REFUSAL ".length));
    });
  const invalid = readCanonicalJsonl("e6-t01-invalid.jsonl");
  assert.deepEqual(
    refusals.map((entry) => entry.name),
    invalid.map((entry) => entry.name),
    "transcript covers the frozen invalid fixture in order",
  );
  const reasonsSeen = new Set();
  for (const [index, entry] of refusals.entries()) {
    assert.deepEqual(entry.after, entry.before, `${entry.name}: head/dump moved`);
    assert.equal(entry.after.streamId, entry.streamId);
    const expected = invalid[index].expect;
    const body = JSON.parse(entry.responseBody);
    if (expected.class === "validator-rejected") {
      assert.equal(entry.status, 409, entry.name);
      assert.deepEqual(body, { error: { class: "validator-rejected", reason: expected.reason } });
      reasonsSeen.add(expected.reason);
    } else if (expected.class === "schema-violation") {
      assert.equal(entry.status, 422, entry.name);
      assert.deepEqual(body, { error: { class: "schema-violation" } });
    } else {
      assert.equal(entry.status, 404, entry.name);
      assert.deepEqual(body, { error: { class: "unknown-action-type" } });
    }
  }
  for (const reason of TASK_REFUSAL_REASONS)
    assert.ok(reasonsSeen.has(reason), `uncovered ${reason}`);
  const builderVerifies = refusals.find((entry) => entry.name === "builder-verifies");
  assert.equal(JSON.parse(builderVerifies.responseBody).error.reason, "task/wrong-role");
  // The frozen invalid fixture is re-executed here against the pure validator too.
  for (const scenario of invalid) {
    const prefix = log.slice(0, scenario.prefix);
    const current = replayTaskLog(streamId, prefix);
    let refused;
    try {
      await validateTaskEvent(scenario.event, {
        streamId,
        state: current,
        headOffset: prefix.at(-1)?.offset ?? "-1",
        nextOffset: `0000000000000000_${String(prefix.length).padStart(16, "0")}`,
        records: prefix,
        actor: scenario.actor,
        resolveStream: async () => undefined,
      });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused !== undefined, `${scenario.name}: pure validator accepted`);
    if (scenario.expect.class === "validator-rejected" && scenario.name !== "unknown-attachment") {
      assert.equal(refused.reason, scenario.expect.reason, scenario.name);
    }
  }
  console.log(
    `E6_T01_REFUSALS blocks=${refusals.length} reasons=${reasonsSeen.size} head-and-dump-identical=true`,
  );

  // 4. Property corpus in two fresh processes.
  const property = readFileSync(artifact("e6-t01-property.txt"), "utf8");
  const corpusDigest = property
    .split("\n")
    .find((line) => line.startsWith("corpus-sha256="))
    .slice("corpus-sha256=".length);
  const runner = join(root, "tools/verify/e6_t01_property.mjs");
  const first = freshProcess([runner], scratch, "Pacific/Kiritimati");
  const second = freshProcess([runner], join(root, "packages/tasks"), "UTC");
  assert.equal(first, second, "property corpus differs between fresh processes");
  assert.equal(first.trimEnd().split("\n").length, 1000);
  assert.equal(sha256(first), corpusDigest, "property corpus digest drifted from the frozen value");
  console.log(
    `E6_T01_PROPERTY cases=1000 processes=2 corpus-sha256=${corpusDigest} byte-identical=true`,
  );

  // 5. One-byte mutation of every frozen event kind must change the digest or fail validation.
  const targets = {
    "issue.opened": ["title"],
    "issue.labeled": ["label"],
    "issue.commented": ["body"],
    "task.started": ["by", "run"],
    "task.claimed": ["summary"],
    "task.refuted": ["findings", 0, "fingerprint"],
    "task.rework-started": ["by", "actor"],
    "task.verified": ["summary"],
  };
  const kinds = new Map();
  for (const [index, record] of log.entries())
    if (!kinds.has(record.type)) kinds.set(record.type, index);
  assert.deepEqual(
    [...kinds.keys()].sort(),
    Object.keys(targets).sort(),
    "every frozen kind has a target",
  );
  let sentinels = 0;
  for (const [type, index] of kinds) {
    const lines = readFileSync(artifact("e6-t01-task.jsonl"), "utf8").slice(0, -1).split("\n");
    const record = JSON.parse(lines[index]);
    const path = targets[type];
    let holder = record.payload;
    for (const key of path.slice(0, -1)) holder = holder[key];
    const key = path.at(-1);
    const value = holder[key];
    assert.equal(typeof value, "string");
    const byte = value.charCodeAt(0);
    holder[key] = `${String.fromCharCode(byte === 0x7a ? 0x79 : byte + 1)}${value.slice(1)}`;
    const mutated = canonicalJson(record);
    assert.equal(mutated.length, lines[index].length, "exactly one byte differs");
    assert.equal([...mutated].filter((char, at) => char !== lines[index][at]).length, 1);
    lines[index] = mutated;
    const file = join(scratch, `mutated-${index}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const digest = cliDigest(file, scratch, "UTC");
    assert.notEqual(digest, expectedDigest, `${type}: one-byte mutation left the digest unchanged`);
    sentinels += 1;
    console.log(
      `MUTATION kind=${type} offset=${log[index].offset} field=${path.join(".")} digest-mismatch EXPECTED-FAIL OK`,
    );
  }
  assert.equal(sentinels, kinds.size);
  assert.ok(sentinels >= 8, "every frozen event kind mutated");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 6. Nothing above regenerated a committed artifact.
for (const name of protectedNames) {
  assert.equal(sha256(readFileSync(artifact(name))), before.get(name), `${name} was rewritten`);
}
assert.ok(taskInitialStateForStream(streamId).status === "pending");
console.log(`E6_T01_ARTIFACTS protected=${protectedNames.length} unchanged=true`);
