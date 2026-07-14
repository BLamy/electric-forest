#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { replay, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { fixtureInitialState, fixtureReducer } from "../../packages/protocol/dist/fixtures/reducer.js";

const baseUrl = process.env.EFOREST_SERVER_URL;
if (!baseUrl) throw new Error("EFOREST_SERVER_URL is required");
const transcriptPath =
  process.env.EFOREST_TRANSCRIPT_PATH ??
  ".eforest/tasks/epic-0-the-seed/E0-T05-stream-server-core/evidence/curl-transcript.md";
const markdown = readFileSync(transcriptPath, "utf8");
const match = markdown.match(/```json\n([\s\S]*?)\n```/);
if (!match) throw new Error("curl transcript is missing its JSON request/response fixture");
const requests = JSON.parse(match[1]);
if (!Array.isArray(requests) || requests.length === 0) throw new Error("curl transcript is empty");

function fail(name, message) {
  throw new Error(`transcript request ${name} diverged: ${message}`);
}

const clientEvents = [];
let serverDump = "";
for (const entry of requests) {
  const body = entry.request.body === undefined
    ? undefined
    : typeof entry.request.body === "string"
      ? entry.request.body
      : JSON.stringify(entry.request.body);
  const response = await fetch(`${baseUrl}${entry.request.path}`, {
    method: entry.request.method,
    headers: entry.request.headers,
    body,
  });
  const actualBody = await response.text();
  if (response.status !== entry.expect.status) fail(entry.name, `status ${response.status} != ${entry.expect.status}`);
  for (const [key, expected] of Object.entries(entry.expect.headers ?? {})) {
    const actual = response.headers.get(key);
    if (actual !== expected) fail(entry.name, `header ${key} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  if (actualBody !== (entry.expect.body ?? "")) {
    fail(entry.name, `body ${JSON.stringify(actualBody)} != ${JSON.stringify(entry.expect.body ?? "")}`);
  }
  if (entry.request.method === "POST" && response.status >= 200 && response.status < 300) {
    const bodyValue = entry.request.body;
    const events = Array.isArray(bodyValue) ? bodyValue : bodyValue?.events;
    if (Array.isArray(events)) clientEvents.push(...events);
  }
  if (entry.name === "dump") serverDump = actualBody;
  console.log(`transcript request=${entry.name} status=${response.status} headers/body OK`);
}

if (serverDump.length === 0) fail("dump", "transcript did not capture a non-empty server dump");
const temp = mkdtempSync(join(tmpdir(), "eforest-transcript-"));
const dumpPath = join(temp, "dump.jsonl");
writeFileSync(dumpPath, serverDump);
const replayResult = spawnSync(process.execPath, ["packages/cli/dist/src/bin.js", "replay", dumpPath, "--digest"], {
  encoding: "utf8",
});
const clientDigest = stateDigest(replay(clientEvents, fixtureReducer, fixtureInitialState));
if (replayResult.status !== 0 || replayResult.stdout.trim() !== clientDigest) {
  rmSync(temp, { recursive: true, force: true });
  fail("dump", `server replay digest ${JSON.stringify(replayResult.stdout)} != client digest ${clientDigest}`);
}
rmSync(temp, { recursive: true, force: true });
console.log(`transcript transport digest=${clientDigest} server/client OK`);
