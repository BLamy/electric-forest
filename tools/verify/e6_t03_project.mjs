#!/usr/bin/env node
// Fresh-process replay of a project/v1 dump: prints `<state digest> <sha256 of the
// project.json projection bytes>` so two processes with different cwd/TZ/LANG can be
// compared byte-for-byte by e6_t03_evidence.mjs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { stateDigest } = await import(join(root, "packages/protocol/dist/src/index.js"));
const { replayProjectLog, projectProjectionBytes } = await import(
  join(root, "packages/platform/dist/src/index.js")
);

const [path, streamId] = process.argv.slice(2);
if (path === undefined || streamId === undefined) {
  console.error("usage: e6_t03_project.mjs <dump.jsonl> <project stream id>");
  process.exit(2);
}
const events = readFileSync(path, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));
const state = replayProjectLog(streamId, events);
const projection = projectProjectionBytes(state);
console.log(`${stateDigest(state)} ${createHash("sha256").update(projection).digest("hex")}`);
