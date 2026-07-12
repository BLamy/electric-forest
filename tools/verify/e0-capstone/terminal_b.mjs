import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson, replay, stateDigest, OFFSET_BEFORE_FIRST } from "../../../packages/protocol/dist/src/index.js";
import { fixtureInitialState, fixtureReducer } from "../../../packages/protocol/dist/fixtures/reducer.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = arg("base-url");
const streamId = arg("stream");
const expected = Number(arg("expected", "0"));
const checkpointPath = arg("checkpoint");
const outputPath = arg("output");
const prefixPath = arg("prefix");
if (!baseUrl || !streamId || !checkpointPath || !outputPath || !Number.isSafeInteger(expected) || expected < 1) {
  throw new Error("terminal_b requires --base-url, --stream, --expected, --checkpoint, and --output");
}

const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8"))
  : { offset: OFFSET_BEFORE_FIRST };
if (typeof checkpoint.offset !== "string") throw new Error("checkpoint has no offset");
process.stdout.write(`B PID: ${process.pid}\n`);
process.stdout.write(`B start offset: ${checkpoint.offset}\n`);
writeFileSync(outputPath, "", { flag: "a" });
const path = `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
const readerModule = await import("../../../packages/client/dist/src/index.js");
const reader = new readerModule.StreamReader({ baseUrl, streamId, reconnectDelayMs: 5 });
let received = 0;
let offset = checkpoint.offset;
for await (const batch of reader.tail(offset, { mode: "long-poll" })) {
  appendFileSync(outputPath, batch.events.map((event) => `${canonicalJson(event)}\n`).join(""));
  const nextCheckpoint = { offset: batch.checkpoint.offset };
  const checkpointTmp = `${checkpointPath}.tmp-${process.pid}`;
  writeFileSync(checkpointTmp, `${canonicalJson(nextCheckpoint)}\n`);
  renameSync(checkpointTmp, checkpointPath);
  received += batch.events.length;
  offset = batch.checkpoint.offset;
  const priorEvents = prefixPath && prefixPath !== outputPath && existsSync(prefixPath)
    ? readFileSync(prefixPath, "utf8").trimEnd().split("\n").filter(Boolean).length
    : 0;
  if (received + priorEvents >= expected) break;
}

const readRecords = (pathValue) => {
  if (!pathValue || !existsSync(pathValue)) return [];
  const body = readFileSync(pathValue, "utf8").trimEnd();
  return body.length === 0 ? [] : body.split("\n").map((line) => JSON.parse(line));
};
const priorRecords = prefixPath && prefixPath !== outputPath ? readRecords(prefixPath) : [];
const records = [...priorRecords, ...readRecords(outputPath)];
if (records.length !== expected) throw new Error(`terminal_b received ${records.length} events, expected ${expected}`);
const events = records.map(({ offset: _offset, ...event }) => event);
const digest = stateDigest(replay(events, fixtureReducer, fixtureInitialState));
process.stdout.write(`B events: ${records.length}\n`);
process.stdout.write(`B digest: ${digest}\n`);
