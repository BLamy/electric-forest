import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = import.meta.dirname;
const beforePath = "../hosted-before/witness-reconnected.jsonl";
const afterPath = "../hosted-after/witness-reconnected.jsonl";
const before = await readFile(resolve(directory, beforePath), "utf8");
const after = await readFile(resolve(directory, afterPath), "utf8");
assert.ok(before.endsWith("\n") && after.endsWith("\n"));
const beforeLines = before.trimEnd().split("\n");
const afterLines = after.trimEnd().split("\n");
const preservedPrefix = `${afterLines.slice(0, beforeLines.length).join("\n")}\n`;
assert.equal(preservedPrefix, before, "restart lost or changed an accepted event");
assert.equal(afterLines.length, beforeLines.length + 2, "unexpected append count");
const afterEvents = afterLines.map((line) => JSON.parse(line));
assert.equal(afterEvents.filter((event) => event.payload.id === "preview-welcome").length, 1);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const report = {
  before: { path: beforePath, eventCount: beforeLines.length, sha256: digest(before) },
  after: { path: afterPath, eventCount: afterLines.length, sha256: digest(after) },
  preservedPrefixSha256: digest(preservedPrefix),
  prefixByteIdentical: true,
  welcomeSeedCount: 1,
  additionalAcceptedEvents: 2,
};
await writeFile(resolve(directory, "persistence.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
