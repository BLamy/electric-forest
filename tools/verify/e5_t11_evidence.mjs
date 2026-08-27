#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T11-evidence-ui/evidence");
const read = (name) => readFile(resolve(evidence, name), "utf8");

const [eventsText, transcriptText, coverageText, digests, bytes, hostile, writes, fallback] =
  await Promise.all([
    read("e5-t11-session.events.jsonl"),
    read("e5-t11-browser-transcript.json"),
    read("e5-t11-browser-source-coverage.json"),
    read("e5-t11-digests.txt"),
    read("e5-t11-byte-parity.txt"),
    read("e5-t11-hostile-link.txt"),
    read("e5-t11-write-audit.txt"),
    read("e5-t11-replay-fallback.txt"),
  ]);

const transcript = JSON.parse(transcriptText);
const coverage = JSON.parse(coverageText);
assert.match(transcript.recordedHead, /^[0-9a-f]{40}$/);
assert.equal(coverage.recordedHead, transcript.recordedHead);
assert.deepEqual(transcript.requestFailures, []);
assert.deepEqual(transcript.pageErrors, []);
assert.equal(transcript.console.filter((entry) => entry.type === "error").length, 0);
assert.equal(
  transcript.inFlightRequests.every(
    (entry) =>
      entry.classification === "active-follow-long-poll" && /\/events(?:\?|$)/.test(entry.url),
  ),
  true,
);

const expectedSources = [
  "apps/web/src/evidence/EvidencePanel.tsx",
  "apps/web/src/evidence/model.ts",
  "apps/web/src/evidence/useEvidence.ts",
  "apps/web/src/issues/IssueDetail.tsx",
  "apps/web/src/prs/PrDetail.tsx",
  "apps/web/src/styles.css",
];
assert.deepEqual(coverage.materialSources, expectedSources);
assert.ok(coverage.assets.length > 0);
assert.ok(coverage.cssAssets.length > 0);

const browserDispatches = transcript.network.filter(
  (entry) =>
    entry.direction === "request" &&
    entry.method === "POST" &&
    new URL(entry.url, "https://evidence.invalid").pathname === "/api/dispatch",
);
assert.equal(browserDispatches.length, 8);
assert.deepEqual(
  browserDispatches.map((entry) => JSON.parse(Buffer.from(entry.bodyBase64, "base64")).event.type),
  [
    "content.chunk",
    "content.sealed",
    "evidence.attached",
    "evidence.linked",
    "content.chunk",
    "content.sealed",
    "evidence.attached",
    "evidence.linked",
  ],
);

const eventDumps = eventsText
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(eventDumps.map((entry) => entry.streamId).sort(), [
  "evidence:maple/reading-room/issue/evidence-issue",
  "evidence:maple/reading-room/pr/evidence-pr",
]);
assert.equal(
  eventDumps.every((entry) => Array.isArray(entry.records) && entry.records.length > 0),
  true,
);

for (const [text, marker] of [
  [digests, "E5_T11_DIGESTS_OK"],
  [bytes, "E5_T11_BYTE_PARITY_OK"],
  [hostile, "E5_T11_HOSTILE_LINK_OK"],
  [writes, "E5_T11_WRITE_AUDIT_OK"],
  [fallback, "E5_T11_REPLAY_FALLBACK_OK"],
]) {
  assert.ok(text.includes(marker), `missing artifact marker: ${marker}`);
}
assert.match(bytes, /source-sha256=([0-9a-f]{64})\ndownloaded-sha256=\1/);
assert.match(hostile, /recorded-url=javascript:alert\(1\)[\s\S]*rendered-anchor-count=0/);
assert.match(writes, /dispatch-posts=8[\s\S]*other-state-writes=0/);

const ancestry = spawnSync(
  "git",
  ["merge-base", "--is-ancestor", transcript.recordedHead, "HEAD"],
  {
    cwd: root,
  },
);
assert.equal(ancestry.status, 0, "recorded source head is not an ancestor of the evidence head");

console.log(
  `E5_T11_EVIDENCE_OK dispatches=8 streams=${String(eventDumps.length)} sources=${String(expectedSources.length)}`,
);
