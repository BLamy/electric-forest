import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskRoot = join(repoRoot, ".eforest/tasks/epic-1-the-trunk/E1-T01-streamfs-core-tree-digest");
const goldenPath = join(taskRoot, "evidence/golden-fs.jsonl");
const expectedPath = join(taskRoot, "evidence/golden-fs.digest");
const cliPath = join(repoRoot, "packages/cli/dist/src/bin.js");
const reducerPath = join(repoRoot, "packages/streamfs/reducer.mjs");
const expected = readFileSync(expectedPath, "utf8").trim();
const protocol = await import(pathToFileURL(join(repoRoot, "packages/protocol/dist/src/index.js")).href);

function runReplay(path) {
  return spawnSync(process.execPath, [cliPath, "replay", path, "--digest", "--reducer", reducerPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function assertDigest(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`);
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1 || !/^[0-9a-f]{64}$/.test(lines[0])) {
    throw new Error(`${label} did not print exactly one lowercase digest: ${result.stdout}`);
  }
  if (lines[0] !== expected) throw new Error(`${label} digest ${lines[0]} != ${expected}`);
  return lines[0];
}

const run1 = assertDigest(runReplay(goldenPath), "golden run 1");
const run2 = assertDigest(runReplay(goldenPath), "golden run 2");
if (run1 !== run2) throw new Error("golden replay processes disagree");
console.log(`golden replay run1=${run1} run2=${run2} expected=${expected} OK`);

function payloadRanges(buffer) {
  const marker = Buffer.from('"payload":', "utf8");
  const terminator = Buffer.from(',"ts"', "utf8");
  const ranges = [];
  let lineStart = 0;
  while (lineStart < buffer.length) {
    let lineEnd = buffer.indexOf(0x0a, lineStart);
    if (lineEnd < 0) lineEnd = buffer.length;
    const line = buffer.subarray(lineStart, lineEnd);
    const payloadStart = line.indexOf(marker);
    const payloadEnd = line.indexOf(terminator);
    if (payloadStart < 0 || payloadEnd <= payloadStart) throw new Error("golden payload range is not canonical");
    const start = lineStart + payloadStart + marker.length;
    const end = lineStart + payloadEnd;
    for (let position = start; position < end; position += 1) ranges.push(position);
    lineStart = lineEnd + 1;
  }
  return ranges;
}

function independentFold(buffer) {
  const files = {};
  const dirs = {};
  const tombstones = {};
  const parentOf = (path) => {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? undefined : path.slice(0, separator);
  };
  const hasParent = (path) => {
    const parent = parentOf(path);
    return parent === undefined || dirs[parent] !== undefined;
  };
  const hasLive = (path) => files[path] !== undefined || dirs[path] !== undefined;
  const descendant = (path) => Object.keys({ ...files, ...dirs }).some((key) => key.startsWith(`${path}/`));
  const move = (entries, from, to) => {
    const result = {};
    for (const [path, value] of Object.entries(entries)) {
      if (path === from) result[to] = value;
      else if (path.startsWith(`${from}/`)) result[`${to}${path.slice(from.length)}`] = value;
      else result[path] = value;
    }
    return result;
  };
  const lines = buffer.toString("utf8").trimEnd().split("\n");
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line);
    const payload = record.payload;
    if (record.type === "fs.file.create") {
      if (hasLive(payload.path) || !hasParent(payload.path)) throw new Error(`invalid file create at ${index + 1}`);
      files[payload.path] = {
        contentStreamId: payload.contentStreamId,
        contentSha256: "0".repeat(64),
        size: 0,
      };
      delete tombstones[payload.path];
    } else if (record.type === "fs.file.write") {
      if (files[payload.path] === undefined) throw new Error(`write-missing at ${index + 1}`);
      files[payload.path] = {
        contentStreamId: files[payload.path].contentStreamId,
        contentSha256: payload.contentSha256,
        size: payload.size,
      };
    } else if (record.type === "fs.file.delete") {
      if (files[payload.path] === undefined) throw new Error(`delete-missing at ${index + 1}`);
      tombstones[payload.path] = { contentStreamId: files[payload.path].contentStreamId };
      delete files[payload.path];
    } else if (record.type === "fs.dir.create") {
      if (hasLive(payload.path) || !hasParent(payload.path)) throw new Error(`invalid dir create at ${index + 1}`);
      dirs[payload.path] = {};
      delete tombstones[payload.path];
    } else if (record.type === "fs.dir.remove") {
      if (dirs[payload.path] === undefined || descendant(payload.path)) throw new Error(`invalid dir remove at ${index + 1}`);
      delete dirs[payload.path];
    } else if (record.type === "fs.rename") {
      const sourceFile = files[payload.from] !== undefined;
      const sourceDir = dirs[payload.from] !== undefined;
      if ((!sourceFile && !sourceDir) || hasLive(payload.to) || !hasParent(payload.to)) {
        throw new Error(`invalid rename at ${index + 1}`);
      }
      if (sourceDir && payload.to.startsWith(`${payload.from}/`)) {
        throw new Error(`self rename at ${index + 1}`);
      }
      const movedFiles = move(files, payload.from, payload.to);
      const movedDirs = move(dirs, payload.from, payload.to);
      delete tombstones[payload.to];
      Object.assign(files, movedFiles);
      for (const key of Object.keys(files)) if (movedFiles[key] === undefined) delete files[key];
      Object.assign(dirs, movedDirs);
      for (const key of Object.keys(dirs)) if (movedDirs[key] === undefined) delete dirs[key];
    } else {
      throw new Error(`unknown event at ${index + 1}`);
    }
  }
  const sorted = {};
  for (const path of Object.keys(files).sort()) sorted[path] = files[path];
  const sortedDirs = {};
  for (const path of Object.keys(dirs).sort()) sortedDirs[path] = dirs[path];
  const sortedTombstones = {};
  for (const path of Object.keys(tombstones).sort()) sortedTombstones[path] = tombstones[path];
  return protocol.stateDigest({ files: sorted, dirs: sortedDirs, tombstones: sortedTombstones });
}

const original = readFileSync(goldenPath);
if (independentFold(original) !== expected) throw new Error("independent golden fold disagrees with committed digest");
const temp = mkdtempSync(join(tmpdir(), "eforest-streamfs-golden-"));
let checked = 0;
let parseFailures = 0;
let digestMismatches = 0;
let carveOuts = 0;
let printedMismatch = false;
try {
  for (const position of payloadRanges(original)) {
    checked += 1;
    const mutated = Buffer.from(original);
    mutated[position] = mutated[position] === 0x30 ? 0x31 : 0x30;
    const path = join(temp, `mutation-${checked}.jsonl`);
    writeFileSync(path, mutated);
    const result = runReplay(path);
    if (result.status !== 0) {
      parseFailures += 1;
      continue;
    }
    const digest = result.stdout.trim();
    if (digest !== expected) {
      digestMismatches += 1;
      if (!printedMismatch) {
        console.log(`MUTATION fixture=golden-fs byte=${position} digest-mismatch EXPECTED-FAIL OK`);
        printedMismatch = true;
      }
      continue;
    }
    let mutatedDigest;
    try {
      mutatedDigest = independentFold(mutated);
    } catch (error) {
      throw new Error(`green replay had no independently foldable tree at byte ${position}: ${error}`);
    }
    if (mutatedDigest !== expected) {
      throw new Error(`state-reaching mutation at byte ${position} preserved the golden digest`);
    }
    carveOuts += 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (!printedMismatch || checked === 0) throw new Error("golden sensitivity did not exercise a state-reaching mutation");
console.log(`streamfs sensitivity payloadBytes=${checked} parseFailures=${parseFailures} digestMismatches=${digestMismatches} carveOuts=${carveOuts} OK`);
