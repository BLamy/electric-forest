#!/usr/bin/env node
// Fresh-process rebuild of the E6-T04 queue projection from a source dump: reads a JSONL
// file of `{stream, records}` lines (one per source stream, any order), optionally
// permutes the task sources with a seed, projects the queue, and prints
// `<queue digest> <sha256 of queue.json bytes> <sha256 of QUEUE.md bytes>` so several
// processes with different cwd/TZ/LANG/fetch order can be compared byte-for-byte. With
// `--out <dir>` it also writes queue.json, QUEUE.md, queue.digest, and proof.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { canonicalJson } = await import(join(root, "packages/protocol/dist/src/index.js"));
const { permuteSources, projectQueue, queueDigest, queueProof, renderQueueMarkdown } = await import(
  join(root, "packages/tasks/dist/src/index.js")
);

const args = process.argv.slice(2);
const path = args.shift();
let seed;
let out;
while (args.length > 0) {
  const flag = args.shift();
  if (flag === "--shuffle") seed = Number(args.shift());
  else if (flag === "--out") out = args.shift();
  else {
    console.error(`unknown argument ${flag}`);
    process.exit(2);
  }
}
if (path === undefined) {
  console.error("usage: e6_t04_queue.mjs <sources.jsonl> [--shuffle <seed>] [--out <dir>]");
  process.exit(2);
}
const lines = readFileSync(path, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));
const catalog = lines.find((line) => line.stream.startsWith("repo-issues:"));
const tasks = lines.filter((line) => !line.stream.startsWith("repo-issues:"));
let sources = { catalog, tasks };
if (seed !== undefined) sources = permuteSources(sources, seed);
const projection = projectQueue(sources);
const json = `${canonicalJson(projection)}\n`;
const markdown = renderQueueMarkdown(projection);
const digest = queueDigest(projection);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
if (out !== undefined) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "queue.json"), json);
  writeFileSync(join(out, "QUEUE.md"), markdown);
  writeFileSync(join(out, "queue.digest"), `${digest}\n`);
  writeFileSync(join(out, "proof.json"), `${canonicalJson(queueProof(projection))}\n`);
}
console.log(`${digest} ${sha256(json)} ${sha256(markdown)}`);
