#!/usr/bin/env node
// verify-E6-T03: replay the frozen project-state log twice in independent processes to
// the committed digest and byte-identical project.json projection, hold every refusal in
// the enforcement matrix and the forged-proof transcript to byte-identical stream heads,
// prove a tampered/deleted projection file is overwritten by replay and never consulted,
// and keep the pure guard closed against launches in every non-building state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import {
  PROJECT_REFUSAL_REASONS,
  fenceTaskLoopAction,
  guardLoopAction,
  projectProjectionBytes,
  replayProjectLog,
  validateProjectEvent,
} from "../../packages/platform/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".eforest/tasks/epic-6-the-loop/E6-T03-project-state-machine/evidence");
const ef = join(root, "packages/cli/dist/src/bin.js");
const runner = join(root, "tools/verify/e6_t03_project.mjs");
const streamId = "project:maple/loom";
const protectedNames = [
  "e6-t03-project.jsonl",
  "e6-t03-project.state.json",
  "e6-t03-project.digest",
  "e6-t03-project.json",
  "e6-t03-matrix.txt",
  "e6-t03-proofs.txt",
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

function readTranscript(name, prefixes) {
  const text = readFileSync(artifact(name), "utf8");
  assert.ok(text.endsWith("\n"));
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const prefix = prefixes.find((candidate) => line.startsWith(`${candidate} `));
      assert.ok(prefix !== undefined, `${name}: unexpected line prefix`);
      return { prefix, ...JSON.parse(line.slice(prefix.length + 1)) };
    });
}

function freshProcess(args, cwd, timezone) {
  const env = { ...process.env, LANG: "C", LC_ALL: "C", TZ: timezone };
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${args.join(" ")} wrote stderr`);
  return result.stdout;
}

function cliDigest(path, cwd, timezone) {
  const digest = freshProcess(
    [ef, "replay", path, "--digest", "--reducer", "project/v1", "--stream-id", streamId],
    cwd,
    timezone,
  ).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  return digest;
}

// 1. Project-state log + canonical digest + projection bytes.
const log = readCanonicalJsonl("e6-t03-project.jsonl");
const expectedDigest = readFileSync(artifact("e6-t03-project.digest"), "utf8").trim();
assert.match(expectedDigest, /^[0-9a-f]{64}$/);
console.log(`E6_T03_PROJECT_LOG stream=${streamId} events=${log.length}`);
for (const record of log) {
  const to = record.type === "project.transitioned" ? ` -> ${record.payload.to}` : "";
  console.log(`  ${record.offset} ${record.type} by ${record.payload.by.role}${to}`);
}
assert.ok(
  log.every(
    (record, index) => record.offset === `0000000000000000_${String(index).padStart(16, "0")}`,
  ),
);
const state = replayProjectLog(streamId, log);
assert.equal(
  canonicalJson(state),
  readFileSync(artifact("e6-t03-project.state.json"), "utf8").trim(),
);
assert.equal(stateDigest(state), expectedDigest);
assert.equal(state.status, "complete");
assert.equal(state.transitions, 5);
assert.equal(state.launches, 2);
assert.equal(state.fences, 6, "six task fences precede the lifecycle");
assert.equal(state.completion.capstone, "loom-cap");
assert.equal(state.updatedAt, log[12].ts);
assert.equal(state.actor, log[12].payload.by.actor);
assert.equal(state.head, log[12].offset);
const projection = readFileSync(artifact("e6-t03-project.json"), "utf8");
assert.equal(projectProjectionBytes(state), projection);
const projected = JSON.parse(projection);
assert.equal(projected.status, "complete");
assert.equal(projected.stateDigest, expectedDigest);
assert.equal(projected.updatedAt, "1970-01-01T00:00:02.006Z");
assert.ok(projected.statusReason.length > 0);
// Every accepted transition in the log carries a nonempty reason, an actor, and a frozen ts.
let cursor = replayProjectLog(streamId, []);
for (const record of log) {
  const next = replayProjectLog(streamId, log.slice(0, log.indexOf(record) + 1));
  assert.notEqual(canonicalJson(next), canonicalJson(cursor), `${record.offset}: no-op`);
  if (record.type === "project.transitioned") {
    assert.ok(next.statusReason.length > 0);
    assert.equal(next.actor, record.payload.by.actor);
    assert.equal(next.actorRole, record.payload.by.role);
    assert.equal(next.updatedAt, record.ts);
  }
  cursor = next;
}
console.log(`E6_T03_DIGEST ${expectedDigest}`);
console.log(
  `E6_T03_PROJECTION sha256=${sha256(projection)} bytes=${Buffer.byteLength(projection)}`,
);

const scratch = mkdtempSync(join(tmpdir(), "e6-t03-"));
try {
  // 2. Two independent replay processes (foreign cwd + time zone vs repository cwd).
  const one = cliDigest(artifact("e6-t03-project.jsonl"), scratch, "Pacific/Kiritimati");
  const two = cliDigest(artifact("e6-t03-project.jsonl"), join(root, "packages/platform"), "UTC");
  assert.equal(one, expectedDigest, "process one digest");
  assert.equal(two, expectedDigest, "process two digest");
  const projOne = freshProcess(
    [runner, artifact("e6-t03-project.jsonl"), streamId],
    scratch,
    "Pacific/Kiritimati",
  );
  const projTwo = freshProcess(
    [runner, artifact("e6-t03-project.jsonl"), streamId],
    root,
    "America/Sao_Paulo",
  );
  assert.equal(projOne, projTwo, "projection differs between fresh processes");
  assert.equal(projOne.trim(), `${expectedDigest} ${sha256(projection)}`);
  console.log(`E6_T03_REPLAY processes=2 digest=${one} projection-byte-identical=true`);

  // 3. The enforcement matrix: every refusal left both stream heads untouched, every
  //    acceptance advanced exactly the target stream, and every reason is exercised.
  const matrix = readTranscript("e6-t03-matrix.txt", ["E6_T03_MATRIX", "E6_T03_REFUSAL"]);
  const rows = matrix.filter((entry) => entry.prefix === "E6_T03_MATRIX");
  const extras = matrix.filter((entry) => entry.prefix === "E6_T03_REFUSAL");
  assert.equal(rows.length, 72, "state x role x action rows");
  assert.equal(extras.length, 15, "binding/shape/family refusals");
  const reasonsSeen = new Set();
  const tuples = new Set();
  let refused = 0;
  let admitted = 0;
  for (const row of rows) {
    assert.ok(!tuples.has(row.name), `${row.name}: duplicate tuple`);
    tuples.add(row.name);
    const body = JSON.parse(row.responseBody);
    if (row.status === 409) {
      refused += 1;
      assert.deepEqual(row.after, row.before, `${row.name}: a refusal moved a stream head`);
      assert.equal(body.error.class, "validator-rejected");
      assert.ok(
        PROJECT_REFUSAL_REASONS.includes(body.error.reason),
        `${row.name}: ${body.error.reason}`,
      );
      assert.equal(
        body.error.project.offset,
        row.before.project.headOffset,
        `${row.name}: cited offset`,
      );
      assert.equal(body.error.project.status, row.name.split("/")[0], `${row.name}: cited status`);
      reasonsSeen.add(body.error.reason);
    } else {
      admitted += 1;
      assert.equal(row.status, 202, row.name);
      assert.equal(row.after.target.headOffset, body.offset, `${row.name}: receipt offset`);
      assert.notEqual(row.after.target.dumpSha256, row.before.target.dumpSha256);
      // A task loop event leaves exactly one fence on the project stream; a project
      // event moves the project head itself.
      assert.notEqual(
        row.after.project.headOffset,
        row.before.project.headOffset,
        `${row.name}: unfenced`,
      );
      assert.ok(
        row.name.startsWith("building/") ||
          row.name.endsWith("/to:building") ||
          row.name.endsWith("/to:invalid_loop"),
        `${row.name}: admitted outside the matrix`,
      );
    }
  }
  for (const state of ["building", "paused", "invalid_loop", "complete"]) {
    for (const role of ["human", "agent"]) {
      for (const action of [
        "launch",
        "to:building",
        "to:paused",
        "to:invalid_loop",
        "to:complete",
        "to:complete+proof",
      ]) {
        assert.ok(
          tuples.has(`${state}/${role}/${action}`),
          `missing tuple ${state}/${role}/${action}`,
        );
      }
    }
    for (const action of [
      "task.started",
      "task.claimed",
      "task.refuted",
      "task.rework-started",
      "task.verified",
    ]) {
      assert.ok(tuples.has(`${state}/agent/${action}`), `missing tuple ${state}/agent/${action}`);
    }
    assert.ok(tuples.has(`${state}/human/task.started`));
  }
  const expectReason = (name, reason) => {
    const row = rows.find((entry) => entry.name === name);
    assert.ok(row !== undefined, name);
    assert.equal(row.status, 409, name);
    assert.equal(JSON.parse(row.responseBody).error.reason, reason, name);
  };
  expectReason("invalid_loop/agent/launch", "project/invalid-loop");
  expectReason("invalid_loop/human/launch", "project/invalid-loop");
  expectReason("invalid_loop/agent/task.claimed", "project/invalid-loop");
  expectReason("invalid_loop/agent/to:building", "project/unauthorized-resume");
  expectReason("paused/agent/launch", "project/paused");
  expectReason("paused/agent/task.verified", "project/paused");
  expectReason("paused/agent/to:building", "project/unauthorized-resume");
  expectReason("complete/agent/launch", "project/complete");
  expectReason("complete/agent/task.claimed", "project/complete");
  expectReason("complete/agent/to:building", "project/unauthorized-resume");
  expectReason("building/agent/to:paused", "project/human-required");
  expectReason("building/human/to:complete", "project/proof-required");
  for (const extra of extras) {
    assert.deepEqual(extra.after, extra.before, `${extra.name}: a refusal moved a stream head`);
    assert.ok([404, 409, 422].includes(extra.status), extra.name);
    if (extra.status === 409) reasonsSeen.add(JSON.parse(extra.responseBody).error.reason);
  }
  console.log(
    `E6_T03_MATRIX tuples=${rows.length} refused=${refused} admitted=${admitted} extra-refusals=${extras.length} head-identical=true`,
  );

  // 4. Forged completion proofs: every forgery refused without moving the head; only
  //    the true proof (twice: agent, then human after a replan) is accepted.
  const proofs = readTranscript("e6-t03-proofs.txt", ["E6_T03_PROOF"]);
  const forged = proofs.filter((entry) => entry.status === 409);
  const trueProofs = proofs.filter((entry) => entry.status === 202);
  assert.equal(
    trueProofs.map((entry) => entry.name).join(","),
    "true-proof-agent,true-proof-human",
  );
  assert.ok(forged.length >= 13, "forged proof count");
  for (const entry of forged) {
    assert.deepEqual(entry.after, entry.before, `${entry.name}: forged proof moved the head`);
    const reason = JSON.parse(entry.responseBody).error.reason;
    assert.ok(reason === "project/false-proof" || reason === "project/stale-proof", entry.name);
    reasonsSeen.add(reason);
  }
  const forgedReason = (name) =>
    JSON.parse(forged.find((entry) => entry.name === name).responseBody).error.reason;
  assert.equal(forgedReason("missing-capstone"), "project/false-proof");
  assert.equal(forgedReason("duplicate-task-id"), "project/false-proof");
  assert.equal(forgedReason("omits-pending-task"), "project/false-proof");
  assert.equal(forgedReason("tampers-pending-to-verified"), "project/false-proof");
  assert.equal(forgedReason("stale-queue-head"), "project/stale-proof");
  assert.equal(forgedReason("stale-after-new-task"), "project/stale-proof");
  // `project/fence-contention` is reachable only after eight lost compare-and-append
  // races; it cannot be produced deterministically and is exercised by the pure guard below.
  for (const reason of PROJECT_REFUSAL_REASONS.filter((r) => r !== "project/fence-contention"))
    assert.ok(reasonsSeen.has(reason), `uncovered ${reason}`);
  console.log(
    `E6_T03_PROOFS forged=${forged.length} accepted=${trueProofs.length} reasons-covered=${reasonsSeen.size}/${PROJECT_REFUSAL_REASONS.length}`,
  );

  // 5. The projection file is output only: tamper it, delete it, replay overwrites it.
  const file = join(scratch, "project.json");
  writeFileSync(file, projection);
  writeFileSync(file, projection.replace('"status":"complete"', '"status":"building"'));
  assert.notEqual(readFileSync(file, "utf8"), projection);
  writeFileSync(file, projectProjectionBytes(replayProjectLog(streamId, log)));
  assert.equal(readFileSync(file, "utf8"), projection, "replay did not overwrite the edit");
  unlinkSync(file);
  writeFileSync(file, projectProjectionBytes(replayProjectLog(streamId, log)));
  assert.equal(readFileSync(file, "utf8"), projection, "replay did not restore the deleted file");
  console.log(
    "E6_T03_PROJECTION_FILE tampered=overwritten deleted=restored guard-reads-file=false",
  );

  // 6. The pure guard is closed in every non-building state — the invalid-loop arm is the
  //    sabotage sentinel (E6_T03_INVALID_LOOP_GUARD); removing it turns this red.
  assert.equal(guardLoopAction("building", "loop.launch.requested"), undefined);
  assert.equal(guardLoopAction("paused", "loop.launch.requested"), "project/paused");
  assert.equal(guardLoopAction("complete", "loop.launch.requested"), "project/complete");
  assert.equal(guardLoopAction("invalid_loop", "loop.launch.requested"), "project/invalid-loop");
  assert.equal(guardLoopAction("invalid_loop", "task.claimed"), "project/invalid-loop");
  const invalid = replayProjectLog(streamId, log.slice(0, 10));
  assert.equal(invalid.status, "invalid_loop");
  let launchRefusal;
  try {
    await validateProjectEvent(
      {
        type: "loop.launch.requested",
        payload: {
          v: 1,
          by: { actor: "agent-ash", role: "agent" },
          expectedOffset: invalid.head,
          run: "agent-run:maple/sabotage",
        },
        ts: 9999,
      },
      {
        streamId,
        state: invalid,
        headOffset: invalid.head,
        nextOffset: "0000000000000000_0000000000000010",
        records: log.slice(0, 10),
        actor: "agent-ash",
        actorRole: "agent",
      },
    );
  } catch (error) {
    launchRefusal = error;
  }
  assert.ok(launchRefusal !== undefined, "launch against invalid_loop was admitted");
  assert.equal(launchRefusal.reason, "project/invalid-loop");
  assert.equal(launchRefusal.at.offset, invalid.head);
  console.log(
    `E6_T03_GUARD invalid_loop launch=refused reason=${launchRefusal.reason} at=${launchRefusal.at.offset}`,
  );
  // The cross-process fence, pure: an appender that always loses the compare-and-append
  // refuses `project/fence-contention` after eight attempts; a pause that lands between
  // the read and the append is re-decided as `project/paused`. The task-stream records
  // are never touched by the fence path (it only appends to the project stream).
  const by = { actor: "agent-ash", role: "agent" };
  const taskStream = "issue:maple/loom/loom-t9";
  let attempts = 0;
  let contention;
  try {
    await fenceTaskLoopAction(
      taskStream,
      "task.claimed",
      "0000000000000000_0000000000000003",
      by,
      1,
      {
        resolve: async () => [],
        appendAt: async () => {
          attempts += 1;
          return false;
        },
      },
    );
  } catch (error) {
    contention = error;
  }
  assert.equal(contention?.reason, "project/fence-contention");
  assert.equal(attempts, 8);
  let paused;
  let pauseLanded = false;
  try {
    await fenceTaskLoopAction(
      taskStream,
      "task.claimed",
      "0000000000000000_0000000000000003",
      by,
      1,
      {
        resolve: async () => (pauseLanded ? log.slice(0, 8) : []),
        appendAt: async () => {
          pauseLanded = true;
          return false;
        },
      },
    );
  } catch (error) {
    paused = error;
  }
  assert.equal(paused?.reason, "project/paused");
  assert.equal(paused?.at.status, "paused");
  const fenced = [];
  const citation = await fenceTaskLoopAction(
    taskStream,
    "task.claimed",
    "0000000000000000_0000000000000003",
    by,
    1,
    {
      resolve: async () => [],
      appendAt: async (stream, event, ordinal) => {
        fenced.push({ stream, ordinal, target: event.payload.target });
        return true;
      },
    },
  );
  assert.equal(citation.status, "building");
  assert.deepEqual(fenced, [
    {
      stream: streamId,
      ordinal: 0,
      target: { stream: taskStream, offset: "0000000000000000_0000000000000003" },
    },
  ]);
  console.log(
    "E6_T03_FENCE contention=refused-after-8 pause-mid-race=project/paused bound-target=true",
  );

  // 7. One-byte mutation of every frozen event kind must change the digest.
  const targets = {
    "loop.launch.requested": ["run"],
    "project.transitioned": ["statusReason"],
    "project.fenced": ["action"],
  };
  const kinds = new Map();
  // The state keeps the latest transition's fields, so the LAST event of each kind is
  // the one whose bytes must reach the digest (an earlier reason is legitimately overwritten).
  for (const [index, record] of log.entries()) kinds.set(record.type, index);
  assert.deepEqual([...kinds.keys()].sort(), Object.keys(targets).sort());
  for (const [type, index] of kinds) {
    const lines = readFileSync(artifact("e6-t03-project.jsonl"), "utf8").slice(0, -1).split("\n");
    const record = JSON.parse(lines[index]);
    const key = targets[type][0];
    const value = record.payload[key];
    const byte = value.charCodeAt(0);
    record.payload[key] =
      `${String.fromCharCode(byte === 0x7a ? 0x79 : byte + 1)}${value.slice(1)}`;
    const mutated = canonicalJson(record);
    assert.equal([...mutated].filter((char, at) => char !== lines[index][at]).length, 1);
    lines[index] = mutated;
    const path = join(scratch, `mutated-${index}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const digest = cliDigest(path, scratch, "UTC");
    assert.notEqual(digest, expectedDigest, `${type}: one-byte mutation left the digest unchanged`);
    console.log(
      `MUTATION kind=${type} offset=${log[index].offset} field=${key} digest-mismatch EXPECTED-FAIL OK`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 8. Nothing above regenerated a committed artifact.
for (const name of protectedNames) {
  assert.equal(sha256(readFileSync(artifact(name))), before.get(name), `${name} was rewritten`);
}
console.log(`E6_T03_ARTIFACTS protected=${protectedNames.length} unchanged=true`);
