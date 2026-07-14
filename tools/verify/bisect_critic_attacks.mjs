import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, replay, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { fixtureInitialState, fixtureReducer } from "../../packages/protocol/dist/fixtures/reducer.js";

const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "packages/cli/dist/src/bin.js");
const temp = mkdtempSync(join(tmpdir(), "eforest-bisect-critic-"));
const evidence = join(
  repo,
  ".eforest/tasks/epic-0-the-seed/E0-T12-ef-bisect/evidence/e0-t12-critic-attacks.md",
);
const lines = [];

function record(index, event) {
  return { offset: String(index).padStart(6, "0"), ...event };
}

function baseLog(length = 24) {
  return Array.from({ length }, (_, index) => {
    const number = index + 1;
    if (number === 1) return record(number, { type: "set", payload: 0, ts: number });
    if (number === length) return record(number, { type: "push", payload: `value-${number}`, ts: number });
    return record(number, { type: "increment", payload: 1, ts: number });
  });
}

function writeLog(name, records) {
  const path = join(temp, name);
  writeFileSync(path, records.map((entry) => `${canonicalJson(entry)}\n`).join(""));
  return path;
}

function digest(records) {
  return stateDigest(
    replay(
      records.map(({ offset: _offset, ...event }) => event),
      fixtureReducer,
      fixtureInitialState,
    ),
  );
}

function expected(a, b) {
  let common = 0;
  while (common < a.length && common < b.length && canonicalJson(a[common]) === canonicalJson(b[common])) {
    common += 1;
  }
  const index = common === Math.max(a.length, b.length) ? common : common + 1;
  return {
    aOffset: index === 0 ? null : a[index - 1]?.offset ?? null,
    bOffset: index === 0 ? null : b[index - 1]?.offset ?? null,
    index,
    kind: common === Math.max(a.length, b.length) ? "identical" : index <= a.length && index <= b.length ? "divergence" : "prefix",
    lastCommonDigest: digest(a.slice(0, common)),
  };
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  return { status: result.status ?? 99, stdout: result.stdout, stderr: result.stderr };
}

function expectResult(label, args, expectedResult, expectedStatus) {
  const result = run(args);
  const expectedLine = `${canonicalJson(expectedResult)}\n`;
  if (result.status !== expectedStatus || result.stdout !== expectedLine || result.stderr !== "") {
    throw new Error(`${label} mismatch: ${JSON.stringify(result)}`);
  }
  lines.push(`${label}: exit=${result.status} stdout=${result.stdout.trimEnd()}`);
}

try {
  const base = baseLog();
  const first = base.map((entry) => ({ ...entry }));
  first[0] = { ...first[0], payload: 7 };
  expectResult(
    "divergence-index-1",
    ["bisect", writeLog("base.jsonl", base), writeLog("first.jsonl", first)],
    expected(base, first),
    1,
  );

  const last = base.map((entry) => ({ ...entry }));
  last[last.length - 1] = { ...last[last.length - 1], payload: "last-mutated" };
  expectResult(
    "divergence-final-index",
    ["bisect", writeLog("base-last.jsonl", base), writeLog("last.jsonl", last)],
    expected(base, last),
    1,
  );

  const short = base.slice(0, 12);
  expectResult(
    "prefix-short-first",
    ["bisect", writeLog("short.jsonl", short), writeLog("long.jsonl", base)],
    expected(short, base),
    1,
  );
  expectResult(
    "prefix-long-first",
    ["bisect", writeLog("long-swapped.jsonl", base), writeLog("short-swapped.jsonl", short)],
    expected(base, short),
    1,
  );

  const reconvergeA = base.map((entry) => ({ ...entry }));
  const reconvergeB = base.map((entry) => ({ ...entry }));
  reconvergeA[7] = record(8, { type: "increment", payload: 1, ts: 8 });
  reconvergeB[7] = record(8, { type: "increment", payload: 3, ts: 8 });
  reconvergeA[11] = record(12, { type: "set", payload: 42, ts: 12 });
  reconvergeB[11] = record(12, { type: "set", payload: 42, ts: 12 });
  if (digest(reconvergeA.slice(0, 12)) !== digest(reconvergeB.slice(0, 12))) {
    throw new Error("reconvergence construction failed");
  }
  expectResult(
    "reconvergence-first-index",
    ["bisect", writeLog("reconverge-a.jsonl", reconvergeA), writeLog("reconverge-b.jsonl", reconvergeB)],
    expected(reconvergeA, reconvergeB),
    1,
  );

  const empty = writeLog("empty.jsonl", []);
  expectResult("empty-identical", ["bisect", empty, empty], expected([], []), 0);
  expectResult("empty-prefix", ["bisect", empty, writeLog("one.jsonl", base.slice(0, 1))], expected([], base.slice(0, 1)), 1);

  const malformed = join(temp, "malformed-after-valid.jsonl");
  writeFileSync(malformed, `${canonicalJson(base[0])}\n{"offset":"000002","payload":\n`);
  const valid = writeLog("valid.jsonl", base);
  const malformedResult = run(["bisect", malformed, valid]);
  if (malformedResult.status < 2 || malformedResult.stdout !== "" || !malformedResult.stderr.includes(malformed)) {
    throw new Error(`malformed input mismatch: ${JSON.stringify(malformedResult)}`);
  }
  lines.push(`malformed-after-valid: exit=${malformedResult.status} stdout=<empty> stderr-names-file=true`);

  const custom = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/evidence/alt-reducer.mjs");
  const customResult = run(["bisect", valid, valid, "--reducer", custom, "--stats"]);
  const customReplay = run(["replay", valid, "--digest", "--reducer", custom]);
  if (customResult.status !== 0 || JSON.parse(customResult.stdout).lastCommonDigest !== customReplay.stdout.trim()) {
    throw new Error(`custom reducer mismatch: ${JSON.stringify({ customResult, customReplay })}`);
  }
  lines.push(`custom-reducer: exit=0 digest-equals-ef-replay=true stats=${customResult.stderr.trim()}`);

  const large = baseLog(10_000);
  const largeMutated = large.map((entry) => ({ ...entry }));
  largeMutated[8_999] = { ...largeMutated[8_999], payload: 17 };
  const stats = run(["bisect", writeLog("large-a.jsonl", large), writeLog("large-b.jsonl", largeMutated), "--stats"]);
  const probeLimit = 2 * Math.ceil(Math.log2(10_000)) + 4;
  const statsMatch = stats.stderr.match(/^probes=(\d+) rawPrefixComparisons=(\d+) recordsReplayed=(\d+)\n$/);
  if (stats.status !== 1 || JSON.parse(stats.stdout).index !== 9_000 || statsMatch === null || Number(statsMatch[1]) > probeLimit || Number(statsMatch[2]) > probeLimit) {
    throw new Error(`stats mismatch: ${JSON.stringify(stats)}`);
  }
  lines.push(`stats-10k: exit=1 index=9000 probes=${statsMatch[1]} rawPrefixComparisons=${statsMatch[2]} limit=${probeLimit} stdout-one-line=true`);

  writeFileSync(evidence, ["E0-T12 independent critic attack transcript", ...lines, "Replay: N/A (CLI-only task)."].join("\n") + "\n");
  console.log(`bisect critic attacks: ${lines.length} fresh cases passed`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
