import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const task = resolve(root, ".eforest/tasks/epic-4-the-roots/E4-T06-uplink-local-to-stream");
const evidence = resolve(task, "evidence");
const branchPath = resolve(evidence, "e4-t06-branch-log.jsonl");
const goldenPath = resolve(evidence, "e4-t06-golden-shape.jsonl");
const journalPath = resolve(evidence, "e4-t06-journal.jsonl");

function lines(path) {
  const source = readFileSync(path, "utf8");
  assert.equal(source.length === 0 || source.endsWith("\n"), true, `${path} must end in LF`);
  return source.length === 0 ? [] : source.trimEnd().split("\n");
}

function jsonLines(path) {
  return lines(path).map((line, index) => {
    const value = JSON.parse(line);
    assert.equal(`${canonicalJson(value)}\n`, `${line}\n`, `${path}:${index + 1} is not canonical`);
    return value;
  });
}

const branch = jsonLines(branchPath);
const golden = jsonLines(goldenPath);
const journal = jsonLines(journalPath);
assert.equal(branch.length, golden.length, "golden shape length");
assert.deepEqual(
  branch.map((record) => ({ type: record.type, path: record.payload.path })),
  golden,
  "projected branch shape differs from golden",
);

const accepted = journal.filter((record) => record.kind === "accepted");
assert.equal(
  new Set(journal.map((record) => record.seq)).size,
  journal.length,
  "journal seq duplicate",
);
journal.forEach((record, index) => assert.equal(record.seq, index + 1, "journal seq gap"));
const cited = new Set();
for (const record of accepted) {
  assert.equal(cited.has(record.offset), false, `duplicate journal citation ${record.offset}`);
  cited.add(record.offset);
  const event = branch.find((candidate) => candidate.offset === record.offset);
  assert.ok(event, `journal offset ${record.offset} is absent from the dump`);
  assert.equal(event.type, record.action);
  assert.equal(event.payload.path, record.path);
}
assert.equal(cited.size, branch.length, "dump event is not cited exactly once");

const bases = new Map();
for (const record of branch) {
  const path = record.payload.path;
  if (record.type === "fs.file.create") {
    if (!bases.has(path)) bases.set(path, "BASE_NONE");
  } else if (record.type === "fs.file.write" || record.type === "fs.file.patch") {
    const journalRecord = accepted.find((entry) => entry.offset === record.offset);
    assert.ok(journalRecord, `content event ${record.offset} has no journal record`);
    assert.equal(record.payload.base, bases.get(path) ?? "BASE_NONE", `base chain ${path}`);
    bases.set(path, record.offset);
  } else if (record.type === "fs.file.delete") {
    bases.delete(path);
  }
}

const digestText = readFileSync(resolve(evidence, "e4-t06-digests.txt"), "utf8");
const digestValues = [
  ...digestText.matchAll(
    /(?:local ef tree-digest|server ef replay --digest --reducer): ([0-9a-f]{64})/g,
  ),
].map((match) => match[1]);
assert.equal(digestValues.length, 2, "digest evidence must contain two instruments");
assert.equal(digestValues[0], digestValues[1], "local and replay digests diverge");
const replay = spawnSync(
  process.execPath,
  [
    resolve(root, "packages/cli/dist/src/bin.js"),
    "replay",
    branchPath,
    "--digest",
    "--reducer",
    resolve(root, "packages/streamfs/reducer.mjs"),
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(replay.status, 0, replay.stderr);
assert.equal(replay.stdout.trim(), digestValues[1], "committed replay digest changed");

const sensitivity = readFileSync(resolve(evidence, "e4-t06-sensitivity.md"), "utf8");
assert.ok((sensitivity.match(/EXPECTED-FAIL OK/g) ?? []).length >= 5, "sensitivity is incomplete");
assert.equal(
  branch.some((record) => String(record.payload.path ?? "").startsWith(".ef")),
  false,
);
assert.equal(
  branch.some((record) => /(?:~|\.swp$|\.swo$|\.tmp$)/.test(record.payload.path ?? "")),
  false,
);
console.log(
  `E4-T06_VERIFY shape=${branch.length} accepted=${accepted.length} digest=${digestValues[0]}`,
);
