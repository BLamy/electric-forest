#!/usr/bin/env node
// E2-T07 sensitivity: prove the authorization apparatus goes red when the
// decision function is sabotaged.
//
// Each case copies the compiled platform dist next to the real one (so
// workspace imports still resolve), applies one anchored sabotage to
// dist copy's authz/decide.js, and drives the end-to-end probe against it.
// A pristine copy must pass first (green control); every sabotage must fail
// the probe with exactly its predicted case marker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLATFORM = path.join(ROOT, "packages/platform");
const DIST = path.join(PLATFORM, "dist");
const PROBE = path.join(ROOT, "tools/verify/e2_t07_probe.mjs");
assert.ok(fs.existsSync(path.join(DIST, "src/index.js")), "platform dist is not built");

const SABOTAGES = [
  {
    label: "visibility-leak",
    marker: "case=private-anonymous-read",
    anchor: 'const readBasis = repo.visibility === "public"',
    replacement: 'const readBasis = repo.visibility !== "public"',
  },
  {
    label: "write-grant-bypass",
    marker: "case=write-grant-required",
    anchor:
      "grant.scopes.some((scope) => writeScopeMatches(scope, target.org, target.repo, target.branch))",
    replacement: "true",
  },
  {
    label: "existence-oracle",
    marker: "case=not-found-indistinguishable",
    anchor:
      'if (operation !== "dispatch") {\n        if (readBasis !== undefined)\n            return allow(readBasis, target.streamId);\n        return refuse("authz/not-found");\n    }',
    replacement:
      'if (operation !== "dispatch") {\n        if (readBasis !== undefined)\n            return allow(readBasis, target.streamId);\n        return refuse(sub === undefined ? "authz/not-found" : "authz/forbidden");\n    }',
  },
];

function runProbe(distCopy) {
  return spawnSync(process.execPath, [PROBE, path.join(distCopy, "src/index.js")], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function withDistCopy(name, work) {
  const copy = path.join(PLATFORM, `dist-e2t07-${name}`);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(DIST, copy, { recursive: true });
  try {
    return work(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// --- green control: the copied, unmutated dist passes the probe -----------
withDistCopy("control", (copy) => {
  const result = runProbe(copy);
  if (result.status !== 0 || !result.stdout.includes("PROBE_OK")) {
    console.error(result.stdout);
    console.error(result.stderr);
    assert.fail("E2-T07 sensitivity: zero-mutation control went RED (harness is broken)");
  }
  console.log("control: PROBE_OK (green)");
});

// --- each sabotage must go red with its exact predicted case --------------
for (const sabotage of SABOTAGES) {
  withDistCopy(sabotage.label, (copy) => {
    const decidePath = path.join(copy, "src/authz/decide.js");
    const source = fs.readFileSync(decidePath, "utf8");
    const occurrences = source.split(sabotage.anchor).length - 1;
    assert.equal(occurrences, 1, `${sabotage.label}: anchor missing or duplicated`);
    fs.writeFileSync(decidePath, source.replace(sabotage.anchor, sabotage.replacement));
    const result = runProbe(copy);
    assert.notEqual(result.status, 0, `${sabotage.label}: sabotage stayed green`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(
      output.includes(sabotage.marker),
      `${sabotage.label}: expected failure at ${sabotage.marker}, got:\n${output}`,
    );
    console.log(`${sabotage.label}: expected-red at ${sabotage.marker}`);
  });
}

console.log("E2_T07_SENSITIVITY_OK control=green cases=3");
