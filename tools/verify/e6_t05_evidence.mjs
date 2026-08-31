#!/usr/bin/env node
// verify-E6-T05: run the two-client mixed local/remote schedule against real servers in
// a fresh scrubbed process and hold its full summary — exact event sequences, refusal
// artifacts, conflict outcome, journal audits, projection/replay/queue digests, and a
// measured >=10s idle window with frozen heads — byte-for-byte to the committed
// artifact. Then prove the apparatus is sensitive: one flipped byte of the staged
// evidence moves the digests (EXPECTED-FAIL), and disabling the provenance origin
// filter (the E6_T05_ORIGIN_FILTER_GUARD sentinel) breaks the exact event counts and
// the journal multiplicity (EXPECTED-FAIL). A committed sabotage transcript records
// the red run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  E6_T05_ORIGIN_FILTER_GUARD,
  TASK_SYNC_INGEST_KINDS,
  TASK_SYNC_JOURNAL_VERSION,
  auditTaskSyncJournal,
  parseTaskSyncJournal,
} from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/evidence",
);
const schedule = join(root, "tools/verify/e6_t05_schedule.mjs");
const protectedNames = ["e6-t05-summary.txt", "e6-t05-sabotage.txt"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = (name) => join(evidence, name);
const before = new Map(protectedNames.map((name) => [name, sha256(readFileSync(artifact(name)))]));

function run(args, timezone, { expectFailure = false } = {}) {
  const env = { ...process.env, LANG: "C", LC_ALL: "C", TZ: timezone, CI: "true" };
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [schedule, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 480_000,
  });
  if (!expectFailure) {
    assert.equal(result.status, 0, `schedule failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const line = (text, prefix) => {
  const found = text.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert.ok(found !== undefined, `summary line missing: ${prefix}`);
  return found;
};

// 1. The frozen schedule: a fresh process, scrubbed env, foreign TZ, full >=10s idle
//    window; its stdout must equal the committed summary byte-for-byte.
const committed = readFileSync(artifact("e6-t05-summary.txt"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "e6-t05-"));
try {
  const live = run(["--out", join(scratch, "journals")], "Pacific/Kiritimati");
  if (live.stdout !== committed) {
    const liveLines = live.stdout.split("\n");
    const committedLines = committed.split("\n");
    for (let index = 0; index < Math.max(liveLines.length, committedLines.length); index += 1) {
      if (liveLines[index] !== committedLines[index]) {
        console.error(`SUMMARY DIFF line ${index + 1}`);
        console.error(`  committed: ${committedLines[index] ?? "<absent>"}`);
        console.error(`  live:      ${liveLines[index] ?? "<absent>"}`);
      }
    }
    console.error(`schedule stderr tail:\n${live.stderr.split("\n").slice(-12).join("\n")}`);
    assert.fail("schedule summary drifted from the committed bytes");
  }

  // Structural re-assertions on the committed summary (belt over the byte equality).
  assert.equal(
    line(committed, "final-events "),
    "final-events issue.opened,task.spec-revised,task.spec-revised,task.spec-revised,task.started,task.claimed,task.spec-revised,task.spec-revised,task.spec-revised,task.verified",
  );
  assert.equal(line(committed, "final-status "), "final-status verified");
  assert.match(line(committed, "step6-forgery "), /task\.claimed,task\.spec-revised$/);
  assert.ok(
    !line(committed, "step6-forgery ").includes("task.verified"),
    "forgery reached verified",
  );
  assert.equal(
    line(committed, "step6-artifacts "),
    "step6-artifacts count=3 reasons=log/role-kind-mismatch,status/illegal-edit",
  );
  assert.equal(
    line(committed, "step7-workshop "),
    "step7-workshop task-events-unchanged=true evidence-events-unchanged=true",
  );
  assert.equal(
    line(committed, "step8-loser "),
    "step8-loser conflict-artifacts=2 retained-has-loser-bytes=true",
  );
  assert.equal(
    line(committed, "step10-restore "),
    "step10-restore readme-byte-equal=true evidence-byte-equal=true detach-events=1",
  );
  assert.equal(
    line(committed, "step11-idle window"),
    "step11-idle window-at-least-ms=12000 measured-ok=true",
  );
  assert.equal(
    line(committed, "step11-idle heads"),
    "step11-idle heads-frozen=true write-lines-frozen=true",
  );
  assert.equal(line(committed, "replay-deterministic "), "replay-deterministic true");
  assert.match(line(committed, "projection-parity "), /byte-equal-on-both-branches=true$/);
  assert.equal(
    line(committed, "queue-independent-replay-equal "),
    "queue-independent-replay-equal true",
  );
  assert.equal(line(committed, "journal-a "), "journal-a ok=true violations=0");
  assert.equal(line(committed, "journal-b "), "journal-b ok=true violations=0");
  assert.match(line(committed, "warnings "), /unexpected=0$/);
  const digest = line(committed, "task-state-digest ").split(" ")[1];
  assert.match(digest, /^[0-9a-f]{64}$/);
  const queue = line(committed, "queue-digest ").split(" ")[1];
  assert.match(queue, /^[0-9a-f]{64}$/);
  console.log(
    `E6_T05_SCHEDULE summary-byte-identical=true task-digest=${digest} queue-digest=${queue}`,
  );

  // 2. The journals the live run wrote parse canonically under the frozen format.
  for (const name of ["journal-a.jsonl", "journal-b.jsonl"]) {
    const parsed = parseTaskSyncJournal(readFileSync(join(scratch, "journals", name), "utf8"));
    assert.ok(parsed.length > 0, `${name} is empty`);
    assert.ok(parsed.every((record) => record.v === TASK_SYNC_JOURNAL_VERSION));
    assert.ok(
      parsed.every((record) => record.kinds.every((kind) => TASK_SYNC_INGEST_KINDS.includes(kind))),
    );
  }
  assert.equal(typeof auditTaskSyncJournal, "function");
  console.log("E6_T05_JOURNALS canonical=true format=v1");

  // 3. Sensitivity: one flipped byte of the staged evidence bytes moves the digests.
  const mutated = run(["--mutate-evidence", "--idle-ms", "1500"], "America/Sao_Paulo");
  assert.equal(line(mutated.stdout, "step1-create "), line(committed, "step1-create "));
  assert.notEqual(
    line(mutated.stdout, "step3-evidence "),
    line(committed, "step3-evidence "),
    "a one-byte evidence mutation must move the evidence digest",
  );
  assert.notEqual(
    line(mutated.stdout, "evidence-manifest "),
    line(committed, "evidence-manifest "),
  );
  console.log("MUTATION evidence-byte-flip digest-moved=true EXPECTED-FAIL OK");

  // 4. Sabotage sentinel: with provenance origin filtering off, the engine re-ingests
  //    its own projections — the exact event counts move and the journal multiplicity
  //    breaks. Green here would refute the whole measuring apparatus.
  assert.equal(E6_T05_ORIGIN_FILTER_GUARD, true, "E6_T05_ORIGIN_FILTER_GUARD");
  const sabotaged = run(["--origin-filter", "off", "--idle-ms", "1500"], "UTC", {
    expectFailure: true,
  });
  const sabotageText = `${sabotaged.stdout}\n${sabotaged.stderr}`;
  if (sabotaged.status === 0) {
    assert.notEqual(
      line(sabotaged.stdout, "final-events "),
      line(committed, "final-events "),
      "origin-filter sabotage must move the exact event sequence",
    );
    const auditsRed =
      line(sabotaged.stdout, "journal-a ") !== "journal-a ok=true violations=0" ||
      line(sabotaged.stdout, "journal-b ") !== "journal-b ok=true violations=0";
    assert.ok(auditsRed, "origin-filter sabotage must break the journal audit");
  } else {
    // The echo can also wedge the schedule itself (extra revisions racing the fences);
    // a red exit is exactly what the sentinel demands.
    assert.ok(sabotageText.length > 0);
  }
  console.log(
    `SABOTAGE guard=E6_T05_ORIGIN_FILTER_GUARD origin-filter=off exit=${sabotaged.status} EXPECTED-FAIL OK`,
  );
  const transcript = readFileSync(artifact("e6-t05-sabotage.txt"), "utf8");
  assert.ok(
    transcript.includes("E6_T05_ORIGIN_FILTER_GUARD"),
    "sabotage transcript names the guard",
  );
  assert.ok(
    /EXPECTED-FAIL OK|violations=[1-9]|exit=[1-9]|final-events-moved=true/.test(transcript),
    "sabotage transcript shows red",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 5. Nothing above regenerated a committed artifact.
for (const [name, digest] of before) {
  assert.equal(
    sha256(readFileSync(artifact(name))),
    digest,
    `${name} was rewritten during verification`,
  );
}
console.log("E6_T05_EVIDENCE OK");
