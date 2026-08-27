import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const task = readFileSync(
  resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T12-negotiation-replay-harness/readme.md"),
  "utf8",
);
const cli = readFileSync(resolve(root, "packages/cli/README.md"), "utf8");
const names = ["session-manifest", "composite-digest"];

function frozenBlock(source, name, label) {
  const open = `<!-- frozen:E5-T12:${name} -->`;
  const close = `<!-- /frozen:E5-T12:${name} -->`;
  const first = source.indexOf(open);
  const last = source.lastIndexOf(open);
  if (first < 0 || first !== last) throw new Error(`${label}: expected exactly one ${open}`);
  const end = source.indexOf(close, first + open.length);
  if (end < 0 || source.indexOf(close, end + close.length) >= 0) {
    throw new Error(`${label}: expected exactly one ${close}`);
  }
  return source.slice(first, end + close.length);
}

for (const name of names) {
  const expected = frozenBlock(task, name, "task readme");
  const actual = frozenBlock(cli, name, "CLI readme");
  if (actual !== expected) throw new Error(`DOC-SYNC E5-T12 ${name} drifted`);
}

process.stdout.write("DOC-SYNC E5-T12 frozen-blocks=2 OK\n");
