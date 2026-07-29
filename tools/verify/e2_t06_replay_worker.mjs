#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  composeNamespaceView,
  namespaceViewDigest,
  resolvePath,
} from "../../packages/platform/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = resolve(process.argv[2] ?? "");
assert.equal(process.argv.length, 3, "usage: node e2_t06_replay_worker.mjs <fixture-dir>");
assert.ok(
  relative(resolve(root, "packages/platform/fixtures/ns"), fixtureDirectory).split("/")[0] !== "..",
  "fixture must be under packages/platform/fixtures/ns",
);

const expectedPath = join(fixtureDirectory, "expected.json");
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
if (expected.schema !== undefined)
  assert.equal(expected.schema, 1, `${expectedPath}: unsupported schema`);
assert.equal(typeof expected.streams, "object", `${expectedPath}: streams must be an object`);
assert.ok(expected.streams !== null && !Array.isArray(expected.streams));
assert.equal(typeof expected.resolutions, "object", `${expectedPath}: resolutions required`);
assert.ok(expected.resolutions !== null && !Array.isArray(expected.resolutions));

const cli = resolve(root, "packages/cli/dist/src/bin.js");
const reducer = resolve(root, "packages/platform/ns-reducer.mjs");
assert.ok(Object.hasOwn(expected.streams, "ns:root"), `${expectedPath}: missing ns:root`);
const streamIds = [
  "ns:root",
  ...Object.keys(expected.streams)
    .filter((id) => id !== "ns:root")
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
];

function dumpPath(entry) {
  assert.equal(typeof entry.dump, "string", "stream dump must be a relative path");
  assert.equal(isAbsolute(entry.dump), false, "stream dump path must be relative");
  const path = resolve(fixtureDirectory, entry.dump);
  assert.ok(!relative(fixtureDirectory, path).startsWith(".."), "stream dump escapes fixture");
  return path;
}

function records(path) {
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"), `${path}: dump must end in newline`);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const digests = {};
const dumps = {};
for (const streamId of streamIds) {
  const entry = expected.streams[streamId];
  assert.ok(entry !== null && typeof entry === "object" && !Array.isArray(entry));
  assert.match(entry.digest, /^[0-9a-f]{64}$/, `${streamId}: invalid expected digest`);
  const path = dumpPath(entry);
  const child = spawnSync(
    process.execPath,
    [cli, "replay", path, "--digest", "--reducer", reducer],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  assert.equal(child.status, 0, `${streamId}: ${child.stdout}${child.stderr}`);
  assert.equal(child.stderr, "", `${streamId}: replay wrote stderr`);
  assert.match(child.stdout, /^[0-9a-f]{64}\n$/, `${streamId}: malformed replay digest`);
  const digest = child.stdout.trim();
  assert.equal(digest, entry.digest, `${streamId}: committed digest drifted`);
  digests[streamId] = digest;
  dumps[streamId] = records(path);
}

const orgDumps = Object.fromEntries(
  streamIds.filter((id) => id.startsWith("ns:org:")).map((id) => [id, dumps[id]]),
);
const view = composeNamespaceView(dumps["ns:root"], orgDumps);
const viewDigest = namespaceViewDigest(view);
assert.match(expected.viewDigest, /^[0-9a-f]{64}$/, `${expectedPath}: invalid view digest`);
assert.equal(viewDigest, expected.viewDigest, `${expectedPath}: namespace view digest drifted`);

const resolutions = Object.fromEntries(
  Object.keys(expected.resolutions)
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    .map((path) => [path, resolvePath(view, path)]),
);
assert.deepEqual(resolutions, expected.resolutions, `${expectedPath}: literal resolutions drifted`);

process.stdout.write(
  `${canonicalJson({
    fixture: relative(resolve(root, "packages/platform/fixtures/ns"), fixtureDirectory),
    pid: process.pid,
    resolutions,
    streamDigests: digests,
    streamOrder: streamIds,
    viewDigest,
  })}\n`,
);
