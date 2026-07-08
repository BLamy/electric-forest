#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stderr: String(error.stderr || error.message || error).trim(),
    };
  }
}

function runPlaywright(args, sessionName, timeoutMs) {
  const sessionArgs = sessionName ? [`-s=${sessionName}`] : [];
  return run("npx", ["--yes", "--package", "@playwright/cli", "playwright-cli", ...sessionArgs, ...args], {
    timeoutMs,
  });
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function hasState(state) {
  return Boolean(state && Object.keys(state).length > 0);
}

function safeSessionName(sessionName) {
  return String(sessionName).replace(/[^a-zA-Z0-9_.-]+/g, "_") || "default";
}

function sessionStatePath(sessionName) {
  return path.join(process.cwd(), ".replay", `browser-session-${safeSessionName(sessionName)}.json`);
}

function getMime(filePath) {
  const result = run("file", ["-b", "--mime-type", filePath]);
  return result.ok ? result.stdout.trim() : "";
}

function existingCaptureCandidate(filePath, kind) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const stats = fs.statSync(filePath);
  if (stats.size <= 0) {
    throw new Error(`Capture file is empty: ${filePath}`);
  }
  return {
    sourcePath: filePath,
    sourceKind: kind,
    sourceMime: getMime(filePath),
    sourceBytes: stats.size,
  };
}

function adjacentCaptureCandidates(outputPath) {
  if (!outputPath || path.extname(outputPath).toLowerCase() !== ".mp4") return [];
  const parsed = path.parse(outputPath);
  const base = path.join(parsed.dir, parsed.name);
  return [
    { filePath: `${base}.capture.webm`, kind: "adjacent_capture_webm" },
    { filePath: `${base}.source.webm`, kind: "adjacent_source_webm" },
    { filePath: `${base}.webm`, kind: "adjacent_webm" },
  ];
}

function resolveCaptureSource(webmPath, outputPath) {
  const webmCandidate = existingCaptureCandidate(webmPath, "webm_path");
  if (webmCandidate) return webmCandidate;

  const outputCandidate = existingCaptureCandidate(outputPath, "output_path");
  if (outputCandidate) return outputCandidate;

  for (const candidate of adjacentCaptureCandidates(outputPath)) {
    const adjacentCandidate = existingCaptureCandidate(candidate.filePath, candidate.kind);
    if (adjacentCandidate) return adjacentCandidate;
  }

  const expected = webmPath || outputPath;
  throw new Error(
    [
      `Expected capture file was not created: ${expected}`,
      "Run browser-close.js with --output /path/to/final.mp4; it automatically handles WebM bytes at that path.",
      "It also auto-detects adjacent .capture.webm, .source.webm, and .webm files that match the output basename.",
    ].join("\n")
  );
}

function parseBoolean(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return !/^(0|false|no|off)$/i.test(String(value));
}

function parsePositiveNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function formatFilterNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function ffmpegInstallInstructions() {
  return [
    "ffmpeg is required to create MP4 recordings.",
    "",
    "Install it, then rerun:",
    "",
    "macOS:",
    "  brew install ffmpeg",
    "",
    "Ubuntu/Debian:",
    "  sudo apt update && sudo apt install ffmpeg",
    "",
    "Windows:",
    "  winget install Gyan.FFmpeg",
    "  # or: choco install ffmpeg",
    "",
    "After install, verify:",
    "  ffmpeg -version",
  ].join("\n");
}

function requireFfmpeg() {
  const result = run("ffmpeg", ["-version"]);
  if (!result.ok) {
    throw new Error(ffmpegInstallInstructions());
  }
}

function runFfmpeg(args) {
  const result = run("ffmpeg", args);
  if (!result.ok) {
    throw new Error(`ffmpeg failed while creating MP4 output:\n${result.stderr}`);
  }
  return result;
}

function buildStaleCompressionFilter(options) {
  if (!options.compressStaleFrames) return undefined;
  const timeScale = formatFilterNumber(options.staleTimeScale);
  const fps = formatFilterNumber(options.fps);
  return `mpdecimate,setpts=(${timeScale}*N)/(${fps}*TB),fps=${fps}`;
}

function buildFfmpegArgs(sourcePath, targetPath, options) {
  const args = ["-y", "-i", sourcePath];
  const staleCompressionFilter = buildStaleCompressionFilter(options);
  if (staleCompressionFilter) {
    args.push("-vf", staleCompressionFilter);
  }
  args.push(
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    String(options.crf),
    "-preset",
    options.preset,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    targetPath
  );
  return args;
}

function transcodeWebmToMp4(sourcePath, outputPath, options = {}) {
  requireFfmpeg();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const samePath = path.resolve(sourcePath) === path.resolve(outputPath);
  const targetPath = samePath
    ? path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.transcoded-${Date.now()}.mp4`)
    : outputPath;
  const transcodeOptions = {
    compressStaleFrames: options.compressStaleFrames !== false,
    crf: options.crf || 28,
    fps: options.fps || 30,
    preset: options.preset || "veryfast",
    staleTimeScale: options.staleTimeScale || 3,
  };
  let staleCompressionApplied = transcodeOptions.compressStaleFrames;
  let filter = buildStaleCompressionFilter(transcodeOptions);

  try {
    runFfmpeg(buildFfmpegArgs(sourcePath, targetPath, transcodeOptions));
  } catch (error) {
    if (!staleCompressionApplied) {
      throw error;
    }
    staleCompressionApplied = false;
    filter = undefined;
    runFfmpeg(buildFfmpegArgs(sourcePath, targetPath, { ...transcodeOptions, compressStaleFrames: false }));
  }

  if (samePath) {
    fs.unlinkSync(outputPath);
    fs.renameSync(targetPath, outputPath);
  }

  return {
    stale_compression: staleCompressionApplied,
    stale_compression_filter: filter,
    crf: transcodeOptions.crf,
    fps: transcodeOptions.fps,
    preset: transcodeOptions.preset,
    stale_time_scale: transcodeOptions.staleTimeScale,
  };
}

function parseReplayList(output) {
  const jsonStart = output.indexOf("[");
  const payload = jsonStart >= 0 ? output.slice(jsonStart) : output;
  return JSON.parse(payload);
}

function listRecordings() {
  const list = run("replayio", ["list", "--json"]);
  if (!list.ok) {
    return { ok: false, error: list.stderr || "replayio list --json failed", recordings: [] };
  }
  try {
    return { ok: true, recordings: parseReplayList(list.stdout) };
  } catch (error) {
    return { ok: false, error: String(error.message || error), recordings: [] };
  }
}

function recentRecordings(recordings, sessionStartedAt, lookbackMs) {
  const startedMs = Date.parse(sessionStartedAt || "");
  const minimumDateMs = Number.isFinite(startedMs) ? startedMs - lookbackMs : Date.now() - lookbackMs;
  return recordings.filter((recording) => {
    const recordingDateMs = Date.parse(recording.date || "");
    return Number.isFinite(recordingDateMs) && recordingDateMs >= minimumDateMs;
  });
}

function waitForRecentRecordings(sessionStartedAt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const pollMs = options.pollMs ?? 1000;
  const lookbackMs = options.lookbackMs ?? 60000;
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  let listError = "";

  while (Date.now() <= deadline) {
    const listed = listRecordings();
    if (!listed.ok) {
      listError = listed.error;
      break;
    }
    latest = recentRecordings(listed.recordings, sessionStartedAt, lookbackMs);
    if (!latest.some((recording) => recording.recordingStatus === "recording")) {
      return { recordings: latest, timedOut: false };
    }
    sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  return { recordings: latest, timedOut: true, error: listError || undefined };
}

function uploadRecordings(sessionStartedAt, options = {}) {
  const uploadAll = process.env.REPLAYIO_UPLOAD_ALL === "1" ? run("replayio", ["upload-all"], { timeoutMs: 180000 }) : undefined;
  if (uploadAll?.ok) {
    if (/\(failed\)|Upload failed/i.test(uploadAll.stdout || "")) {
      return { command: "upload-all", result: { ...uploadAll, ok: false, status: 1 } };
    }
    return { command: "upload-all", result: uploadAll };
  }
  const waited = waitForRecentRecordings(sessionStartedAt, options);
  if (waited.error) {
    return { command: "upload", result: { ok: false, status: 1, stderr: waited.error } };
  }
  const ids = waited.recordings
    .filter((recording) => recording.recordingStatus === "finished" && recording.uploadStatus !== "uploaded")
    .map((recording) => recording.id);
  const stillRecording = waited.recordings
    .filter((recording) => recording.recordingStatus === "recording")
    .map((recording) => recording.id);
  if (ids.length === 0) {
    return {
      command: "upload",
      result: {
        ok: true,
        stdout:
          waited.timedOut && stillRecording.length > 0
            ? `No pending finished recordings. Still recording after wait: ${stillRecording.join(", ")}`
            : "No pending finished recordings.",
      },
      timed_out_waiting_for_finished: waited.timedOut,
      still_recording: stillRecording,
    };
  }
  const upload = run("replayio", ["upload", ...ids], { timeoutMs: 180000 });
  if (upload.ok && /\(failed\)|Upload failed/i.test(upload.stdout || "")) {
    return { command: "upload", result: { ...upload, ok: false, status: 1 }, ids, still_recording: stillRecording };
  }
  return { command: "upload", result: upload, ids, still_recording: stillRecording };
}

const args = parseArgs(process.argv.slice(2));
const latestStatePath = path.join(process.cwd(), ".replay", "browser-session.json");
const requestedSessionName = args.session || process.env.REPLAYIO_PLAYWRIGHT_SESSION || "";
const perSessionStatePath = requestedSessionName ? sessionStatePath(requestedSessionName) : "";
const perSessionState = perSessionStatePath ? readState(perSessionStatePath) : {};
const latestState = readState(latestStatePath);
const state = hasState(perSessionState) ? perSessionState : latestState;
const outputInput = args.output || args.videoPath || args._[0] || state.mp4_path || state.video_path || "";
const output = outputInput ? path.resolve(outputInput) : "";
const webmInput = args.webmPath || state.webm_path || "";
const webmPath = webmInput ? path.resolve(webmInput) : "";
const sessionName = requestedSessionName || state.playwright_session || "";
const playwrightTimeoutMs = parsePositiveNumber(args.playwrightTimeoutMs || process.env.REPLAYIO_PLAYWRIGHT_TIMEOUT_MS, 30000);
const transcodeOptions = {
  compressStaleFrames: parseBoolean(args.compressStale ?? process.env.REPLAYIO_COMPRESS_STALE_FRAMES, true),
  crf: parsePositiveNumber(args.crf || process.env.REPLAYIO_MP4_CRF, 28),
  fps: parsePositiveNumber(args.fps || process.env.REPLAYIO_MP4_FPS, 30),
  preset: String(args.preset || process.env.REPLAYIO_MP4_PRESET || "veryfast"),
  staleTimeScale: parsePositiveNumber(
    args.staleTimeScale || args.timeScale || process.env.REPLAYIO_STALE_TIME_SCALE,
    3
  ),
};
const uploadOptions = {
  timeoutMs: parsePositiveNumber(args.uploadWaitMs || process.env.REPLAYIO_UPLOAD_WAIT_MS, 15000),
  pollMs: parsePositiveNumber(args.uploadPollMs || process.env.REPLAYIO_UPLOAD_POLL_MS, 1000),
  lookbackMs: parsePositiveNumber(args.uploadLookbackMs || process.env.REPLAYIO_UPLOAD_LOOKBACK_MS, 60000),
};
const shouldUpload = parseBoolean(args.upload ?? process.env.REPLAYIO_UPLOAD, true);
const response = { video: undefined, upload: undefined };

if (output && path.extname(output).toLowerCase() === ".mp4") {
  const stopResult = runPlaywright(["video-stop"], sessionName, playwrightTimeoutMs);
  response.video_stop = stopResult.ok ? "ok" : stopResult.stderr;
}

const closeResult = runPlaywright(["close"], sessionName, playwrightTimeoutMs);
response.browser_close = closeResult.ok ? "ok" : closeResult.stderr;

if (output) {
  const { sourcePath, sourceKind, sourceMime, sourceBytes } = resolveCaptureSource(webmPath, output);
  let transcode = {};
  if (/webm/i.test(sourceMime) || path.extname(sourcePath).toLowerCase() === ".webm") {
    transcode = transcodeWebmToMp4(sourcePath, output, transcodeOptions);
  } else if (sourcePath !== output) {
    throw new Error(`Expected WebM capture input or existing MP4 output, got ${sourceMime || "unknown MIME"} at ${sourcePath}`);
  }

  if (!fs.existsSync(output)) {
    throw new Error(`Expected MP4 file was not created: ${output}`);
  }
  const stats = fs.statSync(output);
  if (stats.size <= 0) {
    throw new Error(`MP4 file is empty: ${output}`);
  }
  const mime = getMime(output);
  if (!/mp4|quicktime/i.test(mime)) {
    throw new Error(`The output is ${mime || "unknown MIME"}, not MP4. Do not embed it as an MP4.`);
  }
  response.video = {
    output,
    bytes: stats.size,
    mime: mime || undefined,
    source: sourcePath,
    source_kind: sourceKind,
    source_mime: sourceMime || undefined,
    source_bytes: sourceBytes,
    encoder: "ffmpeg",
    ...transcode,
  };
}

response.upload = shouldUpload
  ? uploadRecordings(state.started_at, uploadOptions)
  : { command: "upload", result: { ok: true, stdout: "Upload skipped by --upload false." } };
if (response.video && response.upload?.result && !response.upload.result.ok) {
  response.upload_warning = "Replay upload failed, but the local MP4 artifact was created and verified.";
}
if (perSessionStatePath) {
  try {
    fs.unlinkSync(perSessionStatePath);
  } catch {}
}
if (!perSessionStatePath || latestState.playwright_session === sessionName) {
  try {
    fs.unlinkSync(latestStatePath);
  } catch {}
}

process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);

if (response.upload?.result && !response.upload.result.ok && !response.video) {
  process.exit(response.upload.result.status || 1);
}
