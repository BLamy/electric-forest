import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createDurableJsonStream } = await import("../../packages/client/dist/src/index.js");
const { createDurableStreamTestServer } = await import("../../packages/server/dist/src/index.js");
const { runClone } = await import("../../packages/cli/dist/src/index.js");
const { StreamFsRepo, worktreeDigest } = await import("../../packages/streamfs/dist/src/index.js");
const { worktreeDigestDirectory } =
  await import("../../packages/streamfs/dist/src/worktree-node.js");
const { load: loadWorkspace } = await import("../../packages/workspace/dist/src/index.js");
const { readApplyIntent, readApplyJournal, verifyApplyJournal } =
  await import("../../packages/cli/dist/src/sync/apply-journal.js");

// A deterministic pseudo-random permutation keeps the kill sweep reproducible while
// aiming at different events in the same edit sequence. The phase suffix is an
// event ordinal, not a wall-clock guess, so every run proves a distinct stream point.
const killPlan = [
  ["before-intent", 1],
  ["after-intent", 8],
  ["after-rename", 4],
  ["after-journal-commit", 12],
  ["before-checkpoint", 6],
  ["after-intent", 14],
  ["after-rename", 3],
  ["after-journal-commit", 10],
  ["before-checkpoint", 5],
  ["before-intent", 9],
];
const cli = join(process.cwd(), "packages/cli/dist/src/bin.js");

function streamUrl(baseUrl, streamId) {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCleanHead(workspace, expected, intentPath) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      loadWorkspace(workspace).headOffset === expected &&
      readApplyIntent(intentPath) === undefined
    )
      return;
    await sleep(25);
  }
  throw new Error(`watcher did not clear the apply intent at checkpoint ${expected}`);
}

function launchWatcher({ baseUrl, home, workspace, failpoint }) {
  const environment = { ...process.env };
  delete environment.EFOREST_DOWNLINK_FAILPOINT;
  Object.assign(environment, {
    EF_HOME: home,
    EF_SERVER: baseUrl,
    EF_STREAM_SERVER_URL: baseUrl,
  });
  if (failpoint !== undefined) environment.EFOREST_DOWNLINK_FAILPOINT = failpoint;
  const child = spawn(
    process.execPath,
    [cli, "watch", "--down", "--dir", workspace, "--porcelain"],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, output: () => ({ stdout, stderr }) };
}

async function waitForExit(watcher, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      watcher.child.kill("SIGKILL");
      reject(new Error("watcher did not exit after SIGKILL"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([watcher.exit, timeout]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function stopWatcher(watcher) {
  if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) return;
  watcher.child.kill("SIGTERM");
  try {
    await waitForExit(watcher);
  } catch {
    watcher.child.kill("SIGKILL");
    await waitForExit(watcher);
  }
}

function longText(suffix) {
  return new TextEncoder().encode(
    Array.from({ length: 24 }, (_, index) => `stable-${String(index).padStart(2, "0")}\n`).join(
      "",
    ) + suffix,
  );
}

async function cloneRepo(baseUrl, workspace, home, repoName) {
  const metadataStreamId = `fs:${repoName}:main:meta`;
  await createDurableJsonStream({ url: streamUrl(baseUrl, metadataStreamId) });
  const repo = new StreamFsRepo(baseUrl, fetch, repoName, "main");
  await repo.createFile("doc.txt", longText("base\n"));
  await repo.createFile("keep.txt", new TextEncoder().encode("keep\n"));
  mkdirSync(home, { recursive: true });
  const stdout = [];
  const stderr = [];
  const status = await runClone(
    [repoName, "main", workspace],
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
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
  assert.equal(status, 0, `${stdout.join("")}\n${stderr.join("")}`);
  writeFileSync(
    join(home, "credentials.json"),
    `${JSON.stringify({
      accessToken: "e4-t07-kill-token",
      tokenType: "Bearer",
      issuer: "http://127.0.0.1/test",
      clientId: "e4-t07",
      scopes: ["streams:read"],
    })}\n`,
    { mode: 0o600 },
  );
  return repo;
}

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t07-kill-resume-"));

try {
  const baseUrl = await server.start();
  const results = [];
  for (let index = 0; index < killPlan.length; index += 1) {
    const [phase, targetOrdinal] = killPlan[index];
    const repoName = `acme/kill-${index}`;
    const workspace = join(scratch, `workspace-${index}`);
    const home = join(scratch, `home-${index}`);
    const repo = await cloneRepo(baseUrl, workspace, home, repoName);
    const beforeRecords = await repo.rawDump();
    const beforeHead = beforeRecords.at(-1)?.offset;
    assert.ok(beforeHead, "clone must establish a metadata checkpoint");

    const killed = launchWatcher({
      baseUrl,
      home,
      workspace,
      failpoint: `${phase}@${targetOrdinal}`,
    });
    await sleep(250);
    await repo.writeFile("doc.txt", longText(`patch-a-${index}\n`));
    await repo.writeFile("doc.txt", longText(`patch-b-${index}\n`));
    await repo.writeFile("doc.txt", longText(`patch-c-${index}\n`));
    await repo.mkdir("nested");
    await repo.rename("doc.txt", "nested/doc.txt");
    await repo.writeFile("nested/doc.txt", longText(`renamed-${index}\n`));
    await repo.deleteFile("nested/doc.txt");
    await repo.createFile("nested/doc.txt", new TextEncoder().encode(`recreated-${index}\n`));
    await repo.createFile("nested/keep.txt", new TextEncoder().encode(`keep-${index}\n`));
    await repo.rename("nested/keep.txt", "nested/renamed.txt");
    await repo.deleteFile("nested/renamed.txt");
    await repo.deleteFile("nested/doc.txt");
    await repo.rmdir("nested");

    const finalRecords = await repo.rawDump();
    const finalHead = finalRecords.at(-1)?.offset;
    assert.ok(finalHead, "kill sequence must advance the metadata stream");
    const sequence = finalRecords.slice(beforeRecords.length);
    assert.ok(
      sequence.length >= targetOrdinal,
      `kill sequence ${index} has ${sequence.length} events, target ${targetOrdinal}`,
    );
    assert.ok(
      sequence.filter((record) => record.type === "fs.file.patch").length >= 3,
      `kill sequence ${index} must include three patch events`,
    );
    assert.ok(sequence.some((record) => record.type === "fs.rename"));

    const killedResult = await waitForExit(killed, 8000);
    assert.equal(
      killedResult.signal,
      "SIGKILL",
      `phase ${phase} did not produce SIGKILL: ${JSON.stringify(killed.output())}`,
    );
    const journalBefore = readApplyJournal(join(workspace, ".ef", "apply-journal"));
    const intentBefore = readApplyIntent(join(workspace, ".ef", "apply-intent"));
    const committedBeforeKill = phase === "after-journal-commit" || phase === "before-checkpoint";
    const expectedJournalBefore = targetOrdinal - 1 + (committedBeforeKill ? 1 : 0);
    const expectedCheckpointBeforeKill = sequence[targetOrdinal - 2]?.offset ?? beforeHead;
    assert.equal(journalBefore.length, expectedJournalBefore);
    if (phase === "before-intent") {
      assert.equal(intentBefore, undefined);
    } else {
      assert.ok(intentBefore, `phase ${phase} must leave a committed intent`);
      if (committedBeforeKill) {
        assert.equal(loadWorkspace(workspace).headOffset, expectedCheckpointBeforeKill);
      }
    }

    const recovered = launchWatcher({ baseUrl, home, workspace });
    await waitForCleanHead(workspace, finalHead, join(workspace, ".ef", "apply-intent"));
    await stopWatcher(recovered);
    assert.equal(readApplyIntent(join(workspace, ".ef", "apply-intent")), undefined);
    const journal = verifyApplyJournal(join(workspace, ".ef", "apply-journal"));
    assert.deepEqual(
      journal.map(({ offset }) => offset),
      sequence.map(({ offset }) => offset),
    );
    const tree = await repo.treeAt(finalHead);
    const digest = worktreeDigestDirectory(workspace);
    assert.equal(digest, worktreeDigest(tree));
    assert.deepEqual(await repo.rawDump(), finalRecords);
    results.push(
      `kill=${index + 1} phase=${phase} signal=${killedResult.signal} ` +
        `targetOrdinal=${targetOrdinal} preJournal=${journalBefore.length} ` +
        `preIntent=${intentBefore === undefined ? "absent" : "present"} ` +
        `recovered=${finalHead} journal=${journal.length} digest=${digest}`,
    );
  }
  process.stdout.write(`E4-T07 kill/resume OK runs=${results.length}\n${results.join("\n")}\n`);
} finally {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
