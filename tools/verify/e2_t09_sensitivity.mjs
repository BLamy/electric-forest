#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const platform = path.join(root, "packages/platform");
const dist = path.join(platform, "dist");
const probe = path.join(root, "tools/verify/e2_t09_probe.mjs");
const sabotages = [
  {
    label: "lane-replay-reset",
    marker: "case=lane-replay",
    anchor: "const previous = entry?.[1] ?? 0;",
    replacement: "const previous = 0;",
  },
  {
    label: "client-actor-trust",
    marker: "case=server-stamp",
    anchor: "actor: subject,",
    replacement: 'actor: typeof payload.actor === "string" ? payload.actor : subject,',
  },
  {
    label: "precondition-bypass",
    marker: "case=precondition-recheck",
    anchor: "await options.validate?.(records, stamped);",
    replacement: "void options.validate;",
  },
  {
    label: "actor-writer-parity",
    marker: "case=actor-writer-parity",
    anchor: 'typeof actor !== "string" || actor.length === 0 || actor !== writer.sub',
    replacement: "false",
  },
  {
    label: "operation-event-binding",
    marker: "case=operation-event-binding",
    anchor: "canonicalJson(existing) !== canonicalJson(expected)",
    replacement: "false",
  },
  {
    label: "operation-replay-order",
    marker: "case=operation-replay-order",
    anchor: "const lanes = reduceWriterLanes(records);",
    replacement:
      "const lanes = options.operationId === undefined ? reduceWriterLanes(records) : {};",
  },
];

function withCopy(label, work) {
  const copy = path.join(platform, `dist-e2t09-${label}`);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(dist, copy, { recursive: true });
  try {
    work(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

function run(copy) {
  return spawnSync(process.execPath, [probe, path.join(copy, "src/index.js")], {
    cwd: root,
    encoding: "utf8",
  });
}

withCopy("control", (copy) => {
  const result = run(copy);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /E2_T09_PROBE_OK/);
  console.log("control: E2_T09_PROBE_OK (green)");
});

for (const sabotage of sabotages) {
  withCopy(sabotage.label, (copy) => {
    const target = path.join(copy, "src/writer-lanes.js");
    const source = fs.readFileSync(target, "utf8");
    assert.equal(source.split(sabotage.anchor).length - 1, 1, `${sabotage.label}: anchor count`);
    fs.writeFileSync(target, source.replace(sabotage.anchor, sabotage.replacement));
    const result = run(copy);
    assert.notEqual(result.status, 0, `${sabotage.label}: sabotage stayed green`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(sabotage.marker));
    console.log(`${sabotage.label}: expected-red at ${sabotage.marker}`);
  });
}
console.log(`E2_T09_SENSITIVITY_OK control=green cases=${String(sabotages.length)}`);
