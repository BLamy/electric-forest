import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { canonicalJson } = await import("../../packages/protocol/dist/src/index.js");
const { createDurableJsonStream } = await import("../../packages/client/dist/src/index.js");
const { createDurableStreamTestServer } = await import("../../packages/server/dist/src/index.js");
const { runClone, DownlinkEngine, verifyApplyJournal } =
  await import("../../packages/cli/dist/src/index.js");
const { StreamFsRepo, readStreamDump, worktreeDigest } =
  await import("../../packages/streamfs/dist/src/index.js");
const { worktreeDigestDirectory } =
  await import("../../packages/streamfs/dist/src/worktree-node.js");
const { load: loadWorkspace } = await import("../../packages/workspace/dist/src/index.js");

function streamUrl(baseUrl, streamId) {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function patchableText(suffix) {
  return new TextEncoder().encode(
    Array.from({ length: 24 }, (_, index) => `stable-${String(index).padStart(2, "0")}\n`).join(
      "",
    ) + suffix,
  );
}

async function waitForHead(workspace, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (loadWorkspace(workspace).headOffset === expected) return;
    await sleep(50);
  }
  throw new Error(`downlink did not reach checkpoint ${expected}`);
}

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t07-watch-down-"));
const workspace = join(scratch, "workspace");
const home = join(scratch, "home");
let engine;
let runPromise;

try {
  const baseUrl = await server.start();
  const repoName = "acme/reading-room";
  const metadataStreamId = `fs:${repoName}:main:meta`;
  await createDurableJsonStream({ url: streamUrl(baseUrl, metadataStreamId) });
  const repo = new StreamFsRepo(baseUrl, fetch, repoName, "main");
  await repo.createFile("doc.txt", new TextEncoder().encode("one\n"));
  await repo.createFile("keep.txt", patchableText("base\n"));

  mkdirSync(home, { recursive: true });
  const cloneStdout = [];
  const cloneStderr = [];
  const cloneStatus = await runClone(
    [repoName, "main", workspace],
    {
      stdout: (text) => cloneStdout.push(text),
      stderr: (text) => cloneStderr.push(text),
    },
    {
      environment: {
        EF_HOME: home,
        EF_SERVER: baseUrl,
        EF_STREAM_SERVER_URL: baseUrl,
      },
      fetcher: fetch,
    },
  );
  assert.equal(cloneStatus, 0, `${cloneStdout.join("")}\n${cloneStderr.join("")}`);
  assert.deepEqual(cloneStderr, []);

  const beforeHead = (await repo.rawDump()).at(-1)?.offset;
  assert.ok(beforeHead, "clone must have a metadata checkpoint");
  const beforeServerRecords = await repo.rawDump();
  engine = new DownlinkEngine({
    root: workspace,
    streamServerUrl: baseUrl,
    accessToken: "e4-t07-read-only-token",
    fetcher: fetch,
  });
  await engine.start();
  runPromise = engine.run();

  await repo.writeFile("keep.txt", patchableText("patch-a\n"));
  await repo.writeFile("keep.txt", patchableText("patch-b\n"));
  await repo.writeFile("keep.txt", patchableText("patch-c\n"));
  await repo.writeFile("doc.txt", new TextEncoder().encode("two\n"), { forceFull: true });
  await repo.mkdir("nested");
  await repo.rename("doc.txt", "nested/doc.txt");
  await repo.writeFile("nested/doc.txt", new TextEncoder().encode("three\n"), { forceFull: true });
  await repo.deleteFile("nested/doc.txt");
  await repo.createFile("nested/doc.txt", new TextEncoder().encode("recreated\n"));
  await repo.mkdir("nested/deeper");
  await repo.createFile("nested/deeper/leaf.txt", new TextEncoder().encode("leaf\n"));
  await repo.rename("nested/deeper/leaf.txt", "nested/deeper/renamed.txt");
  await repo.deleteFile("nested/deeper/renamed.txt");
  await repo.rmdir("nested/deeper");

  const finalRecords = await repo.rawDump();
  const finalHead = finalRecords.at(-1)?.offset;
  assert.ok(finalHead, "scripted edit sequence must advance the metadata stream");
  const sequence = finalRecords.filter(({ offset }) => offset > beforeHead);
  assert.ok(sequence.filter((record) => record.type === "fs.file.patch").length >= 3);
  assert.ok(sequence.some((record) => record.type === "fs.rename"));
  await waitForHead(workspace, finalHead);
  const journalFile = join(workspace, ".ef", "apply-journal");
  const journal = verifyApplyJournal(journalFile);
  assert.deepEqual(
    journal.map(({ offset }) => offset),
    finalRecords.filter(({ offset }) => offset > beforeHead).map(({ offset }) => offset),
  );
  const tree = await repo.treeAt(finalHead);
  assert.equal(worktreeDigestDirectory(workspace), worktreeDigest(tree));
  const cli = join(process.cwd(), "packages/cli/dist/src/bin.js");
  const metadataDump = join(scratch, "branch-meta.jsonl");
  writeFileSync(
    metadataDump,
    `${finalRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const contentStreamIds = new Set(
    finalRecords.flatMap((record) => {
      const payload = record.payload ?? {};
      return typeof payload.contentStreamId === "string" && record.type !== "fs.file.content"
        ? [payload.contentStreamId]
        : [];
    }),
  );
  const contentRecords = [];
  for (const streamId of contentStreamIds) {
    contentRecords.push(...(await readStreamDump(repo, streamId)));
  }
  const contentDump = join(scratch, "branch-content.jsonl");
  writeFileSync(
    contentDump,
    `${contentRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const materialized = join(scratch, "materialized");
  const cliTreeDigest = execFileSync(process.execPath, [cli, "tree-digest", workspace], {
    encoding: "utf8",
  }).trim();
  const cliMaterializeDigest = execFileSync(
    process.execPath,
    [
      cli,
      "materialize",
      metadataDump,
      "--content",
      contentDump,
      "--out",
      materialized,
      "--at",
      finalHead,
      "--worktree-digest",
    ],
    { encoding: "utf8" },
  ).trim();
  const cliJournalVerify = execFileSync(process.execPath, [cli, "journal", "verify", workspace], {
    encoding: "utf8",
  }).trim();
  assert.equal(cliJournalVerify, `verified ${journal.length} apply journal entries`);
  assert.equal(cliTreeDigest, worktreeDigestDirectory(workspace));
  assert.equal(cliMaterializeDigest, cliTreeDigest);
  const afterServerRecords = await repo.rawDump();
  assert.deepEqual(afterServerRecords, finalRecords);
  const evidenceDir = process.env.EFOREST_EVIDENCE_DIR;
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "e4-t07-live-journal.jsonl"),
      `${journal.map((record) => canonicalJson(record)).join("\n")}\n`,
    );
    writeFileSync(
      join(evidenceDir, "e4-t07-live-workspace.json"),
      `${canonicalJson(loadWorkspace(workspace))}\n`,
    );
  }
  process.stdout.write(
    `E4-T07 live convergence OK checkpoint=${finalHead} applied=${journal.length} ` +
      `worktree=${cliTreeDigest} materialize=${cliMaterializeDigest} ` +
      `${cliJournalVerify} ` +
      `server-head-before=${beforeServerRecords.at(-1)?.offset} server-head-after=${afterServerRecords.at(-1)?.offset}\n`,
  );
} finally {
  if (engine !== undefined) {
    await engine.close();
    if (runPromise !== undefined) {
      await runPromise.catch((error) => {
        if (!(error instanceof Error && /abort/i.test(error.message))) throw error;
      });
    }
  }
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
