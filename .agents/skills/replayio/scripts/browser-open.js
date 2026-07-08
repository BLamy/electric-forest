#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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

function runPlaywright(args, extraEnv = {}) {
  childProcess.execFileSync(
    "npx",
    ["--yes", "--package", "@playwright/cli", "playwright-cli", ...args],
    {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    }
  );
}

function defaultReplayChromiumPath() {
  return path.join(
    os.homedir(),
    ".replay",
    "runtimes",
    "Replay-Chromium.app",
    "Contents",
    "MacOS",
    "Chromium"
  );
}

function defaultVideoPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(process.cwd(), "tmp", "recordings", "replayio", stamp, "browser-run.mp4");
}

function defaultWebmPath(output) {
  const parsed = path.parse(output);
  return path.join(parsed.dir, `${parsed.name}.capture.webm`);
}

function defaultSessionName() {
  return `replayio-${Date.now()}`;
}

function safeSessionName(sessionName) {
  return String(sessionName).replace(/[^a-zA-Z0-9_.-]+/g, "_") || "default";
}

function sessionStatePath(sessionName) {
  return path.join(process.cwd(), ".replay", `browser-session-${safeSessionName(sessionName)}.json`);
}

const args = parseArgs(process.argv.slice(2));
const url = args.url || args._[0];
if (!url) {
  throw new Error("Provide a URL as the first argument or with --url.");
}

const output = path.resolve(args.output || args.videoPath || process.env.REPLAYIO_MP4_PATH || defaultVideoPath());
if (path.extname(output).toLowerCase() !== ".mp4") {
  throw new Error(`MP4 output path must end in .mp4, got ${output}`);
}
const webmPath = path.resolve(args.webmPath || process.env.REPLAYIO_WEBM_PATH || defaultWebmPath(output));
if (path.extname(webmPath).toLowerCase() !== ".webm") {
  throw new Error(`WebM capture path must end in .webm, got ${webmPath}`);
}
const sessionName = String(args.session || process.env.REPLAYIO_PLAYWRIGHT_SESSION || defaultSessionName());
const sessionArg = `-s=${sessionName}`;

const statePath = path.join(process.cwd(), ".replay", "browser-session.json");
const perSessionStatePath = sessionStatePath(sessionName);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(path.dirname(webmPath), { recursive: true });
fs.mkdirSync(path.dirname(statePath), { recursive: true });

const replayChromium = process.env.AGENT_BROWSER_EXECUTABLE_PATH || defaultReplayChromiumPath();
const env = {
  AGENT_BROWSER_EXECUTABLE_PATH: replayChromium,
  RECORD_ALL_CONTENT: process.env.RECORD_ALL_CONTENT || "1",
  RECORD_REPLAY_VERBOSE: process.env.RECORD_REPLAY_VERBOSE || "1",
};

runPlaywright([sessionArg, "open", url], env);
runPlaywright([sessionArg, "video-start", webmPath, "--size", args.size || "1280x720"], env);
runPlaywright(
  [
    sessionArg,
    "video-show-actions",
    "--duration",
    String(args.actionDuration || 750),
    "--position",
    args.position || "top-right",
  ],
  env
);

const state = {
  url,
  video_path: output,
  mp4_path: output,
  webm_path: webmPath,
  capture_format: "webm",
  encoder: "ffmpeg",
  playwright_session: sessionName,
  playwright_command_prefix: `npx --yes --package @playwright/cli playwright-cli -s=${JSON.stringify(sessionName).slice(1, -1)}`,
  started_at: new Date().toISOString(),
  replay_chromium_path: replayChromium,
};
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
fs.writeFileSync(perSessionStatePath, `${JSON.stringify(state, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...state, state_path: statePath, session_state_path: perSessionStatePath }, null, 2)}\n`);
