import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const taskRoot = join(repoRoot, ".eforest/tasks/epic-1-the-trunk/E1-T02-directory-ops");
const goldenPath = join(taskRoot, "evidence/golden-dirs.jsonl");
const digestPath = join(taskRoot, "evidence/golden-dirs.digest");
const listingPath = join(taskRoot, "evidence/golden-dirs.listing");
const expectedRenamePath = join(taskRoot, "evidence/rename-expected-tree.json");
const cliPath = join(repoRoot, "packages/cli/dist/src/bin.js");
const reducerPath = join(repoRoot, "packages/streamfs/reducer.mjs");
const listReplayPath = join(repoRoot, "tools/verify/streamfs_list_replay.mjs");
const expectedDigest = readFileSync(digestPath, "utf8").trim();
const expectedListing = readFileSync(listingPath, "utf8").trimEnd();
const original = readFileSync(goldenPath);
const records = original
  .toString("utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));

function replayDigest(path) {
  return spawnSync(process.execPath, [cliPath, "replay", path, "--digest", "--reducer", reducerPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function assertDigest(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`);
  const digest = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(digest) || digest !== expectedDigest) {
    throw new Error(`${label} digest ${digest} != ${expectedDigest}`);
  }
  return digest;
}

const digest1 = assertDigest(replayDigest(goldenPath), "golden replay 1");
const digest2 = assertDigest(replayDigest(goldenPath), "golden replay 2");
if (digest1 !== digest2) throw new Error("golden replay processes disagree");
console.log(`golden-dirs replay run1=${digest1} run2=${digest2} expected=${expectedDigest} OK`);

function listing(env = {}) {
  const result = spawnSync(process.execPath, [listReplayPath, goldenPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`list replay failed: ${result.stderr}`);
  return result.stdout.trimEnd();
}

const listing1 = listing();
const listing2 = listing();
const listingEnv = listing({ TZ: "Pacific/Kiritimati", LANG: "C" });
if (listing1 !== expectedListing || listing2 !== expectedListing || listingEnv !== expectedListing) {
  throw new Error("listTree output is not byte-identical to the committed listing under all runs");
}
console.log("golden-dirs listing: two fresh processes and TZ/LANG variant match committed listing OK");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentOf(path) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
}

function hasParent(state, path) {
  const parent = parentOf(path);
  return parent === undefined || state.dirs[parent] !== undefined;
}

function hasLive(state, path) {
  return state.files[path] !== undefined || state.dirs[path] !== undefined;
}

function move(entries, from, to) {
  const result = {};
  for (const [path, value] of Object.entries(entries)) {
    if (path === from) result[to] = clone(value);
    else if (path.startsWith(`${from}/`)) result[`${to}${path.slice(from.length)}`] = clone(value);
    else result[path] = clone(value);
  }
  return result;
}

function independentFold(slice) {
  const state = { files: {}, dirs: {}, tombstones: {} };
  for (const [index, record] of slice.entries()) {
    const payload = record.payload;
    if (record.type === "fs.dir.create") {
      if (hasLive(state, payload.path) || !hasParent(state, payload.path)) throw new Error(`dir create line ${index + 1}`);
      state.dirs[payload.path] = {};
      delete state.tombstones[payload.path];
    } else if (record.type === "fs.dir.remove") {
      const prefix = `${payload.path}/`;
      if (state.dirs[payload.path] === undefined || [...Object.keys(state.files), ...Object.keys(state.dirs)].some((path) => path.startsWith(prefix))) {
        throw new Error(`dir remove line ${index + 1}`);
      }
      delete state.dirs[payload.path];
    } else if (record.type === "fs.file.create") {
      if (hasLive(state, payload.path) || !hasParent(state, payload.path)) throw new Error(`file create line ${index + 1}`);
      state.files[payload.path] = { contentStreamId: payload.contentStreamId, contentSha256: "0".repeat(64), size: 0 };
      delete state.tombstones[payload.path];
    } else if (record.type === "fs.file.write") {
      if (state.files[payload.path] === undefined) throw new Error(`file write line ${index + 1}`);
      state.files[payload.path] = { ...state.files[payload.path], contentSha256: payload.contentSha256, size: payload.size };
    } else if (record.type === "fs.file.delete") {
      if (state.files[payload.path] === undefined) throw new Error(`file delete line ${index + 1}`);
      state.tombstones[payload.path] = { contentStreamId: state.files[payload.path].contentStreamId };
      delete state.files[payload.path];
    } else if (record.type === "fs.rename") {
      const sourceFile = state.files[payload.from] !== undefined;
      const sourceDir = state.dirs[payload.from] !== undefined;
      if ((!sourceFile && !sourceDir) || hasLive(state, payload.to) || !hasParent(state, payload.to)) throw new Error(`rename line ${index + 1}`);
      if (sourceDir && payload.to.startsWith(`${payload.from}/`)) throw new Error(`self rename line ${index + 1}`);
      state.files = move(state.files, payload.from, payload.to);
      state.dirs = move(state.dirs, payload.from, payload.to);
      delete state.tombstones[payload.to];
    } else {
      throw new Error(`unknown event line ${index + 1}`);
    }
  }
  return state;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

const renameIndex = records.findIndex((record) => record.type === "fs.rename" && record.payload.from === "src");
if (renameIndex < 0) throw new Error("golden is missing the deep rename");
const beforeRename = independentFold(records.slice(0, renameIndex));
const afterRename = independentFold(records.slice(0, renameIndex + 1));
const expectedRename = JSON.parse(readFileSync(expectedRenamePath, "utf8"));
if (JSON.stringify(normalize(afterRename)) !== JSON.stringify(normalize(expectedRename))) {
  throw new Error("hand-frozen rename expected tree disagrees with independent fold");
}
const changed = new Set([
  ...Object.keys(beforeRename.files),
  ...Object.keys(afterRename.files),
  ...Object.keys(beforeRename.dirs),
  ...Object.keys(afterRename.dirs),
].filter((path) => JSON.stringify(beforeRename.files[path] ?? beforeRename.dirs[path]) !== JSON.stringify(afterRename.files[path] ?? afterRename.dirs[path])));
const expectedChanged = new Set([
  "src/level/deep/é.txt", "moved/level/deep/é.txt",
  "src/level/deep/a!", "moved/level/deep/a!",
  "src/level/other.txt", "moved/level/other.txt",
  "src/level/deep", "moved/level/deep",
  "src/level", "moved/level",
  "src", "moved",
]);
if (JSON.stringify([...changed].sort()) !== JSON.stringify([...expectedChanged].sort())) {
  throw new Error(`deep rename changed keys ${JSON.stringify([...changed].sort())}`);
}
if (JSON.stringify(beforeRename.tombstones) !== JSON.stringify(afterRename.tombstones)) {
  throw new Error("deep rename changed tombstones");
}
for (const [oldPath, newPath] of [
  ["src/level/deep/é.txt", "moved/level/deep/é.txt"],
  ["src/level/deep/a!", "moved/level/deep/a!"],
  ["src/level/other.txt", "moved/level/other.txt"],
]) {
  if (JSON.stringify(beforeRename.files[oldPath]) !== JSON.stringify(afterRename.files[newPath])) {
    throw new Error(`rename mutated file identity ${oldPath}`);
  }
}
const tombstoneRenameIndex = records.findIndex((record) => record.type === "fs.rename" && record.payload.to === "target.txt");
const beforeTombstoneRename = independentFold(records.slice(0, tombstoneRenameIndex));
const afterTombstoneRename = independentFold(records.slice(0, tombstoneRenameIndex + 1));
if (afterTombstoneRename.tombstones["target.txt"] !== undefined || afterTombstoneRename.files["target.txt"]?.contentStreamId !== "fs:golden:file:c8") {
  throw new Error("rename onto tombstone did not preserve the moved identity and clear the tombstone");
}
if (beforeTombstoneRename.tombstones["target.txt"]?.contentStreamId !== "fs:golden:file:c7") {
  throw new Error("golden tombstone-destination precondition was not present");
}
console.log("golden-dirs independent rename surgery: hand-frozen state, exact changed keys, identities, and tombstones OK");

const temp = mkdtempSync(join(tmpdir(), "eforest-streamfs-dirs-"));
try {
  const mutation = Buffer.from(original);
  const marker = Buffer.from('"v":2');
  const position = mutation.indexOf(marker) + marker.length - 1;
  if (position < marker.length - 1) throw new Error("golden has no version payload to mutate");
  mutation[position] = 0x33;
  const mutationPath = join(temp, "mutation.jsonl");
  writeFileSync(mutationPath, mutation);
  const result = replayDigest(mutationPath);
  if (result.status === 0 && result.stdout.trim() === expectedDigest) throw new Error("state-reaching mutation preserved digest");
  console.log(`MUTATION fixture=golden-dirs byte=${position} digest-mismatch EXPECTED-FAIL OK`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const independentDigest = createHash("sha256").update(canonicalJson(independentFold(records))).digest("hex");
if (independentDigest !== expectedDigest || stateDigest(independentFold(records)) !== expectedDigest) {
  throw new Error(`independent golden digest ${independentDigest} != ${expectedDigest}`);
}
console.log(`streamfs dirs independent digest=${independentDigest} OK`);
