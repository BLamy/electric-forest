#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone");
const transcript = JSON.parse(
  await readFile(resolve(task, "evidence/e5-t14-browser.json"), "utf8"),
);

assert.match(transcript.sourceHead, /^[0-9a-f]{40}$/);
assert.deepEqual(transcript.viewports, {
  desktop: [1440, 900],
  mobile: [390, 844],
  deviceScaleFactor: 1,
});
assert.equal(transcript.reducedMotion, true);
assert.equal(transcript.captures.length, 13);
assert.equal(transcript.captures.filter((item) => item.viewport === "desktop").length, 9);
assert.equal(transcript.captures.filter((item) => item.viewport === "mobile").length, 4);
assert.deepEqual(transcript.consoleErrors, []);
assert.deepEqual(transcript.pageErrors, []);
assert.deepEqual(transcript.requestFailures, []);
assert.equal(
  transcript.terminalLongPolls.every(
    (failure) =>
      /\/events(?:\?|\s)/.test(failure) && /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure),
  ),
  true,
);
assert.deepEqual(transcript.repositoryTabs, [
  "Code",
  "Pull Requests",
  "Issues",
  "Wiki",
  "Settings",
]);
assert.deepEqual(transcript.prTabs, ["Activity", "Commits", "Checks", "Changes"]);
assert.deepEqual(transcript.adapters, {
  markdown: "@brett_lamy/docstream",
  diffs: "@pierre/diffs",
  trees: "@pierre/trees",
  desktop: "shadcn source",
  mobile: "@brett_lamy/ui@0.0.1",
});

for (const capture of transcript.captures) {
  const bytes = await readFile(resolve(task, "evidence/actual", capture.name));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256, capture.name);
  assert.ok(bytes.byteLength > 20_000, `${capture.name} is implausibly small`);
}

console.log("E5_T14_BROWSER_EVIDENCE_OK captures=13 errors=0");
