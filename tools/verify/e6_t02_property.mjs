#!/usr/bin/env node
// Fresh-process run of the frozen E6-T02 property corpus: one line per generated folder
// (seed, durable digest, evidence-manifest SHA-256, rendered readme SHA-256), each seed
// parsed -> rendered -> reparsed -> rerendered with every step held byte-identical.
// verify-E6-T02 runs this twice in separate processes and compares the outputs exactly.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/protocol/dist/src/index.js";
import {
  evidenceManifest,
  generateTaskFolder,
  parseTaskFolder,
  renderTaskFolder,
  snapshotOfRendered,
  taskFolderDigest,
  taskFolderValue,
} from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = readFileSync(
  join(
    root,
    ".eforest/tasks/epic-6-the-loop/E6-T02-task-folder-contract/evidence/e6-t02-property.txt",
  ),
  "utf8",
);
const value = (key) =>
  corpus
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    .slice(key.length + 1);
const seedStart = Number.parseInt(value("seed-start"), 16);
const cases = Number(value("cases"));

const parseOk = (snapshot) => {
  const result = parseTaskFolder(snapshot);
  if (!result.ok) throw new Error(`${snapshot.folderName}: ${JSON.stringify(result.refusal)}`);
  return result.folder;
};
const same = (a, b) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
const lines = [];
for (let index = 0; index < cases; index += 1) {
  const seed = seedStart + index;
  const first = parseOk(generateTaskFolder(seed));
  const once = renderTaskFolder(first);
  const second = parseOk(snapshotOfRendered(once));
  const twice = renderTaskFolder(second);
  if (once.files.length !== twice.files.length) throw new Error(`${seed}: render drift`);
  for (const [at, file] of once.files.entries()) {
    if (twice.files[at].path !== file.path || !same(twice.files[at].bytes, file.bytes))
      throw new Error(`${seed}: render drift at ${file.path}`);
  }
  const third = parseOk(snapshotOfRendered(twice));
  if (canonicalJson(taskFolderValue(third)) !== canonicalJson(taskFolderValue(second)))
    throw new Error(`${seed}: canonical value drift`);
  if (taskFolderDigest(second) !== taskFolderDigest(first))
    throw new Error(`${seed}: digest drift`);
  const readme = once.files.find((file) => file.path === "readme.md");
  lines.push(
    `${seed.toString(16)} ${taskFolderDigest(first)} ${sha256Hex(new TextEncoder().encode(canonicalJson(evidenceManifest(first))))} ${sha256Hex(readme.bytes)}`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
