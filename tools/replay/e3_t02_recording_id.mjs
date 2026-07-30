#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function list() {
  const result = spawnSync("replayio", ["list", "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "replayio list failed");
  const start = result.stdout.indexOf("[");
  if (start < 0) throw new Error("replayio list returned no JSON array");
  return JSON.parse(result.stdout.slice(start));
}

const [mode, path] = process.argv.slice(2);
if (mode === "--snapshot" && path) {
  writeFileSync(path, `${JSON.stringify(list().map((entry) => entry.id))}\n`);
} else if (mode === "--new" && path) {
  const before = new Set(JSON.parse(readFileSync(path, "utf8")));
  const deadline = Date.now() + 15_000;
  let candidates;
  do {
    candidates = list().filter(
      (entry) =>
        !before.has(entry.id) &&
        (entry.recordingStatus === "recording" || entry.recordingStatus === "finished"),
    );
    if (candidates.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (candidates.length !== 1) {
    throw new Error(`expected one new Replay recording, observed ${String(candidates.length)}`);
  }
  process.stdout.write(`${candidates[0].id}\n`);
} else {
  throw new Error("usage: e3_t02_recording_id.mjs --snapshot PATH | --new PATH");
}
