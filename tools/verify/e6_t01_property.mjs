#!/usr/bin/env node
// Fresh-process replay of the frozen E6-T01 property corpus: one digest line per
// generated legal sequence. verify-E6-T01 runs this twice in separate processes.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDigest } from "../../packages/protocol/dist/src/index.js";
import { generateLegalTaskLog, replayTaskLog } from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = readFileSync(
  join(root, ".eforest/tasks/epic-6-the-loop/E6-T01-task-event-model/evidence/e6-t01-property.txt"),
  "utf8",
);
const value = (key) =>
  corpus
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    .slice(key.length + 1);
const seedStart = Number.parseInt(value("seed-start"), 16);
const cases = Number(value("cases"));
const lines = [];
for (let index = 0; index < cases; index += 1) {
  const generated = generateLegalTaskLog(seedStart + index);
  lines.push(stateDigest(replayTaskLog(generated.streamId, generated.events)));
}
process.stdout.write(`${lines.join("\n")}\n`);
