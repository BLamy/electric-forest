#!/usr/bin/env node

import { readFileSync } from "node:fs";

const task = readFileSync(
  ".eforest/tasks/epic-5-the-meadow/E5-T07-cross-entity-linking/readme.md",
  "utf8",
);
const packageReadme = readFileSync("packages/meadow/README.md", "utf8");

for (const name of ["entity-ref", "propagation-rules", "post-terminal-links"]) {
  const pattern = new RegExp(
    `<!-- frozen:E5-T07:${name} -->[\\s\\S]*?<!-- /frozen:E5-T07:${name} -->`,
  );
  const expected = task.match(pattern)?.[0];
  const actual = packageReadme.match(pattern)?.[0];
  if (expected === undefined || actual === undefined || actual !== expected) {
    throw new Error(`E5-T07 frozen block drift: ${name}`);
  }
  console.log(`CONTRACT block=${name} byte-identical OK`);
}

const planner = readFileSync("packages/meadow/src/links/propagate.ts", "utf8");
const issueReducer = readFileSync("packages/issues/src/issueReducer.ts", "utf8");
const prReducer = readFileSync("packages/meadow/src/pr/reducer.ts", "utf8");
const gateway = readFileSync("packages/platform/src/gateway.ts", "utf8");
const registry = readFileSync("packages/reducers/src/index.ts", "utf8");
const tests = [
  "packages/meadow/test/links.plan.test.ts",
  "packages/platform/test/issue-linking.test.ts",
  "packages/platform/test/cross-entity-linking.test.ts",
  "packages/platform/test/cross-entity-linking.rework.test.ts",
  "packages/platform/test/cross-entity-linking.file.test.ts",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

for (const token of [
  "planLinkPropagation",
  "driveLinkPropagation",
  'kind: "append-issue-link"',
  'kind: "append-issue-close"',
  'kind: "append-pr-link-closed"',
  'kind: "append-pr-link-noop"',
  "isFenceRefusal",
]) {
  if (!planner.includes(token)) throw new Error(`E5-T07 planner token missing: ${token}`);
}

for (const token of ["issue.linked", "closedBy", "stateChangedVia"]) {
  if (!issueReducer.includes(token)) throw new Error(`E5-T07 issue token missing: ${token}`);
}
for (const token of ["isPrLinkClosedEvent", "isPrLinkNoopEvent", "closes", "links"]) {
  if (!prReducer.includes(token)) throw new Error(`E5-T07 PR token missing: ${token}`);
}
for (const token of [
  "drivePrLinks(",
  "appendPropagatedIssueEvent(",
  "appendPropagatedPrLink(",
  "LinkPropagationFenceError",
  "LinkPropagationCommitError",
  "readIssueLinkRecords(",
  "validatePrOpenedLinkTargets(",
  "E5_T07_PRECOMMIT_TARGET_BOUNDARY",
  "existingOpenedTrigger(",
  "existingMergedTrigger(",
]) {
  if (!gateway.includes(token)) throw new Error(`E5-T07 dispatch token missing: ${token}`);
}
for (const token of [
  "target-boundary:",
  "operation-id target boundary",
  "partial-propagation:",
  "crash-window target-to-PR:",
  "crash-window PR-to-issue:",
  "crash-window issue-to-PR:",
  "fence-replan:",
  "multi-ref + idempotence:",
  "close-without-merge:",
  "file-backed golden lifecycle",
]) {
  if (!tests.includes(token)) throw new Error(`E5-T07 permanent hostile check missing: ${token}`);
}
if (!registry.includes("meadowPrReducer")) {
  throw new Error("E5-T07 composed PR reducer is not registered for offline replay");
}

const reducers = `${issueReducer}\n${prReducer}`;
if (/\b(?:dispatch|append|fetch)\s*\(/.test(reducers)) {
  throw new Error("E5-T07 reducer contains a side effect");
}
if (/\.(?:skip|todo)\s*\(/.test(`${planner}\n${gateway}\n${tests}`)) {
  throw new Error("E5-T07 implementation contains a disabled check");
}

console.log("CONTRACT propagation=dispatch-only reducers=pure OK");
console.log("CONTRACT replay-registry=meadow-pr OK");
