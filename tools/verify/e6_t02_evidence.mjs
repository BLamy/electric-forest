#!/usr/bin/env node
// verify-E6-T02: hold every frozen fixture to its committed hash, byte-compare
// parse -> render against the committed goldens, re-execute every refusal to a
// byte-identical transcript line with the fixture tree untouched, run the 1,000-folder
// property corpus in two fresh processes, prove the work/-vs-evidence/ digest boundary
// on a scratch copy, and print the duplicate-key sabotage sentinel.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  readTaskFolderSnapshot,
  writeRenderedTaskFolder,
} from "../../packages/tasks/dist/io/disk.js";
import {
  E6_T02_DUPLICATE_KEY_GUARD,
  TASK_FOLDER_REFUSAL_REASONS,
  evidenceManifest,
  parseTaskFolder,
  renderTaskFolder,
  snapshotOfRendered,
  taskFolderDigest,
  taskFolderValue,
} from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".eforest/tasks/epic-6-the-loop/E6-T02-task-folder-contract/evidence");
const fixtures = join(evidence, "fixtures");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic listing of a tree: files hashed, symlinks recorded by target, never followed. */
function treeListing(dir, relative = "") {
  const lines = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) lines.push(`symlink ${rel} -> ${readlinkSync(path)}`);
    else if (entry.isDirectory()) lines.push(...treeListing(path, rel));
    else lines.push(`${sha256(readFileSync(path))}  ${rel}`);
  }
  return lines;
}

// 1. Fixture hashes: the tree must equal the committed list exactly, before anything runs.
const frozenListing = readFileSync(join(evidence, "e6-t02-fixtures.sha256"), "utf8");
const liveListing = `${treeListing(fixtures).join("\n")}\n`;
assert.equal(liveListing, frozenListing, "fixture tree drifted from e6-t02-fixtures.sha256");
const protectedFiles = [
  "e6-t02-fixtures.sha256",
  "e6-t02-refusals.txt",
  "e6-t02-property.txt",
  "e6-t02-sabotage.txt",
];
for (const name of readdirSync(join(evidence, "goldens"))) protectedFiles.push(`goldens/${name}`);
const before = new Map(
  protectedFiles.map((name) => [name, sha256(readFileSync(join(evidence, name)))]),
);
console.log(
  `E6_T02_FIXTURES entries=${liveListing.trimEnd().split("\n").length} sha256-list-identical=true`,
);

// 2. Valid fixtures: parse -> render byte-compared to the committed goldens; fixed point.
const parseOk = (snapshot) => {
  const result = parseTaskFolder(snapshot);
  assert.ok(
    result.ok,
    `${snapshot.folderName}: ${JSON.stringify(result.ok ? null : result.refusal)}`,
  );
  return result.folder;
};
const same = (a, b) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
const validNames = readdirSync(join(fixtures, "valid")).sort();
assert.deepEqual(validNames, ["E9-T01-minimal", "E9-T02-complete", "E9-T03-noncanonical"]);
const digests = {};
for (const name of validNames) {
  const folder = parseOk(readTaskFolderSnapshot(join(fixtures, "valid", name)));
  const golden = JSON.parse(readFileSync(join(evidence, "goldens", `${folder.id}.json`), "utf8"));
  assert.equal(
    canonicalJson(taskFolderValue(folder)),
    canonicalJson(golden.value),
    `${name}: value`,
  );
  assert.equal(taskFolderDigest(folder), golden.digest, `${name}: digest`);
  const rendered = renderTaskFolder(folder);
  assert.deepEqual(
    rendered.files.map((file) => ({
      path: file.path,
      size: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
    golden.rendered,
    `${name}: rendered file set`,
  );
  const readme = rendered.files.find((file) => file.path === "readme.md");
  assert.ok(
    same(
      readme.bytes,
      new Uint8Array(readFileSync(join(evidence, "goldens", `${folder.id}.readme.md`))),
    ),
    `${name}: readme golden`,
  );
  const again = parseOk(snapshotOfRendered(rendered));
  const twice = renderTaskFolder(again);
  assert.equal(twice.files.length, rendered.files.length);
  for (const [index, file] of rendered.files.entries())
    assert.ok(same(twice.files[index].bytes, file.bytes), `${name}: ${file.path} fixed point`);
  assert.equal(
    canonicalJson(taskFolderValue(parseOk(snapshotOfRendered(twice)))),
    canonicalJson(taskFolderValue(again)),
  );
  digests[folder.id] = golden.digest;
  console.log(
    `E6_T02_GOLDEN ${folder.id} digest=${golden.digest} files=${rendered.files.length} evidence=${folder.evidence.length} byte-identical=true`,
  );
}

// 3. Refusals: every frozen scenario re-executes to a byte-identical transcript line, and
//    the fixture tree is untouched afterwards (no rendered output, no files changed).
const transcript = readFileSync(join(evidence, "e6-t02-refusals.txt"), "utf8");
assert.ok(transcript.endsWith("\n"));
const frozenLines = transcript.slice(0, -1).split("\n");
const inline = JSON.parse(readFileSync(join(fixtures, "invalid-snapshots.json"), "utf8"));
const liveLines = [];
for (const name of readdirSync(join(fixtures, "invalid")).sort()) {
  const [folder] = readdirSync(join(fixtures, "invalid", name));
  const result = parseTaskFolder(readTaskFolderSnapshot(join(fixtures, "invalid", name, folder)));
  liveLines.push(
    `E6_T02_REFUSAL ${canonicalJson({ name, source: "disk", folderName: folder, ok: result.ok, refusal: result.ok ? null : result.refusal })}`,
  );
}
for (const scenario of inline) {
  const entries = scenario.entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    ...(entry.text !== undefined
      ? { bytes: new TextEncoder().encode(entry.text) }
      : entry.base64 !== undefined
        ? { bytes: new Uint8Array(Buffer.from(entry.base64, "base64")) }
        : {}),
  }));
  const result = parseTaskFolder({ folderName: scenario.folderName, entries });
  liveLines.push(
    `E6_T02_REFUSAL ${canonicalJson({ name: scenario.name, source: "inline", folderName: scenario.folderName, ok: result.ok, refusal: result.ok ? null : result.refusal })}`,
  );
}
assert.deepEqual(liveLines, frozenLines, "refusal transcript drifted");
const reasonsSeen = new Set(
  frozenLines.map((line) => JSON.parse(line.slice("E6_T02_REFUSAL ".length)).refusal?.reason),
);
for (const line of frozenLines)
  assert.equal(JSON.parse(line.slice("E6_T02_REFUSAL ".length)).ok, false);
for (const reason of TASK_FOLDER_REFUSAL_REASONS)
  assert.ok(reasonsSeen.has(reason), `uncovered ${reason}`);
assert.equal(
  `${treeListing(fixtures).join("\n")}\n`,
  frozenListing,
  "a refusal changed the fixture tree",
);
console.log(
  `E6_T02_REFUSALS scenarios=${frozenLines.length} reasons=${reasonsSeen.size} transcript-identical=true fixture-tree-unchanged=true`,
);

// 4. Property corpus in two fresh processes (foreign cwd + time zone vs repo cwd + UTC).
const property = readFileSync(join(evidence, "e6-t02-property.txt"), "utf8");
const corpusDigest = property
  .split("\n")
  .find((line) => line.startsWith("corpus-sha256="))
  .slice("corpus-sha256=".length);
function freshProcess(args, cwd, timezone) {
  const env = { ...process.env, LANG: "C", TZ: timezone };
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${args.join(" ")} wrote stderr`);
  return result.stdout;
}
const scratch = mkdtempSync(join(tmpdir(), "e6-t02-"));
try {
  const runner = join(root, "tools/verify/e6_t02_property.mjs");
  const first = freshProcess([runner], scratch, "Pacific/Kiritimati");
  const second = freshProcess([runner], join(root, "packages/tasks"), "UTC");
  assert.equal(first, second, "property corpus differs between fresh processes");
  assert.equal(first.trimEnd().split("\n").length, 1000);
  assert.equal(sha256(first), corpusDigest, "property corpus digest drifted from the frozen value");
  console.log(
    `E6_T02_PROPERTY cases=1000 processes=2 corpus-sha256=${corpusDigest} byte-identical=true`,
  );

  // 5. Boundary on disk: render the complete fixture into scratch, add work/, then flip evidence.
  const source = parseOk(readTaskFolderSnapshot(join(fixtures, "valid", "E9-T02-complete")));
  const target = join(scratch, "E9-T02-complete");
  const written = writeRenderedTaskFolder(target, renderTaskFolder(source));
  assert.ok(!written.some((path) => path.startsWith("work/")), "render emitted work/");
  const rendered = parseOk(readTaskFolderSnapshot(target));
  assert.equal(taskFolderDigest(rendered), digests["E9-T02"], "disk round trip digest");
  const manifest = canonicalJson(evidenceManifest(rendered));
  mkdirSync(join(target, "work", "nested"), { recursive: true });
  writeFileSync(join(target, "work", "probe.log"), "scratch output\n");
  writeFileSync(join(target, "work", "nested", "blob.bin"), new Uint8Array([0, 1, 2, 0]));
  const withWork = parseOk(readTaskFolderSnapshot(target));
  assert.deepEqual(
    withWork.work.map((entry) => entry.path),
    ["nested/blob.bin", "probe.log"],
  );
  assert.equal(
    taskFolderDigest(withWork),
    digests["E9-T02"],
    "work/ change moved the durable digest",
  );
  assert.equal(
    canonicalJson(evidenceManifest(withWork)),
    manifest,
    "work/ change moved the evidence manifest",
  );
  const notes = join(target, "evidence", "notes.txt");
  const bytes = new Uint8Array(readFileSync(notes));
  bytes[0] ^= 0x01;
  writeFileSync(notes, bytes);
  const flipped = parseOk(readTaskFolderSnapshot(target));
  assert.notEqual(
    taskFolderDigest(flipped),
    digests["E9-T02"],
    "evidence change left the durable digest unchanged",
  );
  assert.notEqual(
    canonicalJson(evidenceManifest(flipped)),
    manifest,
    "evidence change left the manifest unchanged",
  );
  assert.equal(canonicalJson(withWork.work), canonicalJson(flipped.work));
  console.log(
    `E6_T02_BOUNDARY work-change digest-identical=true manifest-identical=true; evidence-one-byte digest-moved=true manifest-moved=true`,
  );

  // 6. Refusal on disk writes nothing: a refused folder never reaches the writer.
  const refused = parseTaskFolder(
    readTaskFolderSnapshot(join(fixtures, "invalid", "duplicate-key", "E9-T10-duplicate-key")),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal.reason, "frontmatter/duplicate-key");
  assert.ok(!existsSync(join(scratch, "E9-T10-duplicate-key")));
  assert.equal(E6_T02_DUPLICATE_KEY_GUARD, true);
  console.log(
    `SABOTAGE guard=E6_T02_DUPLICATE_KEY_GUARD fixture=invalid/duplicate-key reason=${refused.refusal.reason} at readme.md:${refused.refusal.line}:${refused.refusal.column} rendered-output=none EXPECTED-FAIL-WHEN-GUARD-REMOVED OK`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 7. Nothing above regenerated a committed artifact, and the sabotage transcript is on file.
for (const name of protectedFiles)
  assert.equal(
    sha256(readFileSync(join(evidence, name))),
    before.get(name),
    `${name} was rewritten`,
  );
const sabotage = readFileSync(join(evidence, "e6-t02-sabotage.txt"), "utf8");
assert.ok(sabotage.includes("E6_T02_DUPLICATE_KEY_GUARD"), "sabotage transcript names the guard");
assert.ok(
  /Tests?\s+\d+ failed|transcript drifted|AssertionError/.test(sabotage),
  "sabotage transcript shows red",
);
console.log(`E6_T02_ARTIFACTS protected=${protectedFiles.length} unchanged=true`);
