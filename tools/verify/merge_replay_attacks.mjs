import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = join(root, ".eforest/tasks/epic-1-the-trunk/E1-T09-fast-forward-merge/evidence");
const corpus = join(evidence, "replay-attacks");
const updateEvidence = process.argv.includes("--update-evidence");
const targetPath = join(evidence, "golden-merged-target.jsonl");
const sourcePath = join(evidence, "golden-source.jsonl");
const cli = join(root, "packages/cli/dist/src/bin.js");

function readDump(path) {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function dumpText(records) {
  return `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

function frozen(path, value) {
  if (updateEvidence) {
    writeFileSync(path, value, "utf8");
  } else if (!existsSync(path) || readFileSync(path, "utf8") !== value) {
    throw new Error(`frozen evidence mismatch: ${path}`);
  }
}

function runReplay(target, source) {
  const args = [cli, "replay", target, "--digest"];
  if (source !== undefined) args.push("--merge-source", source);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function assertRejected(name, target, source) {
  const result = runReplay(target, source);
  if (result.status === 0 || result.stdout !== "") {
    throw new Error(`${name} unexpectedly accepted or wrote stdout`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stderr);
  } catch {
    throw new Error(`${name} did not emit structured rejection JSON: ${result.stderr}`);
  }
  if (parsed?.error?.class !== "validator-rejected" || typeof parsed.error.reason !== "string") {
    throw new Error(`${name} emitted the wrong rejection shape: ${result.stderr}`);
  }
  return `${name}: status=${result.status} stdout-bytes=${Buffer.byteLength(result.stdout)} reason=${parsed.error.reason}`;
}

function makeFixtures() {
  const target = readDump(targetPath);
  const source = readDump(sourcePath);
  const mergeIndex = target.findIndex((record) => record.type === "fs.branch.merge");
  if (mergeIndex < 0) throw new Error("golden target has no merge event");
  const merge = target[mergeIndex];
  const fixture = (records) => dumpText(records);
  const malformed = [...target];
  malformed[mergeIndex] = {
    ...merge,
    payload: { ...merge.payload, extra: true },
  };
  const inverted = [...target];
  inverted[mergeIndex] = {
    ...merge,
    payload: {
      ...merge.payload,
      mergedThroughOffset: "0000000000000000_0000000000000001",
    },
  };
  const wrongSource = [...source];
  wrongSource[0] = {
    ...wrongSource[0],
    payload: { ...wrongSource[0].payload, forkOffset: "0000000000000000_0000000000000001" },
  };
  const afterAdvance = [
    ...target.slice(0, mergeIndex),
    {
      offset: "0000000000000000_0000000000000003",
      payload: { path: "post-fork", v: 2 },
      ts: 0,
      type: "fs.dir.create",
    },
    { ...merge, offset: "0000000000000000_0000000000000004" },
  ];
  const flipped = [...target];
  flipped[mergeIndex] = {
    ...merge,
    payload: {
      ...merge.payload,
      mergedThroughOffset: "0000000000000000_0000000000000003",
    },
  };
  return {
    malformed: fixture(malformed),
    inverted: fixture(inverted),
    wrongSource: fixture(wrongSource),
    truncatedSource: dumpText(source.slice(0, -1)),
    afterAdvance: fixture(afterAdvance),
    flipped: fixture(flipped),
  };
}

async function main() {
  mkdirSync(corpus, { recursive: true });
  const fixtures = makeFixtures();
  for (const [name, body] of Object.entries(fixtures)) frozen(join(corpus, `${name}.jsonl`), body);

  const cases = [
    ["malformed-payload", "malformed", sourcePath],
    ["inverted-range", "inverted", sourcePath],
    ["mismatched-source", "golden", join(corpus, "wrongSource.jsonl")],
    ["truncated-source", "golden", join(corpus, "truncatedSource.jsonl")],
    ["merge-after-advance", "afterAdvance", sourcePath],
    ["merge-without-source", "golden", undefined],
    ["one-byte-range-flip", "flipped", sourcePath],
  ];
  const lines = ["RUN node tools/verify/merge_replay_attacks.mjs --update-evidence"];
  for (const [name, fixtureName, source] of cases) {
    const actualTarget =
      fixtureName === "golden" ? targetPath : join(corpus, `${fixtureName}.jsonl`);
    lines.push(assertRejected(name, actualTarget, source));
  }
  frozen(join(evidence, "e1-t09-replay-attacks.txt"), `${lines.join("\n")}\n`);
  console.log(`merge-replay-attacks cases=${cases.length} all-rejected=true`);
}

await main();
