#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
  planLinkPropagation,
} from "../../packages/meadow/dist/src/index.js";
import { parseCanonicalJsonl, verifyCloseFixture } from "./e5_t07_fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "packages/meadow/fixtures/linking/close-on-merge");
const issueSource = readFileSync(join(fixture, "issue.events.jsonl"), "utf8");
const prSource = readFileSync(join(fixture, "pr.events.jsonl"), "utf8");
const expected = JSON.parse(readFileSync(join(fixture, "expected.json"), "utf8"));

function expectedFailure(label, run) {
  assert.throws(run, undefined, `${label}: verifier accepted the mutant`);
  console.log(`${label} EXPECTED-FAIL OK`);
}

const byte = issueSource.indexOf("Linked issue") + "Linked issu".length;
expectedFailure(`MUTATION byte=${String(byte)} digest-mismatch`, () =>
  verifyCloseFixture(
    `${issueSource.slice(0, byte)}E${issueSource.slice(byte + 1)}`,
    prSource,
    expected,
  ),
);

const issues = parseCanonicalJsonl(issueSource, "sensitivity issue log");
const prs = parseCanonicalJsonl(prSource, "sensitivity PR log");
const merged = prs.find(({ type }) => type === "pr.merged");
const closedIndex = issues.findIndex(
  ({ type, payload }) => type === "issue.state-changed" && payload.to === "done",
);
const backlinkIndex = prs.findIndex(({ type }) => type === "pr.link-closed");

const wrongVia = structuredClone(issues);
wrongVia[closedIndex].payload.via.prMergedOffset = prs[1].offset;
expectedFailure("CITATION side=issue field=prMergedOffset", () =>
  verifyCloseFixture(
    wrongVia.map((record) => canonicalJson(record)).join("\n") + "\n",
    prSource,
    expected,
  ),
);

const wrongBacklink = structuredClone(prs);
wrongBacklink[backlinkIndex].payload.issueOffset = issues[2].offset;
expectedFailure("CITATION side=pr field=issueOffset", () =>
  verifyCloseFixture(
    issueSource,
    wrongBacklink.map((record) => canonicalJson(record)).join("\n") + "\n",
    expected,
  ),
);

const prBeforeBacklink = prs
  .slice(0, backlinkIndex)
  .reduce(meadowPrReducer, meadowPrInitialStateForStream("pr:maple/reading-room/42"));
const close = issues[closedIndex];
const snapshot = {
  kind: "present",
  headOffset: close.offset,
  state: "done",
  closedBy: [
    {
      prStream: close.payload.via.prStream,
      prMergedOffset: close.payload.via.prMergedOffset,
      issueOffset: close.offset,
    },
  ],
};
const trigger = {
  kind: "merged",
  prStreamId: "pr:maple/reading-room/42",
  prMergedOffset: merged.offset,
  ts: merged.ts,
};
const actual = planLinkPropagation(trigger, prBeforeBacklink, {
  "issue:maple/reading-room/7": snapshot,
});
assert.equal(actual[0]?.kind, "append-pr-link-closed");
const mutant = planLinkPropagation(trigger, prBeforeBacklink, {
  "issue:maple/reading-room/7": { ...snapshot, closedBy: [] },
});
assert.notEqual(mutant[0]?.kind, "append-pr-link-closed");
console.log(
  `SENSITIVITY key=closedBy expected=append-pr-link-closed observed=${mutant[0]?.kind ?? "empty"} EXPECTED-FAIL OK`,
);
