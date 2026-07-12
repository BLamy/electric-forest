import { readFileSync, writeFileSync } from "node:fs";
import { StreamReader } from "../dist/src/index.js";

const [baseUrl, streamId, mode, phase, checkpointPath, outputPath] = process.argv.slice(2);
if (!baseUrl || !streamId || !mode || !phase || !checkpointPath || !outputPath) {
  throw new Error("usage: tail-worker.mjs <base> <stream> <mode> <phase> <checkpoint> <output>");
}

const from = phase === "prefix" ? "-1" : JSON.parse(readFileSync(checkpointPath, "utf8")).offset;
const reader = new StreamReader({ baseUrl, streamId, reconnectDelayMs: 1 });
const tail = reader.tail(from, { mode });
const result = await tail.next();
if (result.done || result.value === undefined) throw new Error("tail ended before a batch arrived");

writeFileSync(outputPath, JSON.stringify(result.value.events));
if (phase === "prefix") {
  writeFileSync(checkpointPath, JSON.stringify(result.value.checkpoint));
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}

process.exit(0);
