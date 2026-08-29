#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T03-issue-board-derived-stream/evidence/golden-board",
);
const script = join(evidence, "script.ts");
const cli = join(root, "packages/cli/dist/src/bin.js");
const labelReducer = join(root, "packages/issues/label-reducer.mjs");
const expected = [
  "after-state-change.digest",
  "board.digest",
  "board.json",
  "live-update.txt",
  "logs/ns-org-maple.jsonl",
  "logs/ns-root.jsonl",
  "logs/issue-i-00.jsonl",
  "logs/issue-i-01.jsonl",
  "logs/issue-i-02.jsonl",
  "logs/issue-i-03.jsonl",
  "logs/issue-i-04.jsonl",
  "logs/issue-i-05.jsonl",
  "logs/issue-i-06.jsonl",
  "logs/repo-issues.jsonl",
  "logs/repo-labels.jsonl",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesBelow(directory, base = directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesBelow(path, base));
    else if (entry.isFile()) result.push(relative(base, path));
  }
  return result;
}

const protectedPaths = [script, ...expected.map((path) => join(evidence, path))];
const before = new Map(protectedPaths.map((path) => [path, sha256(path)]));
const output = mkdtempSync(join(tmpdir(), "eforest-e5-t03-evidence-"));
try {
  const environment = { ...process.env, LANG: "C", TZ: "Pacific/Kiritimati" };
  delete environment.NODE_ENV;
  delete environment.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", script, output], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: environment,
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  assert.equal(run.status, 0, "golden seed failed");
  assert.equal((run.stdout.match(/^REBUILD digest=.* identical OK$/gm) ?? []).length, 1);
  assert.equal((run.stdout.match(/^LIVE offset=.* digest=.* OK$/gm) ?? []).length, 1);
  assert.equal(
    (run.stdout.match(/^FOLD digest=.* permutations=3 identical OK$/gm) ?? []).length,
    1,
  );

  const generated = filesBelow(output)
    .filter((path) => !path.startsWith(".server/") && !path.startsWith(".cache/"))
    .sort();
  assert.deepEqual(generated, [...expected].sort(), "generated artifact inventory drifted");
  for (const path of expected) {
    const actualPath = join(output, path);
    const expectedPath = join(evidence, path);
    assert.equal(statSync(actualPath).isFile(), true);
    assert.deepEqual(readFileSync(actualPath), readFileSync(expectedPath), `${path}: golden drift`);
  }
  const labelDigests = ["UTC", "Pacific/Kiritimati"].map((timezone) => {
    const replay = spawnSync(
      process.execPath,
      [
        cli,
        "replay",
        join(evidence, "logs/repo-labels.jsonl"),
        "--digest",
        "--reducer",
        labelReducer,
      ],
      { cwd: tmpdir(), encoding: "utf8", env: { ...environment, TZ: timezone } },
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /^[0-9a-f]{64}\n$/);
    return replay.stdout.trim();
  });
  assert.equal(labelDigests[1], labelDigests[0], "label replay digest changed across processes");
  for (const path of protectedPaths) {
    assert.equal(sha256(path), before.get(path), `${path}: verifier rewrote committed evidence`);
  }
  console.log(
    `E5_T03_EVIDENCE_OK artifacts=${expected.length} protected=${protectedPaths.length} label-digest=${labelDigests[0]}`,
  );
} finally {
  rmSync(output, { recursive: true, force: true });
}
