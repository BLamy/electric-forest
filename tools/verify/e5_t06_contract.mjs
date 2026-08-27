#!/usr/bin/env node

import { readFileSync } from "node:fs";

const task = readFileSync(
  ".eforest/tasks/epic-5-the-meadow/E5-T06-pr-merge-execution/readme.md",
  "utf8",
);
const packageReadme = readFileSync("packages/meadow/README.md", "utf8");

for (const name of ["outcome-events", "gate-and-refusals", "recovery"]) {
  const pattern = new RegExp(
    `<!-- frozen:E5-T06:${name} -->[\\s\\S]*?<!-- /frozen:E5-T06:${name} -->`,
  );
  const expected = task.match(pattern)?.[0];
  const actual = packageReadme.match(pattern)?.[0];
  if (expected === undefined || actual === undefined || actual !== expected) {
    throw new Error(`E5-T06 frozen block drift: ${name}`);
  }
  console.log(`CONTRACT block=${name} byte-identical OK`);
}

const implementation = [
  "packages/meadow/src/pr/merge-executor.ts",
  "packages/meadow/src/pr/events.ts",
  "packages/meadow/src/pr/reducer.ts",
  "packages/meadow/src/pr/validate.ts",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

for (const token of [
  '"pr.merge"',
  '"pr.merged"',
  '"pr.merge-conflicted"',
  '"pr/merge-not-approved"',
  '"pr/already-merged"',
  '"pr/merge-evidence-missing"',
  "compareOffsets",
]) {
  if (!implementation.includes(token)) throw new Error(`E5-T06 contract token missing: ${token}`);
}

if (/\.(?:skip|todo)\s*\(/.test(implementation) || /eslint-disable/.test(implementation)) {
  throw new Error("E5-T06 implementation contains a disabled check");
}

const gateway = readFileSync("packages/platform/src/gateway.ts", "utf8");
for (const token of [
  "executePrMerge(",
  'parsed.event.type === "pr.merge"',
  "validatePrMergeCommand(parsed.event)",
  "validatePrMergeOutcome(outcome)",
  "receipt.prOutcomeOffset",
]) {
  if (!gateway.includes(token)) throw new Error(`E5-T06 platform door token missing: ${token}`);
}

console.log("CONTRACT merge-door-vocabulary complete OK");
