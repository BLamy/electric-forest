#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTrustedReplayEnvironment,
  resolvePinnedReplayCli,
} from "./e3_t02_replay_cli_contract.mjs";

function fail(message) {
  process.stderr.write(`E3-T02 trusted uploader: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("arguments must be pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args["recording-directory"]) fail("recording directory and ID are required");
const recordingDirectory = resolve(args["recording-directory"]);
const recordingId = args["recording-id"];
const pinned = resolvePinnedReplayCli(args["project-root"]);
if (
  !recordingDirectory ||
  !recordingId ||
  resolve(args["replay-cli-shim"] ?? "") !== pinned.shimRealPath ||
  resolve(args["replay-cli-bin"] ?? "") !== pinned.binPath
) {
  fail("recording directory, ID, and pinned Replay CLI shim and entrypoint are required");
}

let request;
try {
  request = JSON.parse(readFileSync(0, "utf8"));
} catch {
  fail("signed publication request is not JSON");
}
if (
  request?.v !== 1 ||
  request.recordingId !== recordingId ||
  !/^[0-9a-f]{64}$/i.test(request.secret) ||
  !Number.isInteger(request.logPrefixBytes) ||
  request.logPrefixBytes <= 0
) {
  fail("signed publication request is invalid");
}

const logPath = resolve(recordingDirectory, "recordings.log");
const upload = spawnSync(process.execPath, [pinned.binPath, "upload", recordingId], {
  cwd: process.cwd(),
  env: buildTrustedReplayEnvironment(process.env, recordingDirectory),
  encoding: "utf8",
});

if (upload.status !== 0 || /\(failed\)|Upload failed/i.test(upload.stdout ?? "")) {
  fail(`Replay upload failed: ${(upload.stderr || upload.stdout || "unknown failure").trim()}`);
}

const log = readFileSync(logPath);
if (log.byteLength < request.logPrefixBytes) fail("process log was truncated");
const suffix = log.subarray(request.logPrefixBytes);
const suffixSha256 = createHash("sha256").update(suffix).digest("hex");
const manifestSha256 = createHash("sha256").update(JSON.stringify(request.manifest)).digest("hex");
const payload = JSON.stringify({
  v: 1,
  recordingId,
  suffixSha256,
  manifestSha256,
});
const signature = createHmac("sha256", Buffer.from(request.secret, "hex"))
  .update(payload)
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({ ...JSON.parse(payload), signature, uploaderStdout: upload.stdout.trim() })}\n`,
);
