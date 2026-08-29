#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  issueDigest,
  parseCanonicalJsonl,
  prDigest,
  verifyCloseFixture,
} from "./e5_t07_fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(root, "packages/meadow/fixtures/linking");
const evidenceRoot = join(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T07-cross-entity-linking/evidence",
);
const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));

const closeRoot = join(fixtureRoot, "close-on-merge");
const closeIssueSource = read(join(closeRoot, "issue.events.jsonl"));
const closePrSource = read(join(closeRoot, "pr.events.jsonl"));
const closeExpected = readJson(join(closeRoot, "expected.json"));
const close = verifyCloseFixture(closeIssueSource, closePrSource, closeExpected);
assert.equal(read(join(evidenceRoot, "e5-t07-issue-log.jsonl")), closeIssueSource);
assert.equal(read(join(evidenceRoot, "e5-t07-pr-log.jsonl")), closePrSource);
console.log(
  `LINK fixture=close-on-merge digest=${close.observed.issue.afterLink} expected=${closeExpected.issue.afterLink} OK`,
);
console.log(
  `CLOSE fixture=close-on-merge offset=${close.merged.offset} via=${close.closed.payload.via.prMergedOffset} backlink=${close.backlink.payload.issueOffset} issue-offset=${close.closed.offset} OK`,
);

const doneCount = close.issues.filter(
  ({ type, payload }) => type === "issue.state-changed" && payload.to === "done",
).length;
assert.equal(doneCount, 1);
console.log(`REPLAY-ONCE count=${String(doneCount)} OK`);

const danglingRoot = join(fixtureRoot, "dangling");
assert.equal(existsSync(join(danglingRoot, "issue.events.jsonl")), false);
const danglingPr = parseCanonicalJsonl(
  read(join(danglingRoot, "pr.events.jsonl")),
  "dangling PR log",
);
const danglingExpected = readJson(join(danglingRoot, "expected.json"));
assert.equal(prDigest(danglingPr), danglingExpected.prDigest);
const danglingNoops = danglingPr
  .filter(({ type }) => type === "pr.link-noop")
  .map(({ payload }) => ({
    reason: payload.reason,
    trigger: payload.provenance.trigger,
    triggerOffset: payload.provenance.openedOffset ?? payload.provenance.prMergedOffset,
  }));
assert.deepEqual(danglingNoops, danglingExpected.noops);
console.log(
  `DANGLING compatibility=recovery-only noop=dangling-reference issue-head=n/a pr-digest=${danglingExpected.prDigest} OK`,
);

const alreadyRoot = join(fixtureRoot, "already-done");
const alreadyIssue = parseCanonicalJsonl(
  read(join(alreadyRoot, "issue.events.jsonl")),
  "already-done issue log",
);
const alreadyPr = parseCanonicalJsonl(
  read(join(alreadyRoot, "pr.events.jsonl")),
  "already-done PR log",
);
const alreadyExpected = readJson(join(alreadyRoot, "expected.json"));
assert.equal(issueDigest(alreadyIssue), alreadyExpected.issueDigest);
assert.equal(prDigest(alreadyPr), alreadyExpected.prDigest);
assert.equal(alreadyIssue.at(-1).offset, alreadyExpected.issueHeadBeforeMerge);
assert.equal(alreadyExpected.issueHeadAfterMerge, alreadyExpected.issueHeadBeforeMerge);
const alreadyNoop = alreadyPr.find(({ type }) => type === "pr.link-noop");
assert.deepEqual(
  {
    reason: alreadyNoop.payload.reason,
    prMergedOffset: alreadyNoop.payload.provenance.prMergedOffset,
  },
  alreadyExpected.noop,
);
console.log("ALREADY-DONE noop=already-done issue-head=unchanged OK");

const closedRoot = join(fixtureRoot, "close-without-merge");
const closedIssue = parseCanonicalJsonl(
  read(join(closedRoot, "issue.events.jsonl")),
  "close-without-merge issue log",
);
const closedPr = parseCanonicalJsonl(
  read(join(closedRoot, "pr.events.jsonl")),
  "close-without-merge PR log",
);
const closedExpected = readJson(join(closedRoot, "expected.json"));
assert.equal(issueDigest(closedIssue), closedExpected.issueDigest);
assert.equal(prDigest(closedPr), closedExpected.prDigest);
assert.equal(closedExpected.issueHeadAfterClose, closedExpected.issueHeadBeforeClose);
assert.equal(closedPr.at(-1).type, "pr.closed");
assert.equal(
  closedIssue.some(({ type, payload }) => type === "issue.state-changed" && payload.to === "done"),
  false,
);
console.log(`CLOSE-NO-MERGE issue-head=unchanged digest=${closedExpected.issueDigest} OK`);

const probeLines = read(join(evidenceRoot, "e5-t07-probes.txt")).trim().split("\n").map(JSON.parse);
assert.deepEqual(
  probeLines.map(({ probe }) => probe),
  ["redispatched-merge", "duplicate-reference", "dangling-reference", "already-done"],
);
const redispatch = probeLines[0];
assert.equal(redispatch.appended, 0);
assert.deepEqual(redispatch.before, redispatch.after);
assert.equal(redispatch.after.issueDigest, closeExpected.issue.final);
assert.equal(redispatch.after.prDigest, closeExpected.pr.final);
console.log("IDEMPOTENT appended=0 OK");

const duplicate = probeLines[1];
assert.equal(duplicate.declaredRefs, 2);
assert.equal(duplicate.stateChanged, 1);
assert.equal(duplicate.backlinks, 1);
assert.equal(duplicate.after.issueDigest, closeExpected.issue.final);

const danglingProbe = probeLines[2];
assert.equal(danglingProbe.streamCreated, false);
assert.equal(danglingProbe.after.prDigest, danglingExpected.prDigest);
assert.equal(danglingProbe.after.issueHead, "n/a");

const alreadyProbe = probeLines[3];
assert.equal(alreadyProbe.before.issueHead, alreadyProbe.after.issueHead);
assert.equal(alreadyProbe.before.issueDigest, alreadyProbe.after.issueDigest);
assert.equal(alreadyProbe.after.issueDigest, alreadyExpected.issueDigest);

const rerun = verifyCloseFixture(closeIssueSource, closePrSource, closeExpected);
assert.deepEqual(rerun.observed, close.observed);
console.log("DETERMINISM fixture=close-on-merge OK");
