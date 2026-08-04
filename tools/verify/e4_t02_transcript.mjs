#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const task = resolve(root, ".eforest/tasks/epic-4-the-roots/E4-T02-ef-init-adopt");
const evidence = resolve(task, "evidence");
const cli = resolve(root, "packages/cli/dist/src/bin.js");
const work = mkdtempSync(join(tmpdir(), "eforest-e4-t02-"));
const fixture = join(work, "fixture");
mkdirSync(join(fixture, "nested"), { recursive: true });
writeFileSync(join(fixture, "nested", "hello.txt"), "hello\n");
writeFileSync(join(fixture, "empty.bin"), Buffer.alloc(0));

const digestBytes = (value) => createHash("sha256").update(value).digest("hex");
const emptyDigest = digestBytes(Buffer.alloc(0));
const helloDigest = digestBytes(Buffer.from("hello\n"));
const metadata = [
  ["fs.branch.genesis", { v: 1, branch: "main" }],
  ["fs.dir.create", { v: 2, path: "nested" }],
  ["fs.file.create", { v: 2, path: "empty.bin", contentStreamId: "fs:golden:main:file:1" }],
  [
    "fs.file.write",
    { v: 2, path: "empty.bin", base: "BASE_NONE", contentSha256: emptyDigest, size: 0 },
  ],
  ["fs.file.create", { v: 2, path: "nested/hello.txt", contentStreamId: "fs:golden:main:file:2" }],
  [
    "fs.file.write",
    { v: 2, path: "nested/hello.txt", base: "BASE_NONE", contentSha256: helloDigest, size: 6 },
  ],
].map(([type, payload], index) => ({
  offset: offsetForOrdinal(index),
  type,
  payload,
  ts: index,
}));
const golden = resolve(evidence, "e4-t02-init-golden.jsonl");
const encodeRecords = (records) => `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
assert.equal(
  readFileSync(golden, "utf8"),
  encodeRecords(metadata),
  "the committed golden must be the fixture's frozen metadata stream",
);
assert.doesNotMatch(readFileSync(golden, "utf8"), /\.ef\//, "golden contains workspace paths");

function runEf(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const replay = runEf(["replay", golden, "--worktree-digest"]);
assert.equal(replay.status, 0, replay.stderr);
assert.match(replay.stdout, /^[0-9a-f]{64}\n$/);
const tree = runEf(["tree-digest", fixture]);
assert.equal(tree.status, 0, tree.stderr);
assert.equal(replay.stdout, tree.stdout, "replay and local worktree digests diverged");
assert.equal(
  readFileSync(resolve(evidence, "e4-t02-init-golden.digest"), "utf8"),
  replay.stdout,
  "the committed replay digest is stale",
);
assert.equal(
  readFileSync(resolve(evidence, "e4-t02-tree.digest"), "utf8"),
  tree.stdout,
  "the committed worktree digest is stale",
);

const mutated = join(work, "mutated.jsonl");
const source = String(metadata.map((record) => canonicalJson(record)).join("\n"));
const changed = source.replace(helloDigest, `0${helloDigest.slice(1)}`);
writeFileSync(mutated, `${changed}\n`);
const mutation = runEf(["replay", mutated, "--worktree-digest"]);
assert.equal(mutation.status, 0, mutation.stderr);
assert.notEqual(mutation.stdout, tree.stdout, "digest mutation stayed green");

const noCredentialDir = join(work, "no-credentials");
mkdirSync(noCredentialDir);
const noCredential = runEf(["init", "--org", "acme", noCredentialDir], {
  EF_HOME: join(work, "missing-home"),
  EF_SERVER_URL: "http://127.0.0.1:1",
});
assert.equal(noCredential.status, 10, noCredential.stderr);
assert.match(noCredential.stderr, /no-credentials/);

const vitest = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--maxWorkers=1", "packages/cli/src/init.test.ts"],
  { cwd: root, encoding: "utf8", env: process.env },
);
assert.equal(vitest.status, 0, `${vitest.stdout}\n${vitest.stderr}`);
const transcript = [
  "E4-T02 init transcript",
  "local command: ef tree-digest <fixture>",
  `tree digest: ${tree.stdout.trim()}`,
  "replay command: ef replay e4-t02-init-golden.jsonl --worktree-digest",
  `replay digest: ${replay.stdout.trim()}`,
  "digest equation: PASS",
  "branch genesis, workspace checkpoint, and .ef hygiene: PASS (packages/cli/src/init.test.ts)",
  "same-project second-repo skip: PASS (one project create, two repo creates)",
  "registry visibility: PASS (fs:acme/garden and fs:acme/second)",
  "real gateway /registry/me: PASS (fs:acme/adopted, authenticated owner, revoked 401)",
  "verify-before-commit mismatch: PASS (exit 15, no .ef)",
  "same-project name collision: PASS (ns/name-taken, namespace byte-identical)",
  "fresh-project name collision: PASS (one honest project event, no repo append)",
  "401 token refusal: PASS (exit 13, no namespace/repo append, no .ef)",
  "already-initialized request count: PASS (packages/cli/src/init.test.ts)",
  `no-credentials exit: ${String(noCredential.status)} (zero-request local refusal)`,
  "sensitivity: PASS (one digest byte changed the replay result)",
  "E4_T02_INIT_OK",
  "Replay: N/A (CLI + stream-layer change; no browser-reaching surface) + mitigation: committed init integration test, deterministic replay golden, and mutation transcript.",
  "",
].join("\n");
assert.equal(
  readFileSync(resolve(evidence, "e4-t02-transcript.txt"), "utf8"),
  transcript,
  "the committed transcript is stale or self-authored by the verifier",
);
assert.equal(
  readFileSync(resolve(evidence, "e4-t02-sensitivity.md"), "utf8"),
  "# E4-T02 sensitivity\n\n- Flipping one byte of `e4-t02-init-golden.jsonl` changed the replay worktree digest and failed the byte-equality assertion.\n- The committed init integration test exercises the shared E4-T01 walker, `.ef/` exclusion, workspace checkpoint, same-project second-repo project-create skip, registry repo-prefix projection, real gateway `/registry/me` visibility and revoked-token 401, verify-before-commit mismatch refusal, same-project and fresh-project `ns/name-taken` collisions, 401 refusal, and zero-request already-initialized refusal.\n- Tokenless init returned exit `10` before contacting the closed server.\n",
  "the committed sensitivity report is stale or self-authored by the verifier",
);
process.stdout.write(
  `E4_T02_INIT_OK digest=${replay.stdout.trim()} head=${metadata.at(-1).offset} mutation=red no-credentials=10\n`,
);
rmSync(work, { recursive: true, force: true });
