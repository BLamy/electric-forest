import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import {
  createStreamFsServerOptions,
  fsEventsToWatchEvents,
  StreamFs,
} from "../../packages/streamfs/dist/src/index.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const evidenceRoot = join(
  repoRoot,
  ".eforest/tasks/epic-1-the-trunk/E1-T05-watch-chokidar/evidence",
);
mkdirSync(evidenceRoot, { recursive: true });
const workerPath = join(repoRoot, "tools/verify/streamfs_watch_worker.mjs");
const encoder = new TextEncoder();

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function recordsFromFile(path) {
  const text = readFileSync(path, "utf8");
  return text.length === 0
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
}

function lineCount(path) {
  try {
    return recordsFromFile(path).length;
  } catch {
    return 0;
  }
}

function removeIfExists(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function waitForFile(path, description) {
  await waitFor(() => {
    try {
      return readFileSync(path).length > 0;
    } catch {
      return false;
    }
  }, description);
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), createStreamFsServerOptions());
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("watch verifier did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function makeScript() {
  const base = "A".repeat(400);
  return [
    { op: "createFile", path: "root.txt", value: "root" },
    { op: "mkdir", path: "src" },
    { op: "mkdir", path: "src/lib" },
    { op: "createFile", path: "src/lib/a.txt", value: base },
    { op: "writeFile", path: "src/lib/a.txt", value: `B${base.slice(1)}` },
    { op: "writeFile", path: "src/lib/a.txt", value: `BC${base.slice(2)}` },
    { op: "writeFile", path: "src/lib/a.txt", value: `BCD${base.slice(3)}` },
    { op: "rename", from: "src/lib/a.txt", to: "src/lib/b.txt" },
    { op: "rename", from: "src", to: "archive" },
    { op: "deleteFile", path: "archive/lib/b.txt" },
    { op: "rmdir", path: "archive/lib" },
    { op: "rmdir", path: "archive" },
  ];
}

async function executeScript(repo, script) {
  for (const step of script) {
    if (step.op === "createFile") await repo.createFile(step.path, encoder.encode(step.value));
    else if (step.op === "writeFile") await repo.writeFile(step.path, encoder.encode(step.value));
    else if (step.op === "mkdir") await repo.mkdir(step.path);
    else if (step.op === "rename") await repo.rename(step.from, step.to);
    else if (step.op === "deleteFile") await repo.deleteFile(step.path);
    else if (step.op === "rmdir") await repo.rmdir(step.path);
    else throw new Error(`unknown writer operation ${step.op}`);
  }
}

function writeScript(path, script) {
  writeFileSync(path, `${script.map((step) => canonicalJson(step)).join("\n")}\n`);
}

async function launchWorker({
  baseUrl,
  streamId,
  mode,
  from,
  transcriptPath,
  reportPath,
  checkpointPath,
  killAt = 0,
  workDir,
}) {
  const readyPath = join(workDir, `ready-${process.pid}-${Math.random()}.json`);
  removeIfExists(readyPath);
  const child = spawn(
    process.execPath,
    [
      workerPath,
      baseUrl,
      streamId,
      mode,
      from,
      transcriptPath,
      reportPath,
      checkpointPath,
      String(killAt),
      readyPath,
    ],
    { cwd: repoRoot, stdio: "ignore" },
  );
  await waitForFile(readyPath, `${mode} watcher readiness`);
  removeIfExists(readyPath);
  return { child, exit: waitForChild(child) };
}

async function stopWorker(worker) {
  if (!worker.child.killed) worker.child.kill("SIGTERM");
  const result = await worker.exit;
  if (result.code !== 0 && result.signal !== "SIGTERM") {
    throw new Error(`watch worker exited ${JSON.stringify(result)}`);
  }
}

function transcriptText(records) {
  return records.length === 0
    ? ""
    : `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

async function runLiveMode({ baseUrl, mode, script, workDir }) {
  const repo = await new StreamFs({ baseUrl }).createRepo(`watch-${mode}`);
  const transcriptPath = join(workDir, `transcript-${mode}.jsonl`);
  const reportPath = join(workDir, `report-${mode}.jsonl`);
  const checkpointPath = join(workDir, `checkpoint-${mode}.json`);
  writeFileSync(transcriptPath, "");
  writeFileSync(reportPath, "");
  writeFileSync(checkpointPath, `${canonicalJson({ offset: "-1" })}\n`);
  const worker = await launchWorker({
    baseUrl,
    streamId: repo.metadataStreamId,
    mode,
    from: "-1",
    transcriptPath,
    reportPath,
    checkpointPath,
    workDir,
  });
  await executeScript(repo, script);
  const metadata = await repo.dump();
  const expected = fsEventsToWatchEvents(metadata).events;
  await waitFor(() => lineCount(transcriptPath) === expected.length, `${mode} transcript`);
  await stopWorker(worker);
  return { repo, metadata, expected, transcriptPath };
}

async function runKillResume({ baseUrl, script, expected, workDir }) {
  const repo = await new StreamFs({ baseUrl }).createRepo("watch-resume");
  const transcriptPath = join(workDir, "resume-transcript.jsonl");
  const prefixPath = join(evidenceRoot, "e1-t05-resume-prefix.jsonl");
  const suffixPath = join(evidenceRoot, "e1-t05-resume-suffix.jsonl");
  const reportPath = join(evidenceRoot, "e1-t05-emission-reports.jsonl");
  const checkpointPath = join(evidenceRoot, "e1-t05-checkpoint.json");
  for (const path of [transcriptPath, prefixPath, suffixPath, reportPath]) writeFileSync(path, "");
  writeFileSync(checkpointPath, `${canonicalJson({ offset: "-1" })}\n`);
  const directoryOffset = expected.find((entry, index) => {
    if (index === 0 || entry.offset !== expected[index - 1].offset)
      return expected.filter((candidate) => candidate.offset === entry.offset).length >= 6;
    return false;
  })?.offset;
  if (!directoryOffset) throw new Error("directory rename decomposition was not found");
  const directoryStart = expected.findIndex((entry) => entry.offset === directoryOffset);
  const directoryLength = expected.filter((entry) => entry.offset === directoryOffset).length;
  const killAt = directoryStart + 1;
  if (killAt <= directoryStart || killAt >= directoryStart + directoryLength) {
    throw new Error("chosen kill point is not inside the directory rename decomposition");
  }
  const worker = await launchWorker({
    baseUrl,
    streamId: repo.metadataStreamId,
    mode: "long-poll",
    from: "-1",
    transcriptPath,
    reportPath,
    checkpointPath,
    killAt,
    workDir,
  });
  const writerPromise = executeScript(repo, script);
  const killed = await worker.exit;
  await writerPromise;
  if (killed.signal !== "SIGKILL")
    throw new Error(`kill point did not SIGKILL: ${JSON.stringify(killed)}`);
  writeFileSync(prefixPath, readFileSync(transcriptPath));
  const checkpointValue = JSON.parse(readFileSync(checkpointPath, "utf8"));
  const preceding = expected.slice(0, directoryStart);
  if (checkpointValue.offset !== (preceding.at(-1)?.offset ?? "-1")) {
    throw new Error("persisted checkpoint crossed the directory rename boundary");
  }
  const resumed = await launchWorker({
    baseUrl,
    streamId: repo.metadataStreamId,
    mode: "sse",
    from: checkpointValue.offset,
    transcriptPath,
    reportPath: join(workDir, "resume-report.jsonl"),
    checkpointPath: join(workDir, "resume-checkpoint.json"),
    workDir,
  });
  await waitFor(() => lineCount(transcriptPath) === expected.length, "resumed transcript");
  await stopWorker(resumed);
  const full = readFileSync(transcriptPath, "utf8");
  const prefix = readFileSync(prefixPath, "utf8");
  const suffix = full.slice(prefix.length);
  writeFileSync(suffixPath, suffix);
  if (full !== transcriptText(expected))
    throw new Error("kill/resume transcript differs from golden");
  const reports = recordsFromFile(reportPath);
  if (reports.length < killAt)
    throw new Error("emission side channel missed the chosen kill point");
  writeFileSync(
    join(evidenceRoot, "e1-t05-killpoint.json"),
    `${JSON.stringify(
      {
        chosenN: killAt,
        directoryRenameEmissionRange: [directoryStart + 1, directoryStart + directoryLength],
        reportsReceivedBeforeKill: killAt,
        persistedCheckpoint: checkpointValue.offset,
        prefixRecords: recordsFromFile(prefixPath).length,
        suffixFirstRecord: recordsFromFile(suffixPath)[0],
      },
      null,
      2,
    )}\n`,
  );
  return { repo, directoryStart, directoryLength };
}

async function runSweep({ baseUrl, repo, expected, directoryStart, directoryLength, workDir }) {
  const directoryRenameInteriorKillPoints = [];
  for (let killAt = 1; killAt <= expected.length; killAt += 1) {
    const transcriptPath = join(workDir, `sweep-${killAt}.jsonl`);
    const reportPath = join(workDir, `sweep-${killAt}.report.jsonl`);
    const checkpointPath = join(workDir, `sweep-${killAt}.checkpoint.json`);
    writeFileSync(transcriptPath, "");
    writeFileSync(reportPath, "");
    writeFileSync(checkpointPath, `${canonicalJson({ offset: "-1" })}\n`);
    const worker = await launchWorker({
      baseUrl,
      streamId: repo.metadataStreamId,
      mode: killAt % 2 === 0 ? "sse" : "long-poll",
      from: "-1",
      transcriptPath,
      reportPath,
      checkpointPath,
      killAt,
      workDir,
    });
    const killed = await worker.exit;
    if (killed.signal !== "SIGKILL") throw new Error(`sweep ${killAt} did not SIGKILL`);
    const prefix = recordsFromFile(transcriptPath);
    const checkpointValue = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const resumed = await launchWorker({
      baseUrl,
      streamId: repo.metadataStreamId,
      mode: "long-poll",
      from: checkpointValue.offset,
      transcriptPath,
      reportPath: join(workDir, `sweep-${killAt}.resume.report.jsonl`),
      checkpointPath: join(workDir, `sweep-${killAt}.resume.checkpoint.json`),
      workDir,
    });
    await waitFor(() => lineCount(transcriptPath) === expected.length, `kill sweep ${killAt}`);
    await stopWorker(resumed);
    if (readFileSync(transcriptPath, "utf8") !== transcriptText(expected)) {
      throw new Error(`kill sweep ${killAt} diverged from golden`);
    }
    if (killAt > directoryStart && killAt < directoryStart + directoryLength) {
      directoryRenameInteriorKillPoints.push(killAt);
    }
  }
  writeFileSync(
    join(evidenceRoot, "e1-t05-sweep.json"),
    `${JSON.stringify(
      {
        totalKillPoints: expected.length,
        directoryRenameEmissionRange: [directoryStart + 1, directoryStart + directoryLength],
        insideDecompositionKillPoints: directoryRenameInteriorKillPoints,
      },
      null,
      2,
    )}\n`,
  );
  return directoryRenameInteriorKillPoints;
}

const dataDir = mkdtempSync(join(tmpdir(), "eforest-e1-t05-watch-"));
const workDir = mkdtempSync(join(tmpdir(), "eforest-e1-t05-watch-work-"));
const { server, baseUrl } = await startServer(dataDir);
try {
  const script = makeScript();
  writeScript(join(evidenceRoot, "e1-t05-writer-script.jsonl"), script);
  const longpoll = await runLiveMode({ baseUrl, mode: "long-poll", script, workDir });
  const goldenPath = join(evidenceRoot, "e1-t05-golden-transcript.jsonl");
  writeFileSync(goldenPath, transcriptText(longpoll.expected));
  writeFileSync(
    join(evidenceRoot, "e1-t05-transcript-longpoll.jsonl"),
    readFileSync(longpoll.transcriptPath),
  );
  const sse = await runLiveMode({ baseUrl, mode: "sse", script, workDir });
  writeFileSync(
    join(evidenceRoot, "e1-t05-transcript-sse.jsonl"),
    readFileSync(sse.transcriptPath),
  );
  if (
    readFileSync(join(evidenceRoot, "e1-t05-transcript-longpoll.jsonl")).compare(
      readFileSync(goldenPath),
    ) !== 0
  ) {
    throw new Error("long-poll transcript differs from golden");
  }
  if (
    readFileSync(join(evidenceRoot, "e1-t05-transcript-sse.jsonl")).compare(
      readFileSync(goldenPath),
    ) !== 0
  ) {
    throw new Error("SSE transcript differs from golden");
  }
  writeFileSync(
    join(evidenceRoot, "e1-t05-fs-log.jsonl"),
    `${longpoll.metadata.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const replayDigest = execFileSync(
    "pnpm",
    [
      "--silent",
      "ef",
      "replay",
      join(evidenceRoot, "e1-t05-fs-log.jsonl"),
      "--digest",
      "--reducer",
      "packages/streamfs/reducer.mjs",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const resume = await runKillResume({ baseUrl, script, expected: longpoll.expected, workDir });
  const inside = await runSweep({
    baseUrl,
    repo: resume.repo,
    expected: longpoll.expected,
    directoryStart: resume.directoryStart,
    directoryLength: resume.directoryLength,
    workDir,
  });
  if (inside.length === 0)
    throw new Error("kill sweep did not observe an interior decomposition point");
  const pureBeforeWatch = await resume.repo.dump();
  const pureTranscriptPath = join(workDir, "pure-reader.jsonl");
  const pureReportPath = join(workDir, "pure-reader.report.jsonl");
  const pureCheckpointPath = join(workDir, "pure-reader.checkpoint.json");
  writeFileSync(pureTranscriptPath, "");
  writeFileSync(pureReportPath, "");
  writeFileSync(pureCheckpointPath, `${canonicalJson({ offset: "-1" })}\n`);
  const pureWorker = await launchWorker({
    baseUrl,
    streamId: resume.repo.metadataStreamId,
    mode: "long-poll",
    from: "-1",
    transcriptPath: pureTranscriptPath,
    reportPath: pureReportPath,
    checkpointPath: pureCheckpointPath,
    workDir,
  });
  await waitFor(
    () => lineCount(pureTranscriptPath) === longpoll.expected.length,
    "pure reader transcript",
  );
  await stopWorker(pureWorker);
  const pureAfterWatch = await resume.repo.dump();
  if (canonicalJson(pureBeforeWatch) !== canonicalJson(pureAfterWatch)) {
    throw new Error("watch session changed the metadata stream");
  }
  const digestLines = [
    `replayDigest=${replayDigest}`,
    `goldenSha256=${digestFile(goldenPath)}`,
    `longpollSha256=${digestFile(join(evidenceRoot, "e1-t05-transcript-longpoll.jsonl"))}`,
    `sseSha256=${digestFile(join(evidenceRoot, "e1-t05-transcript-sse.jsonl"))}`,
    `resumePrefixSha256=${digestFile(join(evidenceRoot, "e1-t05-resume-prefix.jsonl"))}`,
    `resumeSuffixSha256=${digestFile(join(evidenceRoot, "e1-t05-resume-suffix.jsonl"))}`,
    `metadataTreeDigest=${stateDigest(await longpoll.repo.tree())}`,
    `insideDecompositionKillPoints=${inside.join(",")}`,
    "pureReader=unchanged-metadata-dump-static-watch",
  ];
  writeFileSync(join(evidenceRoot, "e1-t05-digests.txt"), `${digestLines.join("\n")}\n`);
  console.log(digestLines.join(" "));
} finally {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}
