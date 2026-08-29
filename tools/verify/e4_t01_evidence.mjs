import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T01-worktree-digest-and-ef-format/evidence",
);
const fixture = join(evidence, "fixture-tree");
const golden = join(evidence, "golden-worktree.jsonl");
const expected = readFileSync(join(evidence, "golden-worktree.digest"), "utf8").trim();
const cli = join(root, "packages/cli/dist/src/bin.js");

function ef(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function digest(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, "", `${label}: unexpected stderr`);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
  return result.stdout.trim();
}

const fixtureDigest = digest(ef("tree-digest", fixture), "tree-digest fixture");
const replayDigest = digest(ef("replay", golden, "--worktree-digest"), "replay worktree digest");
const materialized = mkdtempSync(join(tmpdir(), "eforest-e4-t01-materialized-"));
const materializeDigest = digest(
  ef("materialize", golden, "--out", materialized, "--worktree-digest"),
  "materialize digest",
);
assert.equal(fixtureDigest, expected);
assert.equal(replayDigest, expected);
assert.equal(materializeDigest, expected);
assert.equal(digest(ef("tree-digest", fixture), "tree-digest repeat"), expected);
assert.equal(digest(ef("replay", golden, "--worktree-digest"), "replay repeat"), expected);
assert.equal(digest(ef("tree-digest", materialized), "materialized tree-digest"), expected);
const defaultOtherCwd = spawnSync(process.execPath, [cli, "tree-digest", fixture], {
  cwd: tmpdir(),
  encoding: "utf8",
  env: { ...process.env },
});
assert.equal(defaultOtherCwd.status, 0, defaultOtherCwd.stderr);
assert.equal(defaultOtherCwd.stdout, `${expected}\n`);
const deterministic = spawnSync(
  "/bin/sh",
  [
    "-c",
    `umask 077; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} tree-digest ${JSON.stringify(fixture)}`,
  ],
  {
    cwd: "/tmp",
    encoding: "utf8",
    env: { ...process.env, TZ: "Pacific/Kiritimati", LANG: "C", PATH: "/usr/bin:/bin" },
  },
);
assert.equal(deterministic.status, 0, deterministic.stderr);
assert.equal(deterministic.stdout, `${expected}\n`);
console.log(
  "DETERMINISM: default cwd=repo and default cwd=tmp plus TZ=Pacific/Kiritimati LANG=C PATH=/usr/bin:/bin umask=077 from /tmp match",
);

const direct = await import(join(root, "packages/streamfs/dist/src/index.js"));
const nodeWorktree = await import(join(root, "packages/streamfs/dist/src/worktree-node.js"));
assert.equal(nodeWorktree.worktreeDigestDirectory(fixture), expected);
assert.equal(
  direct.worktreeDigest({
    files: { "a.txt": { contentSha256: "0".repeat(64), size: 0, contentStreamId: "one" } },
  }),
  direct.worktreeDigest({
    files: { "a.txt": { contentSha256: "0".repeat(64), size: 0, contentStreamId: "two" } },
  }),
);

const mutated = mkdtempSync(join(tmpdir(), "eforest-e4-t01-mutated-"));
cpSync(fixture, mutated, { recursive: true });
const blob = join(mutated, "blob.bin");
const bytes = readFileSync(blob);
bytes[0] ^= 0xff;
writeFileSync(blob, bytes);
const mutationDigest = digest(ef("tree-digest", mutated), "mutated tree-digest");
assert.notEqual(mutationDigest, expected);
console.log(`MUTATION fixture=fixture-tree byte=0 digest-mismatch EXPECTED-FAIL OK`);

const source = readFileSync(join(root, "packages/cli/src/worktree-command.ts"), "utf8");
const forbidden = [
  /createHash/g,
  /crypto\.subtle/g,
  /\bsha-?256\b/gi,
  /sort_keys/g,
  /JSON\.stringify/g,
  /\.sort\s*\(/g,
];
for (const pattern of forbidden)
  assert.equal(pattern.test(source), false, `forbidden CLI token: ${pattern}`);
assert.match(
  readFileSync(join(root, "packages/cli/src/replay-command.ts"), "utf8"),
  /worktreeDigest/,
);
assert.match(
  readFileSync(join(root, "packages/cli/src/materialize-command.ts"), "utf8"),
  /worktreeDigest/,
);
const base = spawnSync("git", ["merge-base", "HEAD", "origin/codex/e3-t10-reading-room"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
assert.match(base, /^[0-9a-f]{40}$/);
const changedLines = spawnSync(
  "git",
  ["diff", `${base}..HEAD`, "--", "packages/cli/src/worktree-command.ts"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .stdout.split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n");
for (const pattern of forbidden)
  assert.equal(pattern.test(changedLines), false, `forbidden added CLI token: ${pattern}`);
console.log(
  "FORBIDDEN-CLI-TOKENS: empty worktree-command.ts and changed worktree-command additions",
);

const workspace = await import(join(root, "packages/workspace/dist/src/index.js"));
const fixtureNames = [
  ["v2.json", "unknown-version"],
  ["truncated.json", "invalid-json"],
  ["extra-field.json", "invalid-schema"],
  ["wrong-type.json", "invalid-schema"],
  ["duplicate-ledger-key.json", "duplicate-key"],
];
for (const [name, code] of fixtureNames) {
  const dir = mkdtempSync(join(tmpdir(), "eforest-e4-t01-workspace-"));
  const target = join(dir, ".ef");
  const fs = await import("node:fs");
  fs.mkdirSync(target);
  fs.copyFileSync(join(evidence, "ef-fixtures", name), join(target, "workspace.json"));
  assert.throws(
    () => workspace.load(dir),
    (error) => error?.code === code,
    name,
  );
}
console.log(
  "WORKSPACE-REFUSALS: valid, unknown-version, truncated, extra-field, wrong-type, duplicate-ledger-key",
);
console.log("E4-T01 evidence: OK");
