import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const workerPath = join(repoRoot, "tools/verify/streamfs_watch_worker.mjs");
const encoder = new TextEncoder();
const recordRun = process.argv.includes("--record");

function artifactPath(name) {
  return recordRun ? join(evidenceRoot, name) : join(workDir, `generated-${name}`);
}

function writeArtifact(name, content) {
  const path = artifactPath(name);
  writeFileSync(path, content);
  return path;
}

function assertArtifact(name, content) {
  writeFileSync(artifactPath(name), content);
  if (recordRun) {
    return;
  }
  const expected = readFileSync(join(evidenceRoot, name));
  const actual = Buffer.from(content);
  if (expected.compare(actual) !== 0) throw new Error(`committed evidence differs: ${name}`);
}

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(text) {
  return createHash("sha256").update(text).digest("hex");
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

function readScript() {
  return recordsFromFile(join(evidenceRoot, "e1-t05-writer-script.jsonl"));
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

async function launchWorker({
  baseUrl,
  streamId,
  mode,
  from,
  transcriptPath,
  reportPath,
  checkpointPath,
  killAt = 0,
  crashAfterTranscript = 0,
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
      String(crashAfterTranscript),
    ],
    { cwd: repoRoot, stdio: "ignore" },
  );
  const exit = waitForChild(child);
  await waitForFile(readyPath, `${mode} watcher readiness`);
  removeIfExists(readyPath);
  return { child, exit };
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

function normalizedFsLog(records) {
  return records.map((record) => {
    const payload = { ...record.payload };
    delete payload.contentStreamId;
    return { offset: record.offset, payload, type: record.type };
  });
}

function normalizedFsLogText(records) {
  return `${normalizedFsLog(records)
    .map((record) => canonicalJson(record))
    .join("\n")}\n`;
}

function replayDigest(path) {
  return execFileSync(
    "pnpm",
    ["--silent", "ef", "replay", path, "--digest", "--reducer", "packages/streamfs/reducer.mjs"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
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
  const prefixPath = artifactPath("e1-t05-resume-prefix.jsonl");
  const suffixPath = artifactPath("e1-t05-resume-suffix.jsonl");
  const reportPath = artifactPath("e1-t05-emission-reports.jsonl");
  const checkpointPath = artifactPath("e1-t05-checkpoint.json");
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
  const firstEmission = directoryStart + 1;
  const lastEmission = directoryStart + directoryLength;
  const killAt = firstEmission + 1;
  if (killAt <= firstEmission || killAt >= lastEmission) {
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
  writeArtifact(
    "e1-t05-killpoint.json",
    `${JSON.stringify(
      {
        chosenN: killAt,
        directoryRenameEmissionRange: [firstEmission, lastEmission],
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

async function runCrashWindow({ baseUrl, script, expected, workDir }) {
  const repo = await new StreamFs({ baseUrl }).createRepo("watch-crash-window");
  const transcriptPath = join(workDir, "crash-window-transcript.jsonl");
  const reportPath = join(workDir, "crash-window-report.jsonl");
  const checkpointPath = join(workDir, "crash-window-checkpoint.json");
  writeFileSync(transcriptPath, "");
  writeFileSync(reportPath, "");
  writeFileSync(checkpointPath, `${canonicalJson({ offset: "-1" })}\n`);
  const worker = await launchWorker({
    baseUrl,
    streamId: repo.metadataStreamId,
    mode: "long-poll",
    from: "-1",
    transcriptPath,
    reportPath,
    checkpointPath,
    crashAfterTranscript: 1,
    workDir,
  });
  const writerPromise = executeScript(repo, script);
  const killed = await worker.exit;
  await writerPromise;
  if (killed.signal !== "SIGKILL")
    throw new Error(`crash window did not SIGKILL: ${JSON.stringify(killed)}`);
  const prefix = recordsFromFile(transcriptPath);
  const checkpointValue = JSON.parse(readFileSync(checkpointPath, "utf8"));
  if (prefix.length !== 1 || checkpointValue.offset !== "-1") {
    throw new Error("crash window did not leave a flushed transcript with a stale checkpoint");
  }
  const resumed = await launchWorker({
    baseUrl,
    streamId: repo.metadataStreamId,
    mode: "sse",
    from: checkpointValue.offset,
    transcriptPath,
    reportPath: join(workDir, "crash-window-resume-report.jsonl"),
    checkpointPath: join(workDir, "crash-window-resume-checkpoint.json"),
    workDir,
  });
  await waitFor(() => lineCount(transcriptPath) === expected.length, "crash-window recovery");
  await stopWorker(resumed);
  const full = readFileSync(transcriptPath, "utf8");
  if (full !== transcriptText(expected))
    throw new Error("crash-window recovery duplicated an event");
  writeArtifact(
    "e1-t05-crash-window.json",
    `${JSON.stringify(
      {
        kill: "after transcript append before checkpoint rename",
        persistedCheckpoint: checkpointValue.offset,
        flushedPrefixRecords: prefix.length,
        flushedPrefixLastOffset: prefix.at(-1)?.offset,
        recoveredWithoutDuplicate: true,
      },
      null,
      2,
    )}\n`,
  );
  return repo;
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
    if (killAt > directoryStart + 1 && killAt < directoryStart + directoryLength) {
      directoryRenameInteriorKillPoints.push(killAt);
    }
  }
  writeArtifact(
    "e1-t05-sweep.json",
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
  const script = readScript();
  const goldenPath = join(evidenceRoot, "e1-t05-golden-transcript.jsonl");
  const committedGolden = recordsFromFile(goldenPath);
  const longpoll = await runLiveMode({ baseUrl, mode: "long-poll", script, workDir });
  const sse = await runLiveMode({ baseUrl, mode: "sse", script, workDir });
  const generatedGoldenText = transcriptText(longpoll.expected);
  if (generatedGoldenText !== transcriptText(committedGolden)) {
    throw new Error(
      "pure mapping from the committed writer script differs from the committed golden",
    );
  }
  assertArtifact("e1-t05-golden-transcript.jsonl", generatedGoldenText);
  assertArtifact("e1-t05-transcript-longpoll.jsonl", readFileSync(longpoll.transcriptPath));
  assertArtifact("e1-t05-transcript-sse.jsonl", readFileSync(sse.transcriptPath));

  const fsLogText = `${longpoll.metadata.map((record) => canonicalJson(record)).join("\n")}\n`;
  const generatedFsLogPath = join(workDir, "generated-fs-log.jsonl");
  writeFileSync(generatedFsLogPath, fsLogText);
  const committedFsLog = recordsFromFile(join(evidenceRoot, "e1-t05-fs-log.jsonl"));
  if (normalizedFsLogText(longpoll.metadata) !== normalizedFsLogText(committedFsLog)) {
    throw new Error("metadata event log differs from the committed writer-script provenance");
  }
  if (recordRun) writeArtifact("e1-t05-fs-log.jsonl", fsLogText);
  const replayDigestValue = replayDigest(generatedFsLogPath);
  const expected = committedGolden;
  const resume = await runKillResume({ baseUrl, script, expected, workDir });
  await runCrashWindow({ baseUrl, script, expected, workDir });
  const inside = await runSweep({
    baseUrl,
    repo: resume.repo,
    expected,
    directoryStart: resume.directoryStart,
    directoryLength: resume.directoryLength,
    workDir,
  });
  if (inside.length === 0)
    throw new Error("kill sweep did not observe an interior decomposition point");

  for (const name of [
    "e1-t05-checkpoint.json",
    "e1-t05-emission-reports.jsonl",
    "e1-t05-killpoint.json",
    "e1-t05-resume-prefix.jsonl",
    "e1-t05-resume-suffix.jsonl",
    "e1-t05-sweep.json",
    "e1-t05-crash-window.json",
  ]) {
    assertArtifact(name, readFileSync(artifactPath(name)));
  }

  const pureBeforeWatch = await resume.repo.dump();
  const pureBeforeHead = pureBeforeWatch.at(-1)?.offset ?? "-1";
  const pureBeforeTreeDigest = stateDigest(await resume.repo.tree());
  const pureBeforeLogPath = join(workDir, "pure-before-fs-log.jsonl");
  writeFileSync(
    pureBeforeLogPath,
    `${pureBeforeWatch.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const pureBeforeReplayDigest = replayDigest(pureBeforeLogPath);
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
  const pureAfterHead = pureAfterWatch.at(-1)?.offset ?? "-1";
  const pureAfterTreeDigest = stateDigest(await resume.repo.tree());
  const pureAfterLogPath = join(workDir, "pure-after-fs-log.jsonl");
  writeFileSync(
    pureAfterLogPath,
    `${pureAfterWatch.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const pureAfterReplayDigest = replayDigest(pureAfterLogPath);
  if (canonicalJson(pureBeforeWatch) !== canonicalJson(pureAfterWatch)) {
    throw new Error("watch session changed the metadata stream");
  }
  assertArtifact(
    "e1-t05-pure-reader.json",
    `${JSON.stringify(
      {
        before: {
          headOffset: pureBeforeHead,
          treeDigest: pureBeforeTreeDigest,
          replayDigest: pureBeforeReplayDigest,
        },
        after: {
          headOffset: pureAfterHead,
          treeDigest: pureAfterTreeDigest,
          replayDigest: pureAfterReplayDigest,
        },
        dumpUnchanged: true,
      },
      null,
      2,
    )}\n`,
  );

  const digestLines = [
    `replayDigest=${replayDigestValue}`,
    `goldenSha256=${digestText(generatedGoldenText)}`,
    `longpollSha256=${digestFile(artifactPath("e1-t05-transcript-longpoll.jsonl"))}`,
    `sseSha256=${digestFile(artifactPath("e1-t05-transcript-sse.jsonl"))}`,
    `resumePrefixSha256=${digestFile(artifactPath("e1-t05-resume-prefix.jsonl"))}`,
    `resumeSuffixSha256=${digestFile(artifactPath("e1-t05-resume-suffix.jsonl"))}`,
    `metadataTreeDigest=${stateDigest(await longpoll.repo.tree())}`,
    `insideDecompositionKillPoints=${inside.join(",")}`,
    "pureReader=unchanged-head-and-digest-static-watch",
  ];
  assertArtifact("e1-t05-digests.txt", `${digestLines.join("\n")}\n`);
  if (!recordRun) {
    const status = execFileSync(
      "git",
      [
        "status",
        "--short",
        "--untracked-files=all",
        "--",
        ".eforest/tasks/epic-1-the-trunk/E1-T05-watch-chokidar/evidence",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
    if (status.length > 0) throw new Error(`verification mutated committed evidence:\n${status}`);
  }
  console.log(digestLines.join(" "));
} finally {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}
