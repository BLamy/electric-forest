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

function run(command, args) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
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

function requireFfmpeg() {
  const result = run("ffmpeg", ["-version"]);
  if (!result.ok) {
    throw new Error(
      [
        "ffmpeg is required to stitch side-by-side MP4 recordings.",
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
      ].join("\n"),
    );
  }
}

function getMime(filePath) {
  const result = run("file", ["-b", "--mime-type", filePath]);
  return result.ok ? result.stdout.trim() : "";
}

function parseSize(value) {
  const match = String(value || "").match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`Expected size as WIDTHxHEIGHT, got ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(args.output || args.o || "");
const inputs = args._.map((input) => path.resolve(input));
if (!output || path.extname(output).toLowerCase() !== ".mp4") {
  throw new Error("Provide --output /absolute/or/relative/path.mp4.");
}
if (inputs.length !== 2) {
  throw new Error("Provide exactly two source video paths.");
}
for (const input of inputs) {
  if (!fs.existsSync(input)) throw new Error(`Source video does not exist: ${input}`);
}

const { width, height } = parseSize(args.size || "1280x720");
requireFfmpeg();
fs.mkdirSync(path.dirname(output), { recursive: true });

const filter = [
  `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[left]`,
  `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[right]`,
  "[left][right]hstack=inputs=2[v]",
].join(";");

const result = run("ffmpeg", [
  "-y",
  "-i",
  inputs[0],
  "-i",
  inputs[1],
  "-filter_complex",
  filter,
  "-map",
  "[v]",
  "-an",
  "-c:v",
  "libx264",
  "-crf",
  String(args.crf || 23),
  "-preset",
  String(args.preset || "veryfast"),
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  output,
]);
if (!result.ok) {
  throw new Error(`ffmpeg failed while stitching videos:\n${result.stderr}`);
}

const stats = fs.statSync(output);
if (stats.size <= 0) throw new Error(`MP4 file is empty: ${output}`);
const mime = getMime(output);
if (!/mp4|quicktime/i.test(mime)) {
  throw new Error(`The output is ${mime || "unknown MIME"}, not MP4: ${output}`);
}

process.stdout.write(`${JSON.stringify({
  output,
  bytes: stats.size,
  mime: mime || undefined,
  inputs,
  layout: "side-by-side",
  width: width * 2,
  height,
  encoder: "ffmpeg",
}, null, 2)}\n`);
