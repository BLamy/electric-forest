#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function run(command, args) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stderr: String(error.stderr || error.message || error).trim(),
    };
  }
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/)[0] || "";
}

const defaultChromium = path.join(
  os.homedir(),
  ".replay",
  "runtimes",
  "Replay-Chromium.app",
  "Contents",
  "MacOS",
  "Chromium"
);
const executable = process.env.AGENT_BROWSER_EXECUTABLE_PATH || defaultChromium;

const context = {
  replay_cli: {
    info: run("replayio", ["info"]),
    whoami: run("replayio", ["whoami"]),
  },
  ffmpeg: (() => {
    const result = run("ffmpeg", ["-version"]);
    return {
      ok: result.ok,
      version: result.ok ? firstLine(result.stdout) : "",
      install: {
        macos: "brew install ffmpeg",
        ubuntu_debian: "sudo apt update && sudo apt install ffmpeg",
        windows: "winget install Gyan.FFmpeg # or: choco install ffmpeg",
        verify: "ffmpeg -version",
      },
      error: result.ok ? undefined : result.stderr,
    };
  })(),
  jq: (() => {
    const result = run("jq", ["--version"]);
    return {
      ok: result.ok,
      version: result.ok ? firstLine(result.stdout) : "",
      install: {
        macos: "brew install jq",
        ubuntu_debian: "sudo apt update && sudo apt install jq",
        windows: "winget install jqlang.jq",
        verify: "jq --version",
      },
      error: result.ok ? undefined : result.stderr,
    };
  })(),
  replay_chromium: {
    path: executable,
    exists: fs.existsSync(executable),
    executable: fs.existsSync(executable) ? Boolean(fs.statSync(executable).mode & 0o111) : false,
    export_command: `export AGENT_BROWSER_EXECUTABLE_PATH=${JSON.stringify(executable)}`,
  },
  recording_environment: {
    RECORD_ALL_CONTENT: process.env.RECORD_ALL_CONTENT || "",
    RECORD_REPLAY_VERBOSE: process.env.RECORD_REPLAY_VERBOSE || "",
    export_commands: [
      "export RECORD_ALL_CONTENT='1'",
      "export RECORD_REPLAY_VERBOSE='1'",
    ],
  },
  mp4_guidance: {
    use: "plugin root scripts/browser-open.js and scripts/browser-close.js with a .mp4 output path; use the returned playwright_session for CLI interactions; browser-close.js waits for video-stop and ffmpeg before returning",
    internal_capture: "Playwright screencast/video capture writes WebM first, even if video-start was given a .mp4 path; treat video/webm at a .mp4 path as a source capture until browser-close.js/ffmpeg verifies the final MP4",
    source_at_mp4_path:
      "If raw video-start wrote WebM bytes to the requested .mp4 path, run browser-close.js --output that path. Do not move the source or pass --webm-path; browser-close.js also auto-detects adjacent .capture.webm, .source.webm, and .webm files.",
    stale_frame_compression: {
      default: "enabled",
      filter: "mpdecimate,setpts=(3*N)/(30*TB),fps=30",
      stale_time_scale: 3,
      disable: "browser-close.js --compress-stale false or REPLAYIO_COMPRESS_STALE_FRAMES=0",
    },
    upload: "Replay upload failure does not invalidate a verified local MP4; embed the MP4 and report upload failure separately.",
    avoid: "Playwright BrowserContext recordVideo, native Chromium video artifacts, or renaming WebM files to .mp4",
  },
  record_replay_script_guidance: {
    use_when:
      "Local app recording needs a repeatable full-stack run with emulators, app startup, a Replay Playwright config, upload metadata, and side-by-side MP4 proof.",
    upload_rule:
      "Poll replayio list --json and upload only recordings with recordingStatus == finished; never upload IDs that are still recording.",
    jq:
      "Use jq to filter replayio list --json by date, title, URI, recordingStatus, and uploadStatus; install jq first if missing.",
    stitch:
      "Use plugin root scripts/stitch-videos.js --output recordings/<room>.mp4 <left-video> <right-video> to create a verified side-by-side MP4.",
  },
  emulation_guidance: {
    recommend_when: [
      "login/session flow depends on a missing backend",
      "database/API/email/payment/OAuth services are absent in the local run",
      "static prototype has a login form but no logged-in route",
    ],
    required_action: "Elicit whether the user wants as-is local behavior or emulation before recording backend-dependent flows.",
    memory: "Only create a memory note for the chosen mode when the user explicitly asks to remember it.",
  },
};

process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
