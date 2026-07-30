#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const phases = ["OPEN", "SEALING", "CLOSED", "DECIDED_CLEAN", "PUBLISHING"];

function failure(message) {
  throw new Error(`E3-T02 recorder lifecycle: ${message}`);
}

function parseJsonLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    failure(
      `cannot read telemetry journal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lines = text.trimEnd().split("\n");
  if (lines.length === 0 || lines[0] === "") failure("telemetry journal is empty");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      failure(`telemetry journal line ${String(index + 1)} is not JSON`);
    }
  });
}

function appendTransition(path, session, seq, phase, extra = {}) {
  appendFileSync(
    path,
    `${JSON.stringify({ v: 1, session, seq, phase, kind: "transition", to: phase, ...extra })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function validateTerminalJournal(path, session) {
  const records = parseJsonLines(path);
  let expectedSeq = 1;
  let currentPhase;
  let activity = 0;
  const failures = [];
  for (const [index, record] of records.entries()) {
    if (
      record === null ||
      typeof record !== "object" ||
      record.v !== 1 ||
      record.session !== session ||
      record.seq !== expectedSeq ||
      typeof record.phase !== "string" ||
      typeof record.kind !== "string"
    ) {
      failure(`malformed or inconsistent telemetry record ${String(index + 1)}`);
    }
    expectedSeq += 1;
    if (record.kind === "transition") {
      const expectedKeys =
        record.phase === "SEALING"
          ? [
              "activity",
              "failureCount",
              "kind",
              "phase",
              "seq",
              "session",
              "stableSamples",
              "to",
              "v",
            ]
          : ["kind", "phase", "seq", "session", "to", "v"];
      if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
        failure(`terminal telemetry record ${String(index + 1)} has missing or extra keys`);
      }
      if (record.to !== record.phase || !phases.includes(record.phase)) {
        failure(`unknown telemetry transition at record ${String(index + 1)}`);
      }
      const expected =
        currentPhase === undefined ? "OPEN" : currentPhase === "OPEN" ? "SEALING" : undefined;
      if (record.phase !== expected) {
        failure(`illegal producer transition ${String(currentPhase)} -> ${record.phase}`);
      }
      currentPhase = record.phase;
      if (record.phase === "SEALING") {
        if (
          !Number.isInteger(record.activity) ||
          record.activity !== activity ||
          !Number.isInteger(record.failureCount) ||
          record.failureCount !== failures.length ||
          !Number.isInteger(record.stableSamples) ||
          record.stableSamples < 2
        ) {
          failure("SEALING telemetry counters are stale or contradictory");
        }
      }
    } else if (record.kind === "failure") {
      if (
        JSON.stringify(Object.keys(record).sort()) !==
        JSON.stringify(["failure", "kind", "phase", "seq", "session", "v"])
      ) {
        failure(`telemetry failure record ${String(index + 1)} has missing or extra keys`);
      }
      if (
        (record.phase !== "OPEN" && record.phase !== "SEALING") ||
        record.failure === null ||
        typeof record.failure !== "object" ||
        !["console.error", "pageerror", "requestfailed"].includes(record.failure.class) ||
        typeof record.failure.detail !== "string"
      ) {
        failure(`malformed telemetry failure at record ${String(index + 1)}`);
      }
      activity += 1;
      failures.push(record.failure);
    } else {
      failure(`unknown telemetry record kind ${record.kind}`);
    }
  }
  if (currentPhase !== "SEALING") failure("producer journal did not reach SEALING");
  return { activity, failures, nextSeq: expectedSeq, records: records.length };
}

function parseResult(label, transcript) {
  const match = transcript.match(/(?:^|\n)### Result\s*\n(\{[^\n]*\})(?:\n|$)/);
  if (!match) failure(`${label} has no machine-readable result`);
  try {
    return JSON.parse(match[1]);
  } catch {
    failure(`${label} result is not JSON`);
  }
}

function validateTranscripts({
  walkthroughPath,
  finalTelemetryPath,
  consolePath,
  requestsPath,
  session,
}) {
  const walkthrough = parseResult("walkthrough", readFileSync(walkthroughPath, "utf8"));
  const terminal = parseResult("final telemetry", readFileSync(finalTelemetryPath, "utf8"));
  for (const [label, value] of [
    ["walkthrough", walkthrough],
    ["final telemetry", terminal],
  ]) {
    if (!Array.isArray(value.telemetryFailures) || value.telemetryFailures.length !== 0) {
      failure(`${label} reported browser failures`);
    }
  }
  if (
    JSON.stringify(Object.keys(terminal).sort()) !==
      JSON.stringify(["activity", "phase", "session", "stableSamples", "telemetryFailures", "v"]) ||
    terminal.v !== 1 ||
    terminal.session !== session ||
    terminal.phase !== "SEALING" ||
    !Number.isInteger(terminal.activity) ||
    !Number.isInteger(terminal.stableSamples) ||
    terminal.stableSamples < 2
  ) {
    failure("final telemetry schema is missing, stale, or unknown");
  }
  const consoleText = readFileSync(consolePath, "utf8");
  const summary = /Total messages:\s*(\d+)\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\)/.exec(
    consoleText,
  );
  if (!summary || Number(summary[2]) !== 0) failure("console transcript is missing or red");
  const requests = readFileSync(requestsPath, "utf8");
  if (!/(?:^|\n)### Result(?:\n|$)/.test(requests)) failure("requests transcript has no result");
  if (/(?:=>\s*\[(?:FAILED|ERROR)\]|\bnet::ERR_[A-Z_]+\b|\brequestfailed\b)/i.test(requests)) {
    failure("requests transcript reported a transport failure");
  }
  let authorizationUrl;
  try {
    authorizationUrl = new URL(walkthrough.authorizationUrl);
  } catch {
    failure("walkthrough has no valid authorization URL binding");
  }
  if (
    authorizationUrl.protocol !== "http:" ||
    authorizationUrl.hostname !== "127.0.0.1" ||
    authorizationUrl.pathname !== "/authorize" ||
    !authorizationUrl.searchParams.get("state") ||
    !authorizationUrl.searchParams.get("nonce") ||
    !authorizationUrl.searchParams.get("code_challenge")
  ) {
    failure("walkthrough authorization URL binding is incomplete or non-loopback");
  }
  return { authorizationUrl: authorizationUrl.href };
}

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function listedRecordings(cwd) {
  const result = run("replayio", ["list", "--json"], cwd);
  if (result.status !== 0) failure(`cannot list Replay recordings: ${result.stderr.trim()}`);
  const start = result.stdout.indexOf("[");
  if (start < 0) failure("Replay recording list has no JSON array");
  try {
    return JSON.parse(result.stdout.slice(start));
  } catch {
    failure("Replay recording list is not JSON");
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForFinishedRecording(cwd, recordingId) {
  const deadline = Date.now() + 15_000;
  let recordings = listedRecordings(cwd);
  if (!recordings.some((recording) => recording?.id === recordingId)) return recordings;
  while (
    Date.now() < deadline &&
    recordings.some(
      (recording) => recording?.id === recordingId && recording.recordingStatus === "recording",
    )
  ) {
    sleep(250);
    recordings = listedRecordings(cwd);
  }
  return recordings;
}

function hasExactKeys(record, keys) {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...keys].sort());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function processRecordingEvidence(recordingDirectory, recordingId, recordedUrl) {
  const directoryStat = lstatSync(recordingDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    failure("run-private recording directory is not a real directory");
  }
  const directory = realpathSync(recordingDirectory);
  const logPath = resolve(directory, "recordings.log");
  const logStat = lstatSync(logPath);
  if (!logStat.isFile() || logStat.isSymbolicLink() || realpathSync(logPath) !== logPath) {
    failure("run-private browser process log is not a real file");
  }
  const records = parseJsonLines(logPath);
  const matching = records
    .map((record, index) => ({ index, record }))
    .filter(({ record }) => record?.id === recordingId || record?.recordingId === recordingId);
  for (const { record } of matching) {
    if (!Number.isInteger(record.timestamp)) {
      failure("same-recording process record has an invalid timestamp");
    }
    if (record.kind === "createRecording") {
      if (
        record.id !== recordingId ||
        record.recordingId !== undefined ||
        !hasExactKeys(record, ["buildId", "driverVersion", "id", "kind", "timestamp"]) ||
        typeof record.buildId !== "string" ||
        typeof record.driverVersion !== "string"
      ) {
        failure("createRecording process record has an invalid schema");
      }
    } else if (record.kind === "writeStarted") {
      if (
        record.id !== recordingId ||
        record.recordingId !== undefined ||
        !hasExactKeys(record, ["id", "kind", "path", "timestamp"])
      ) {
        failure("writeStarted process record has an invalid schema");
      }
    } else if (record.kind === "writeFinished") {
      if (
        record.id !== recordingId ||
        record.recordingId !== undefined ||
        !hasExactKeys(record, ["id", "kind", "timestamp"])
      ) {
        failure("writeFinished process record has an invalid schema");
      }
    } else if (record.kind === "addMetadata") {
      const uriMetadata = hasExactKeys(record.metadata ?? {}, ["uri"]);
      const processMetadata = hasExactKeys(record.metadata ?? {}, ["process"]);
      if (
        record.id !== recordingId ||
        record.recordingId !== undefined ||
        !hasExactKeys(record, ["id", "kind", "metadata", "timestamp"]) ||
        record.metadata === null ||
        typeof record.metadata !== "object" ||
        Array.isArray(record.metadata) ||
        (!uriMetadata && !processMetadata) ||
        (uriMetadata && typeof record.metadata.uri !== "string") ||
        (processMetadata && record.metadata.process !== "root")
      ) {
        failure("addMetadata process record has an invalid schema");
      }
    } else if (record.kind === "sourcemapAdded") {
      let sourceMapUrl;
      let sourceMapBaseUrl;
      try {
        sourceMapUrl = new URL(record.url);
        sourceMapBaseUrl = new URL(record.baseURL);
      } catch {
        failure("sourcemapAdded process record has invalid URLs");
      }
      if (
        record.recordingId !== recordingId ||
        record.id === recordingId ||
        !hasExactKeys(record, [
          "baseURL",
          "id",
          "kind",
          "path",
          "recordingId",
          "targetContentHash",
          "targetMapURLHash",
          "targetURLHash",
          "timestamp",
          "url",
        ]) ||
        !/^[0-9a-f]{64}$/i.test(record.id) ||
        typeof record.path !== "string" ||
        sourceMapUrl.href !== record.url ||
        sourceMapBaseUrl.href !== record.baseURL ||
        !/^sha256:[0-9a-f]{64}$/i.test(record.targetContentHash) ||
        !/^sha256:[0-9a-f]{64}$/i.test(record.targetMapURLHash) ||
        !/^sha256:[0-9a-f]{64}$/i.test(record.targetURLHash)
      ) {
        failure("sourcemapAdded process record has an invalid schema");
      }
    } else {
      failure(`unexpected same-recording process event: ${String(record.kind)}`);
    }
  }
  const creates = matching.filter(({ record }) => record.kind === "createRecording");
  const starts = matching.filter(({ record }) => record.kind === "writeStarted");
  const finishes = matching.filter(({ record }) => record.kind === "writeFinished");
  if (creates.length !== 1 || starts.length !== 1 || finishes.length !== 1) {
    failure("run-private browser process log does not prove one complete recording");
  }
  const create = creates[0];
  const start = starts[0];
  const finish = finishes[0];
  const auxiliary = matching.filter(
    ({ record }) => record.kind === "addMetadata" || record.kind === "sourcemapAdded",
  );
  const uriMetadata = auxiliary.filter(
    ({ record }) => record.kind === "addMetadata" && record.metadata.uri !== undefined,
  );
  const processMetadata = auxiliary.filter(
    ({ record }) => record.kind === "addMetadata" && record.metadata.process !== undefined,
  );
  if (uriMetadata.length !== 1 || processMetadata.length !== 1) {
    failure("recording process metadata does not prove one browser identity");
  }
  const sourceMapIds = new Set();
  const sourceMapPaths = new Set();
  const sourceMapObjects = new Set();
  for (const entry of auxiliary) {
    const lowerBound = entry.record.kind === "sourcemapAdded" ? start : create;
    if (
      !(lowerBound.index < entry.index && entry.index < finish.index) ||
      !(lowerBound.record.timestamp <= entry.record.timestamp) ||
      !(entry.record.timestamp < finish.record.timestamp)
    ) {
      failure("associated process record falls outside its recording interval");
    }
    if (entry.record.kind === "addMetadata" && entry.record.metadata.uri !== undefined) {
      let metadataUrl;
      try {
        metadataUrl = new URL(entry.record.metadata.uri);
      } catch {
        failure("recording process metadata has an invalid browser URI");
      }
      if (metadataUrl.href !== recordedUrl.href) {
        failure("recording process metadata conflicts with the local Replay catalog");
      }
    }
    if (entry.record.kind === "sourcemapAdded") {
      if (sourceMapIds.has(entry.record.id)) {
        failure("source-map artifact ID is not unique within the recording");
      }
      sourceMapIds.add(entry.record.id);
      let sourceMapPath;
      let sourceMapStat;
      try {
        sourceMapStat = lstatSync(entry.record.path);
        sourceMapPath = realpathSync(entry.record.path);
        if (
          !sourceMapStat.isFile() ||
          sourceMapStat.isSymbolicLink() ||
          sourceMapStat.nlink !== 1 ||
          dirname(sourceMapPath) !== directory ||
          sourceMapPath !== resolve(directory, `sourcemap-${entry.record.id}.map`) ||
          statSync(sourceMapPath).size <= 0
        ) {
          failure("source-map artifact is not a real run-private file");
        }
      } catch {
        failure("source-map artifact is not a real run-private file");
      }
      if (sourceMapPaths.has(sourceMapPath)) {
        failure("source-map artifact path is not unique within the recording");
      }
      sourceMapPaths.add(sourceMapPath);
      const objectIdentity = `${String(sourceMapStat.dev)}:${String(sourceMapStat.ino)}`;
      if (sourceMapObjects.has(objectIdentity)) {
        failure("source-map filesystem object is not unique within the recording");
      }
      sourceMapObjects.add(objectIdentity);
      let sourceMap;
      try {
        sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
      } catch {
        failure("source-map artifact is not valid JSON");
      }
      if (
        sourceMap === null ||
        typeof sourceMap !== "object" ||
        sourceMap.version !== 3 ||
        typeof sourceMap.file !== "string" ||
        sourceMap.file.length === 0
      ) {
        failure("source-map artifact has no canonical generated-script identity");
      }
      let targetUrl;
      try {
        targetUrl = new URL(sourceMap.file, entry.record.baseURL);
      } catch {
        failure("source-map artifact has no canonical generated-script identity");
      }
      if (
        entry.record.url.includes("%") ||
        entry.record.baseURL.includes("%") ||
        targetUrl.href.includes("%") ||
        entry.record.targetContentHash !== `sha256:${entry.record.id}` ||
        entry.record.targetMapURLHash !== `sha256:${sha256(entry.record.url)}` ||
        entry.record.targetURLHash !== `sha256:${sha256(targetUrl.href)}`
      ) {
        failure("source-map descriptor is not cryptographically self-consistent");
      }
    }
  }
  const recordingPath = realpathSync(start.record.path);
  if (
    !(create.index < start.index && start.index < finish.index) ||
    dirname(recordingPath) !== directory ||
    recordingPath !== resolve(directory, `recording-${recordingId}.dat`) ||
    !lstatSync(recordingPath).isFile() ||
    statSync(recordingPath).size <= 0 ||
    !Number.isInteger(create.record.timestamp) ||
    !Number.isInteger(start.record.timestamp) ||
    !Number.isInteger(finish.record.timestamp) ||
    !(
      create.record.timestamp <= start.record.timestamp &&
      start.record.timestamp < finish.record.timestamp
    )
  ) {
    failure("recording file is not owned by the run-private browser process");
  }
  return {
    recordingPath,
    artifactPaths: [
      recordingPath,
      ...auxiliary
        .filter(({ record }) => record.kind === "sourcemapAdded")
        .map(({ record }) => realpathSync(record.path)),
    ],
  };
}

function validateRecordingBinding(recordings, recordingId, authorizationUrl, recordingDirectory) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordingId)
  ) {
    failure("recording ID is not a UUID");
  }
  const matches = recordings.filter((recording) => recording?.id === recordingId);
  if (matches.length !== 1)
    failure("recording ID is not uniquely present in the local Replay list");
  const recording = matches[0];
  let recordedUrl;
  try {
    recordedUrl = new URL(recording.metadata?.uri);
  } catch {
    failure("recording metadata has no valid browser URI");
  }
  const processEvidence = processRecordingEvidence(recordingDirectory, recordingId, recordedUrl);
  const expectedUrl = new URL(authorizationUrl);
  for (const key of ["state", "nonce", "code_challenge"]) {
    if (recordedUrl.searchParams.get(key) !== expectedUrl.searchParams.get(key)) {
      failure(`recording metadata does not match browser authorization ${key}`);
    }
  }
  if (
    recordedUrl.origin !== expectedUrl.origin ||
    recordedUrl.pathname !== expectedUrl.pathname ||
    recording.recordingStatus !== "finished" ||
    recording.uploadStatus === "uploaded" ||
    typeof recording.path !== "string" ||
    realpathSync(recording.path) !== processEvidence.recordingPath
  ) {
    failure("recording metadata is not bound to the closed browser session");
  }
  return { recording, recordedUrl, ...processEvidence };
}

function sealRecordingDirectory(recordingDirectory, recordingId) {
  const source = realpathSync(recordingDirectory);
  const sealed = `${source}.sealed-${recordingId}`;
  if (existsSync(sealed)) failure("sealed recording directory already exists");
  renameSync(source, sealed);
  const logPath = resolve(sealed, "recordings.log");
  const records = parseJsonLines(logPath).map((record) => {
    if (record?.kind === "writeStarted" && record.id === recordingId) {
      return { ...record, path: resolve(sealed, `recording-${recordingId}.dat`) };
    }
    if (record?.kind === "sourcemapAdded" && record.recordingId === recordingId) {
      return { ...record, path: resolve(sealed, `sourcemap-${record.id}.map`) };
    }
    return record;
  });
  writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
  return sealed;
}

function artifactManifest(paths) {
  return paths
    .map((path) => {
      const stat = statSync(path);
      return {
        name: basename(path),
        bytes: stat.size,
        sha256: sha256(readFileSync(path)),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function setPublicationFlags(recordingDirectory, artifactPaths) {
  for (const path of artifactPaths) chmodSync(path, 0o444);
  const immutable = run("chflags", ["uchg", ...artifactPaths, recordingDirectory], process.cwd());
  if (immutable.status !== 0) {
    failure(`cannot make sealed publication artifacts immutable: ${immutable.stderr.trim()}`);
  }
  const appendOnly = run(
    "chflags",
    ["uappnd", resolve(recordingDirectory, "recordings.log")],
    process.cwd(),
  );
  if (appendOnly.status !== 0) {
    run("chflags", ["nouchg", recordingDirectory, ...artifactPaths], process.cwd());
    failure(`cannot make sealed process log append-only: ${appendOnly.stderr.trim()}`);
  }
}

function clearPublicationFlags(recordingDirectory, artifactPaths) {
  const directory = run("chflags", ["nouchg", recordingDirectory], process.cwd());
  const log = run(
    "chflags",
    ["nouappnd", resolve(recordingDirectory, "recordings.log")],
    process.cwd(),
  );
  const artifacts = run("chflags", ["nouchg", ...artifactPaths], process.cwd());
  if (directory.status !== 0 || log.status !== 0 || artifacts.status !== 0) {
    failure("cannot clear sealed publication filesystem flags");
  }
}

export function validateMp4(videoPath, cwd = process.cwd()) {
  if (!existsSync(videoPath) || statSync(videoPath).size <= 0) failure("MP4 is missing or empty");
  const probe = run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=nw=1:nk=1",
      videoPath,
    ],
    cwd,
  );
  if (probe.status !== 0 || probe.stdout.trim() !== "h264") {
    failure("MP4 is truncated, unreadable, or not H.264");
  }
}

function parseCloseOutput(result, videoPath) {
  if (result.status !== 0) failure(`browser close failed: ${result.stderr.trim()}`);
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    failure("browser close did not return JSON");
  }
  if (
    receipt.browser_close !== "ok" ||
    !receipt.video ||
    resolve(receipt.video.output) !== resolve(videoPath) ||
    receipt.video.bytes <= 0 ||
    !/mp4|quicktime/i.test(receipt.video.mime ?? "") ||
    !/Upload skipped/.test(receipt.upload?.result?.stdout ?? "")
  ) {
    failure("browser close receipt is incomplete or inconsistent");
  }
  return receipt;
}

export function runRecorderLifecycle(options, dependencies = {}) {
  const cwd = options.cwd ?? process.cwd();
  const receiptPath = resolve(options.receiptPath);
  if (existsSync(receiptPath)) {
    failure("success receipt already exists; refusing a second publication");
  }
  const transcriptBinding = validateTranscripts(options);
  const beforeClose = validateTerminalJournal(options.journalPath, options.session);
  if (beforeClose.failures.length > 0) failure("browser failure observed before close");

  const close =
    dependencies.close ??
    (() =>
      run(
        process.execPath,
        [
          options.browserClosePath,
          "--session",
          options.session,
          "--output",
          options.videoPath,
          "--upload",
          "false",
        ],
        cwd,
      ));
  const closeReceipt = parseCloseOutput(close(), options.videoPath);

  const terminal = validateTerminalJournal(options.journalPath, options.session);
  appendTransition(options.journalPath, options.session, terminal.nextSeq, "CLOSED", {
    producersClosed: true,
    activity: terminal.activity,
    failureCount: terminal.failures.length,
  });
  if (terminal.failures.length > 0) failure("browser failure observed while close began");
  (dependencies.validateVideo ?? validateMp4)(options.videoPath, cwd);
  const recordings = (
    dependencies.listRecordings ?? (() => waitForFinishedRecording(cwd, options.recordingId))
  )();
  const originalBinding = validateRecordingBinding(
    recordings,
    options.recordingId,
    transcriptBinding.authorizationUrl,
    options.recordingDirectory,
  );
  const originalManifest = artifactManifest(originalBinding.artifactPaths);
  const sealedRecordingDirectory = sealRecordingDirectory(
    options.recordingDirectory,
    options.recordingId,
  );
  const sealedRecordingPath = resolve(
    sealedRecordingDirectory,
    `recording-${options.recordingId}.dat`,
  );
  const sealedRecordings = recordings.map((recording) =>
    recording?.id === options.recordingId ? { ...recording, path: sealedRecordingPath } : recording,
  );
  const sealedBinding = validateRecordingBinding(
    sealedRecordings,
    options.recordingId,
    transcriptBinding.authorizationUrl,
    sealedRecordingDirectory,
  );
  const sealedManifest = artifactManifest(sealedBinding.artifactPaths);
  const sealedLogPath = resolve(sealedRecordingDirectory, "recordings.log");
  const sealedLogPrefix = readFileSync(sealedLogPath, "utf8");
  if (
    JSON.stringify(originalManifest) !== JSON.stringify(sealedManifest) ||
    basename(originalBinding.recordingPath) !== basename(sealedBinding.recordingPath)
  ) {
    failure("sealed recording snapshot does not match the validated browser process");
  }
  appendTransition(options.journalPath, options.session, terminal.nextSeq + 1, "DECIDED_CLEAN", {
    producersClosed: true,
    video: resolve(options.videoPath),
    sealedArtifactCount: sealedManifest.length,
  });
  appendTransition(options.journalPath, options.session, terminal.nextSeq + 2, "PUBLISHING", {
    publicationAttempt: 1,
  });

  setPublicationFlags(sealedRecordingDirectory, sealedBinding.artifactPaths);
  const publish =
    dependencies.publish ??
    (() =>
      run("replayio", ["upload", options.recordingId], cwd, {
        ...process.env,
        RECORD_REPLAY_DIRECTORY: sealedRecordingDirectory,
      }));
  try {
    const upload = publish({
      recordingDirectory: sealedRecordingDirectory,
      manifest: sealedManifest,
    });
    if (upload.status !== 0 || /\(failed\)|Upload failed/i.test(upload.stdout ?? "")) {
      failure(
        `Replay upload failed: ${(upload.stderr || upload.stdout || "unknown failure").trim()}`,
      );
    }
    if (
      JSON.stringify(artifactManifest(sealedBinding.artifactPaths)) !==
      JSON.stringify(sealedManifest)
    ) {
      failure("sealed recording artifacts changed during publication");
    }
    if (!readFileSync(sealedLogPath, "utf8").startsWith(sealedLogPrefix)) {
      failure("sealed recording process log changed before its append-only boundary");
    }
  } finally {
    clearPublicationFlags(sealedRecordingDirectory, sealedBinding.artifactPaths);
  }
  const receipt = {
    v: 1,
    session: options.session,
    recordingId: options.recordingId,
    video: closeReceipt.video,
    lifecycle: phases,
    publicationCount: 1,
    telemetryActivity: terminal.activity,
    sealedArtifactManifest: sealedManifest,
    sealedLogPrefixSha256: sha256(sealedLogPrefix),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return receipt;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      failure("arguments must be --name value pairs");
    result[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const required = [
      "session",
      "recordingId",
      "recordingDirectory",
      "journalPath",
      "walkthroughPath",
      "finalTelemetryPath",
      "consolePath",
      "requestsPath",
      "videoPath",
      "receiptPath",
      "browserClosePath",
    ];
    for (const field of required) if (!args[field]) failure(`missing --${field}`);
    const receipt = runRecorderLifecycle({ ...args, cwd: process.cwd() });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
