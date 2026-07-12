import { readFileSync, writeFileSync } from "node:fs";
import { StreamReader } from "../dist/src/index.js";

const [baseUrl, streamId, mode, phase, checkpointPath, outputPath, readyPath] = process.argv.slice(2);
if (!baseUrl || !streamId || !mode || !phase || !checkpointPath || !outputPath) {
  throw new Error(
    "usage: tail-worker.mjs <base> <stream> <mode> <phase> <checkpoint> <output> [ready]",
  );
}
if (phase === "prefix-late" && !readyPath) throw new Error("prefix-late requires a ready path");

const from = phase === "prefix" || phase === "prefix-late"
  ? "-1"
  : JSON.parse(readFileSync(checkpointPath, "utf8")).offset;
const reader = new StreamReader({ baseUrl, streamId, reconnectDelayMs: 1 });
const tail = reader.tail(from, { mode });
const result = await tail.next();
if (result.done || result.value === undefined) throw new Error("tail ended before a batch arrived");

let received = result.value.events;
let savedCheckpoint = result.value.checkpoint;
if (phase === "prefix-late") {
  writeFileSync(readyPath, "ready\n");
  const second = await tail.next();
  if (second.done || second.value === undefined) throw new Error("tail ended before the later batch");
  received = [...received, ...second.value.events];
  savedCheckpoint = second.value.checkpoint;
}
writeFileSync(outputPath, JSON.stringify(received));
if (phase === "prefix" || phase === "prefix-late") {
  writeFileSync(checkpointPath, JSON.stringify(savedCheckpoint));
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}

process.exit(0);
