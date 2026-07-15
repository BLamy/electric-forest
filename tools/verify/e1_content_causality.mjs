import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDurableJson } from "../../packages/client/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  StreamFs,
  applyThreeWayMerge,
  planThreeWayMerge,
  treeDigest,
} from "../../packages/streamfs/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const efBin = join(root, "packages/cli/dist/src/bin.js");
const evidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/content-causality.json",
);
const updateEvidence = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node tools/verify/e1_content_causality.mjs [--update-evidence]",
);

const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t11-content-causality-"));
const server = spawn(
  process.execPath,
  [serverBin, "--port=0", "--store=file", `--data-dir=${join(scratch, "state")}`],
  { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function endpoint() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const match = /LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    if (match !== null) return match[1];
    if (server.exitCode !== null) throw new Error(`published server exited: ${stderr}`);
    await sleep(25);
  }
  throw new Error("published server did not start");
}

function writeJsonLines(path, records) {
  writeFileSync(
    path,
    `${records.map((record) => canonicalJson({ ...record, ts: 0 })).join("\n")}\n`,
    "utf8",
  );
}

function materialize(arguments_) {
  return spawnSync(process.execPath, [efBin, "materialize", ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
}

function collectContentStreamIds(records) {
  const ids = new Set();
  const inspect = (event) => {
    if (event?.type === "fs.file.create" && typeof event.payload?.contentStreamId === "string") {
      ids.add(event.payload.contentStreamId);
    }
    if (event?.type === "fs/merge-change") inspect(event.payload?.change);
    if (event?.type === "fs.branch.merge" && event.payload?.v === 2) {
      for (const change of event.payload.changes ?? []) inspect(change);
    }
  };
  for (const record of records) inspect(record);
  return [...ids].sort();
}

try {
  const baseUrl = await endpoint();
  const repo = await new StreamFs({ baseUrl }).createRepo("e1-t11-content-causality");
  const original = `${Array.from({ length: 128 }, (_, index) => `base-${index}`).join("\n")}\n`;
  const patched = original.replace("base-64", "edit-64");
  const final = "final full generation\n";
  await repo.createFile("causal.txt", new TextEncoder().encode(original));
  await repo.writeFile("causal.txt", new TextEncoder().encode(patched));
  await repo.writeFile("causal.txt", new TextEncoder().encode(final), { forceFull: true });

  const metadata = await repo.resolvedDump();
  assert.deepEqual(
    metadata.map(({ type }) => type),
    ["fs.file.create", "fs.file.write", "fs.file.patch", "fs.file.write"],
  );
  const patchOffset = metadata.find(({ type }) => type === "fs.file.patch")?.offset;
  assert.ok(patchOffset !== undefined);
  const contentStreamId = (await repo.tree()).files["causal.txt"].contentStreamId;
  const content = await readDurableJson({
    url: `${baseUrl}/streams/${encodeURIComponent(contentStreamId)}`,
  });
  assert.equal(content.length, 2);

  const metadataPath = join(scratch, "metadata.jsonl");
  const contentPath = join(scratch, "content.jsonl");
  writeJsonLines(metadataPath, metadata);
  writeJsonLines(contentPath, content);

  const fullOut = join(scratch, "full");
  const full = materialize([metadataPath, "--content", contentPath, "--out", fullOut]);
  assert.equal(full.status, 0, `${full.stdout}${full.stderr}`);
  const finalDigest = await repo.digest();
  assert.equal(full.stdout.trim(), finalDigest);
  assert.equal(readFileSync(join(fullOut, "causal.txt"), "utf8"), final);

  const prefixOut = join(scratch, "prefix");
  const prefix = materialize([
    metadataPath,
    "--content",
    contentPath,
    "--at",
    patchOffset,
    "--out",
    prefixOut,
  ]);
  assert.equal(prefix.status, 0, `${prefix.stdout}${prefix.stderr}`);
  const prefixDigest = treeDigest(await repo.treeAt(patchOffset));
  assert.equal(prefix.stdout.trim(), prefixDigest);
  assert.equal(readFileSync(join(prefixOut, "causal.txt"), "utf8"), patched);

  const mergeTarget = await new StreamFs({ baseUrl }).createRepo("e1-t11-merge-causality");
  const mergeBase = `${Array.from({ length: 192 }, (_, index) => `line-${index}`).join("\n")}\n`;
  const mergeFull = mergeBase.replace("line-48", "source-full-48");
  const mergeFinal = mergeFull.replace("line-144", "source-patch-144");
  await mergeTarget.createFile("notes.txt", new TextEncoder().encode(mergeBase));
  await mergeTarget.createBranch("feature");
  const mergeSource = await mergeTarget.openBranch("feature");
  await mergeSource.writeFile("notes.txt", new TextEncoder().encode(mergeFull), {
    forceFull: true,
  });
  await mergeSource.writeFile("notes.txt", new TextEncoder().encode(mergeFinal));
  assert.equal((await mergeSource.rawDump()).at(-1)?.type, "fs.file.patch");
  await mergeTarget.createFile("target-only.txt", new TextEncoder().encode("target side\n"));
  const mergePlan = await planThreeWayMerge(mergeTarget, mergeSource);
  assert.equal(mergePlan.contentDependencies.length, 1);
  const mergeReceipt = await applyThreeWayMerge(mergeTarget, mergeSource, mergePlan);
  assert.equal(new TextDecoder().decode(await mergeTarget.readFile("notes.txt")), mergeFinal);
  assert.equal(mergeReceipt.resultTreeDigest, await mergeTarget.digest());

  const mergeMetadata = await mergeTarget.resolvedDump();
  const mergeMetadataPath = join(scratch, "merge-metadata.jsonl");
  writeJsonLines(mergeMetadataPath, mergeMetadata);
  const mergeContentPaths = [];
  let mergeContentEventCount = 0;
  for (const [index, streamId] of collectContentStreamIds(mergeMetadata).entries()) {
    const records = await readDurableJson({
      url: `${baseUrl}/streams/${encodeURIComponent(streamId)}`,
    });
    mergeContentEventCount += records.length;
    const path = join(scratch, `merge-content-${index}.jsonl`);
    writeJsonLines(path, records);
    mergeContentPaths.push(path);
  }
  const mergeOut = join(scratch, "merge");
  const mergeMaterialized = materialize([
    mergeMetadataPath,
    ...mergeContentPaths.flatMap((path) => ["--content", path]),
    "--out",
    mergeOut,
  ]);
  assert.equal(
    mergeMaterialized.status,
    0,
    `${mergeMaterialized.stdout}${mergeMaterialized.stderr}`,
  );
  assert.equal(mergeMaterialized.stdout.trim(), mergeReceipt.resultTreeDigest);
  assert.equal(readFileSync(join(mergeOut, "notes.txt"), "utf8"), mergeFinal);

  const summary = `${canonicalJson({
    contentEventCount: content.length,
    contentOffsets: content.map(({ offset }) => offset),
    contentStreamId,
    finalDigest,
    fullMaterializationMatchesLive: true,
    metadataOffsets: metadata.map(({ offset }) => offset),
    metadataTypes: metadata.map(({ type }) => type),
    mergeContentDependencyCount: mergePlan.contentDependencies.length,
    mergeContentEventCount,
    mergeDigest: mergeReceipt.resultTreeDigest,
    mergeLiveReadMatches: true,
    mergeMaterializationMatchesLive: true,
    mergeMetadataEventCount: mergeMetadata.length,
    patchOffset,
    prefixDigest,
    prefixMaterializationMatchesLive: true,
  })}\n`;
  if (updateEvidence) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, summary, "utf8");
  } else {
    assert.ok(existsSync(evidence), "missing content causality evidence");
    assert.equal(summary, readFileSync(evidence, "utf8"), "content causality evidence drifted");
  }
  process.stdout.write(summary);
} finally {
  if (server.exitCode === null) {
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    server.kill("SIGTERM");
    await exited;
  }
  assert.equal(stderr, "");
  rmSync(scratch, { recursive: true, force: true });
}
