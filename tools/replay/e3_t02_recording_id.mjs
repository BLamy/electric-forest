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

function result(path) {
  const text = readFileSync(path, "utf8");
  const match = text.match(/(?:^|\n)### Result\s*\n(\{[^\n]*\})(?:\n|$)/);
  if (!match) throw new Error("walkthrough has no machine-readable result");
  return JSON.parse(match[1]);
}

function sameAuthorization(recording, authorizationUrl) {
  try {
    const actual = new URL(recording.metadata?.uri);
    const expected = new URL(authorizationUrl);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      ["state", "nonce", "code_challenge"].every(
        (key) => actual.searchParams.get(key) === expected.searchParams.get(key),
      )
    );
  } catch {
    return false;
  }
}

const [mode, path, walkthroughPath] = process.argv.slice(2);
if (mode === "--snapshot" && path) {
  writeFileSync(path, `${JSON.stringify(list().map((entry) => entry.id))}\n`);
} else if (mode === "--new" && path && walkthroughPath) {
  const before = new Set(JSON.parse(readFileSync(path, "utf8")));
  const authorizationUrl = result(walkthroughPath).authorizationUrl;
  if (typeof authorizationUrl !== "string") {
    throw new Error("walkthrough result has no authorization URL binding");
  }
  const deadline = Date.now() + 15_000;
  let candidates;
  do {
    candidates = list().filter(
      (entry) =>
        !before.has(entry.id) &&
        sameAuthorization(entry, authorizationUrl) &&
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
  throw new Error(
    "usage: e3_t02_recording_id.mjs --snapshot PATH | --new PATH WALKTHROUGH_TRANSCRIPT",
  );
}
