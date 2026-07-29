#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests");
const EVIDENCE = path.join(TASK, "evidence");
const SEED = path.join(ROOT, "tools/verify/seed-canopy.ts");
const COMPARE = path.join(ROOT, "tools/verify/canopy_compare.mjs");
const SENSITIVITY = path.join(ROOT, "tools/verify/seed_sensitivity.sh");
const SENSITIVITY_RECEIPT = "E3_T01_SENSITIVITY_STAGE_OK cases=9";
const NAMED_SUBJECTS = new Set([
  "auth0|canopy-maple-admin",
  "auth0|canopy-maple-member",
  "auth0|canopy-willow-admin",
  "auth0|canopy-willow-member",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...options.env },
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly passed`);
  } else {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

function seed(out, env = {}, extra = []) {
  return run(process.execPath, ["--experimental-strip-types", SEED, "--out", out, ...extra], {
    env,
    capture: true,
  });
}

function files(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return result.sort();
}

function corpusDigest(root) {
  const hash = createHash("sha256");
  for (const relative of files(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertSameCorpus(left, right) {
  assert.deepEqual(files(left), files(right), "corpus file inventory differs");
  for (const relative of files(left)) {
    assert.deepEqual(
      fs.readFileSync(path.join(left, relative)),
      fs.readFileSync(path.join(right, relative)),
      `corpus bytes differ: ${relative}`,
    );
  }
}

function loadCorpus(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "corpus-manifest.json"), "utf8"));
  const records = (key) =>
    fs
      .readFileSync(path.join(root, manifest.streams[key].dump), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { manifest, records };
}

async function semanticChecks(root) {
  const { manifest, records } = loadCorpus(root);
  const entries = Object.entries(manifest.streams);
  assert.ok(entries.length >= 18, `expected a rich stream inventory, got ${entries.length}`);
  assert.deepEqual(
    fs
      .readdirSync(path.join(root, "dumps"))
      .filter((name) => name.endsWith(".jsonl"))
      .sort(),
    Object.keys(manifest.streams)
      .map((key) => `${key}.jsonl`)
      .sort(),
  );
  const mainKey = "fs_maple_reading-room_main_meta";
  const branchKey = "fs_maple_reading-room_feature-typography_meta";
  const main = records(mainKey);
  const branch = records(branchKey);
  const fork = branch.find((record) => record.offset === manifest.anchors.fork_offset);
  assert.equal(fork?.type, "fs.branch.fork");
  assert.equal(fork.payload.parentStreamId, "fs:maple/reading-room:main:meta");
  assert.equal(fork.payload.forkOffset, manifest.anchors.fork_parent_offset);
  assert.ok(
    manifest.anchors.fork_offset > manifest.anchors.fork_parent_offset,
    "fork event must follow its inherited parent offset",
  );
  const mainByOffset = new Map(main.map((record) => [record.offset, record]));
  const branchByOffset = new Map(branch.map((record) => [record.offset, record]));
  const commonOffsets = [...mainByOffset.keys()]
    .filter((offset) => branchByOffset.has(offset))
    .sort();
  for (const offset of commonOffsets.filter(
    (candidate) => candidate <= manifest.anchors.fork_parent_offset,
  )) {
    assert.deepEqual(
      branchByOffset.get(offset),
      mainByOffset.get(offset),
      `branches differ inside inherited prefix at ${offset}`,
    );
  }
  const firstDivergence = commonOffsets.find(
    (offset) =>
      JSON.stringify(branchByOffset.get(offset)) !== JSON.stringify(mainByOffset.get(offset)),
  );
  assert.equal(
    firstDivergence,
    manifest.anchors.fork_offset,
    "first divergence must be the native fork event after fork_parent_offset",
  );
  process.stdout.write(
    `E3_T01_FORK_DIVERGENCE_OK parent=${manifest.anchors.fork_parent_offset} first=${firstDivergence}\n`,
  );
  assert.notEqual(
    manifest.streams[mainKey].state_digest,
    manifest.streams[branchKey].state_digest,
    "branch heads do not diverge",
  );
  const patches = manifest.anchors.patch_offsets.map((offset) =>
    main.find((record) => record.offset === offset),
  );
  assert.ok(patches.length >= 3);
  assert.ok(
    patches.every(
      (record) => record?.type === "fs.file.patch" && record.payload.path === "docs/chapter-one.md",
    ),
  );
  assert.equal(new Set(patches.map((record) => record.payload.resultDigest)).size, patches.length);
  const streamfs = await import(
    `${new URL("../../packages/streamfs/dist/src/index.js", import.meta.url).href}?canopy-verify`
  );
  let tree = streamfs.fsInitialState;
  for (const record of main) tree = streamfs.fsReducer(tree, record);
  assert.ok(Object.keys(tree.files).length >= 8);
  assert.equal(tree.files[manifest.anchors.renamed_from.file], undefined);
  assert.ok(tree.files[manifest.anchors.renamed_to.file]);
  assert.equal(tree.dirs[manifest.anchors.renamed_from.directory], undefined);
  assert.ok(tree.dirs[manifest.anchors.renamed_to.directory]);
  assert.equal(tree.files[manifest.anchors.tombstoned_path], undefined);
  assert.ok(tree.tombstones[manifest.anchors.tombstoned_path]);

  for (const [key, entry] of entries) {
    const streamRecords = records(key);
    if (entry.stream.startsWith("ns:")) {
      for (const record of streamRecords) {
        assert.ok(
          NAMED_SUBJECTS.has(record.payload.actor.sub),
          `unknown namespace actor ${record.payload.actor.sub}`,
        );
      }
    }
    if (entry.stream === "__registry__") {
      for (const record of streamRecords) {
        if (typeof record.payload.owner === "string") {
          assert.ok(NAMED_SUBJECTS.has(record.payload.owner));
        }
      }
    }
  }
  const bytes = files(root)
    .map((relative) => fs.readFileSync(path.join(root, relative), "utf8"))
    .join("\n");
  assert.doesNotMatch(bytes, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(bytes, /(?:127\.0\.0\.1|localhost):\d{2,5}/);
  assert.doesNotMatch(bytes, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.doesNotMatch(
    fs.readFileSync(SEED, "utf8"),
    /from\s+["'][^"']*(?:store|server\/src|upstream)["']|Math\.random|crypto\.randomUUID|toLocale/,
  );
  const transcript = fs.readFileSync(path.join(root, "e3-t01-privacy-probe.txt"), "utf8");
  assert.match(
    transcript,
    /gate=BearerVerifier\+GrantAwareVerifier\+decideTenantAccess\+decideStreamAuthorization/,
  );
  const privacyRows = transcript
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const mapleEntries = entries.filter(([, entry]) => entry.stream.startsWith("fs:maple/"));
  assert.equal(privacyRows.length, mapleEntries.length * 3);
  for (const [, entry] of mapleEntries) {
    for (const principal of ["willow-member", "anonymous", "maple-admin"]) {
      const matches = privacyRows.filter(
        (row) => row.stream === entry.stream && row.principal === principal,
      );
      assert.equal(matches.length, 1, `missing unique privacy observation: ${entry.stream}`);
      const row = matches[0];
      const privateRepo = entry.stream.startsWith("fs:maple/secret-garden:");
      const expected =
        principal === "willow-member" || (principal === "anonymous" && privateRepo) ? 404 : 200;
      assert.equal(row.status, expected);
      assert.equal(row.neutral, true);
      assert.equal(row.beforeSha256, row.afterSha256);
      if (expected === 200) {
        assert.deepEqual(row.body, {
          ok: true,
          streamId: entry.stream,
          count: records(
            Object.keys(manifest.streams).find(
              (key) => manifest.streams[key].stream === entry.stream,
            ),
          ).length,
          headOffset: entry.head_offset,
          identityOffset: row.body.identityOffset,
          basis: row.body.basis,
        });
      } else {
        assert.equal(row.body.error.code, "authz_refused");
        assert.equal(row.body.error.reason, "authz/not-found");
      }
    }
  }
  process.stdout.write(
    `E3_T01_PRIVACY_MATRIX_OK streams=${mapleEntries.length} observations=${privacyRows.length}\n`,
  );
  assert.match(transcript, /E3_T01_PRIVACY_OK/);
}

function missingGoldenChecks(root) {
  for (const relative of ["corpus-manifest.json", "dumps/fs_maple_reading-room_main_meta.jsonl"]) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eforest-e3-missing-"));
    fs.cpSync(root, scratch, { recursive: true });
    fs.rmSync(path.join(scratch, relative));
    const result = run(process.execPath, [COMPARE, "--root", scratch], {
      expectFailure: true,
      capture: true,
    });
    assert.match(`${result.stdout}${result.stderr}`, /CANOPY_MISMATCH/);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function sensitivityChecks(root) {
  const { manifest } = loadCorpus(root);
  const byteFor = (key, needle) => {
    const bytes = fs.readFileSync(path.join(root, manifest.streams[key].dump));
    const byte = bytes.indexOf(Buffer.from(needle));
    assert.ok(byte >= 0, `sensitivity needle missing: ${key} ${needle}`);
    return byte;
  };
  const mainKey = "fs_maple_reading-room_main_meta";
  const contentKey = Object.keys(manifest.streams).find((key) =>
    manifest.streams[key].stream.includes(":file:"),
  );
  assert.ok(contentKey);
  const featureKey = "fs_maple_reading-room_feature-typography_meta";
  const cases = [
    [mainKey, byteFor(mainKey, "eterministic"), "flip"],
    [mainKey, byteFor(mainKey, "0000000000000000_"), "flip"],
    [contentKey, "", "flip"],
    [mainKey, "", "truncate"],
    ["__identity__", byteFor("__identity__", "canopy-maple-admin"), "flip"],
    ["ns_org_maple", byteFor("ns_org_maple", "reading-room"), "flip"],
    ["__registry__", byteFor("__registry__", "0000000000000000_"), "flip"],
    [featureKey, byteFor(featureKey, "fs.branch.fork"), "flip"],
    ["ns_root", "", "truncate"],
  ];
  for (const [key, byte, mode] of cases) {
    const args = [SENSITIVITY, "--root", root, "--stream", key, "--mode", mode];
    if (byte !== "") args.push("--byte", String(byte));
    run("bash", args);
  }
  return SENSITIVITY_RECEIPT;
}

function failureCoverage() {
  for (const boundary of ["namespace", "streamfs", "fork"]) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `eforest-e3-${boundary}-`));
    const out = path.join(parent, "corpus");
    run(
      process.execPath,
      ["--experimental-strip-types", SEED, "--out", out, "--fail-at", boundary],
      { expectFailure: true, capture: true },
    );
    assert.equal(fs.existsSync(out), false, `${boundary} failure published a corpus`);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function regenerate(source) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const existing = fs.existsSync(path.join(EVIDENCE, "corpus-manifest.json"));
  if (existing) {
    const diff = spawnSync("diff", ["-ru", EVIDENCE, source], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (diff.status === 1) process.stdout.write(diff.stdout);
    else assert.equal(diff.status, 0, diff.stderr);
  } else {
    process.stdout.write("regen-E3-seed: new corpus (no previous golden)\n");
  }
  for (const name of ["dumps", "corpus-manifest.json", "e3-t01-privacy-probe.txt"]) {
    fs.rmSync(path.join(EVIDENCE, name), { recursive: true, force: true });
    fs.cpSync(path.join(source, name), path.join(EVIDENCE, name), { recursive: true });
  }
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "eforest-e3-canopy-"));
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  try {
    const firstRun = seed(first, { TZ: "UTC", LANG: "C" });
    const secondRun = seed(second, { TZ: "Pacific/Kiritimati", LANG: "en_US.UTF-8" });
    assert.match(firstRun.stdout, /E3_T01_SEED_OK/);
    assert.match(secondRun.stdout, /E3_T01_SEED_OK/);
    assertSameCorpus(first, second);
    await semanticChecks(first);
    run(process.execPath, [COMPARE, "--root", first]);
    if (process.argv.includes("--regen")) {
      regenerate(first);
      process.stdout.write(`E3_T01_REGEN_OK digest=${corpusDigest(first)}\n`);
      return;
    }
    assert.ok(
      fs.existsSync(path.join(EVIDENCE, "corpus-manifest.json")),
      "committed manifest missing",
    );
    const evidenceBefore = corpusDigest(EVIDENCE);
    assertSameCorpus(first, EVIDENCE);
    run(process.execPath, [COMPARE, "--root", EVIDENCE]);
    await semanticChecks(EVIDENCE);
    missingGoldenChecks(EVIDENCE);
    const sensitivityReceipt = sensitivityChecks(EVIDENCE);
    assert.equal(sensitivityReceipt, SENSITIVITY_RECEIPT);
    process.stdout.write(`${sensitivityReceipt}\n`);
    failureCoverage();
    assert.equal(corpusDigest(EVIDENCE), evidenceBefore, "verification mutated evidence");
    process.stdout.write(
      `E3_T01_VERIFY_OK streams=${Object.keys(loadCorpus(EVIDENCE).manifest.streams).length} evidence-digest=${evidenceBefore}\n`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
