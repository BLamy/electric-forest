#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T09-pr-ui-live/evidence");
const transcript = await readFile(resolve(evidence, "e5-t09-browser.txt"), "utf8");
const network = JSON.parse(
  await readFile(resolve(evidence, "e5-t09-browser-network.json"), "utf8"),
);

assert.match(transcript, /^source-head=[0-9a-f]{40}$/m);
assert.equal((transcript.match(/^STEP .* OK$/gm) ?? []).length, 8);
for (const marker of [
  "THREAD ",
  "LINE path=docs/feature.ts line=",
  "MERGE ",
  "CLOSE ",
  "MOBILE list_reducer=pr-index@1 detail_reducer=pr width=390 OK",
  "WRITE-AUDIT dispatches=8 other_state_writes=0 OK",
  "CONSOLE errors=0 page_errors=0 request_failures=0 OK",
  "E5_T09_BROWSER_OK",
]) {
  assert.ok(transcript.includes(marker), `missing transcript marker: ${marker}`);
}

assert.equal(network.writes.length, 8);
assert.deepEqual(network.otherStateWrites, []);
const eventTypes = network.writes.map((write) => {
  assert.equal(write.method, "POST");
  assert.equal(new URL(write.url).pathname, "/api/dispatch");
  return JSON.parse(write.body).event.type;
});
assert.deepEqual(eventTypes, [
  "pr.opened",
  "pr.review-comment",
  "pr.review-comment",
  "pr.review-comment",
  "pr.review",
  "pr.merge",
  "pr.opened",
  "pr.closed",
]);

console.log("E5_T09_EVIDENCE_OK steps=8 dispatches=8 mobile=390");
