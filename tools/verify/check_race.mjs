#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [dumpPath, attemptsPath, mode] = process.argv.slice(2);
if (!dumpPath || !attemptsPath) {
  console.error("usage: check_race.mjs DUMP.jsonl ATTEMPTS.json [--replay|--skip-replay]");
  process.exit(2);
}

function fail(message) {
  console.error(`race-check: ${message}`);
  process.exit(1);
}

function eventDigest(record) {
  return createHash("sha256")
    .update(JSON.stringify({ type: record.type, payload: record.payload, ts: record.ts }), "utf8")
    .digest("hex");
}

function expectedOffset(index) {
  return `0000000000000000_${String(index).padStart(16, "0")}`;
}

let records;
try {
  const raw = readFileSync(dumpPath, "utf8");
  records =
    raw.length === 0
      ? []
      : raw
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
} catch (error) {
  fail(`cannot read dump: ${error instanceof Error ? error.message : String(error)}`);
}
let attempts;
try {
  attempts = JSON.parse(readFileSync(attemptsPath, "utf8"));
} catch (error) {
  fail(`cannot read attempts: ${error instanceof Error ? error.message : String(error)}`);
}
if (!Array.isArray(records) || !Array.isArray(attempts) || records.length === 0)
  fail("inputs must contain a non-empty dump and attempts array");

const accepted = [];
const refusedDigests = new Set();
const bySequence = new Map();
for (const attempt of attempts) {
  if (
    !attempt ||
    !Number.isInteger(attempt.sequence) ||
    typeof attempt.payloadDigest !== "string"
  ) {
    fail("malformed attempt record");
  }
  if (!Number.isInteger(attempt.responseSequence) || attempt.responseSequence < -1) {
    fail(`sequence ${attempt.sequence} has an invalid response Stream-Seq header`);
  }
  const group = bySequence.get(attempt.sequence) ?? [];
  group.push(attempt);
  bySequence.set(attempt.sequence, group);
  if (attempt.status >= 200 && attempt.status < 300) accepted.push(attempt);
  else if (attempt.status === 409) refusedDigests.add(attempt.payloadDigest);
  else fail(`attempt sequence ${attempt.sequence} returned unexpected status ${attempt.status}`);
  if (
    attempt.status >= 200 &&
    attempt.status < 300 &&
    attempt.responseSequence !== attempt.sequence
  ) {
    fail(`successful sequence ${attempt.sequence} reported Stream-Seq ${attempt.responseSequence}`);
  }
  if (attempt.status === 409 && attempt.responseSequence !== attempt.sequence) {
    fail(
      `refused sequence ${attempt.sequence} reported Stream-Seq ${attempt.responseSequence}, expected the current sequence ${attempt.sequence}`,
    );
  }
}
for (const [sequence, group] of bySequence) {
  if (group.filter((attempt) => attempt.status >= 200 && attempt.status < 300).length !== 1) {
    fail(`sequence ${sequence} did not have exactly one successful writer`);
  }
}
if (accepted.length !== records.length)
  fail(`dump has ${records.length} records but ${accepted.length} accepted attempts`);

const dumpDigests = records.map(eventDigest);
const acceptedDigests = accepted.map((attempt) => attempt.payloadDigest);
const count = (values) => {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
};
for (const [digest, amount] of count(acceptedDigests)) {
  if (count(dumpDigests).get(digest) !== amount)
    fail(`accepted payload ${digest} is not traceable exactly once`);
}
for (const digest of refusedDigests)
  if (dumpDigests.includes(digest)) fail(`refused payload ${digest} landed in the dump`);
records.forEach((record, index) => {
  if (record.offset !== expectedOffset(index))
    fail(`offset ${record.offset} is not the expected contiguous offset ${expectedOffset(index)}`);
});

if (mode === "--replay") {
  const replay = spawnSync(
    process.execPath,
    ["packages/cli/dist/src/bin.js", "replay", dumpPath, "--digest"],
    {
      encoding: "utf8",
    },
  );
  if (replay.status !== 0 || !/^[0-9a-f]{64}\n$/.test(replay.stdout)) {
    fail(
      `ef replay failed: status=${replay.status} stdout=${JSON.stringify(replay.stdout)} stderr=${JSON.stringify(replay.stderr)}`,
    );
  }
}
console.log(
  `race-check: ${bySequence.size} contested sequences, ${records.length} accepted events${mode === "--replay" ? ", ef replay OK" : ""}`,
);
