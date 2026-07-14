import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bisectRecords, digestRecords, loadReducer, readDump, type DumpRecord } from "./index.js";
import { canonicalJson } from "@eforest/protocol";

const repo = resolve(import.meta.dirname, "../../..");
const task = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T12-ef-bisect");
const fixtures = join(task, "evidence/fixtures");
const replayEvidence = join(
  repo,
  ".eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest/evidence",
);
const malformedCorpus = readdirSync(join(replayEvidence, "fuzz"))
  .filter((entry) => entry !== "empty.jsonl")
  .sort();
const ef = join(repo, "packages/cli/dist/src/bin.js");
const temp = mkdtempSync(join(tmpdir(), "ef-bisect-test-"));

interface Result {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[]): Result {
  const result = spawnSync(process.execPath, [ef, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  return {
    status: result.status ?? 99,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeDump(name: string, records: readonly DumpRecord[]): string {
  const path = join(temp, name);
  writeFileSync(path, records.map((record) => `${canonicalJson(record)}\n`).join(""));
  return path;
}

function makeRecord(index: number, patch: Partial<DumpRecord> = {}): DumpRecord {
  const event =
    index === 1
      ? { type: "set", payload: 0, ts: index }
      : { type: "increment", payload: 1, ts: index };
  return { offset: String(index).padStart(6, "0"), ...event, ...patch } as DumpRecord;
}

function makeLog(length: number): DumpRecord[] {
  return Array.from({ length }, (_, index) => makeRecord(index + 1));
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@eforest/protocol", "build"], {
    cwd: repo,
    env: { ...process.env, CI: "true" },
  });
  execFileSync("pnpm", ["--filter", "@eforest/cli", "build"], {
    cwd: repo,
    env: { ...process.env, CI: "true" },
  });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("ef bisect committed fixtures", () => {
  const names = readdirSync(fixtures)
    .filter((name) => statSync(join(fixtures, name)).isDirectory())
    .sort();

  it("discovers the complete committed fixture corpus", () => {
    expect(names.length).toBe(11);
  });

  it.each(names)("runs a real CLI process for %s and keeps stdout canonical", (name) => {
    const dir = join(fixtures, name);
    const expected = JSON.parse(readFileSync(join(dir, "pair.expected.json"), "utf8")) as {
      readonly kind: "identical" | "divergence" | "prefix";
    };
    const result = run(["bisect", join(dir, "a.jsonl"), join(dir, "b.jsonl")]);
    expect(result.status, name).toBe(expected.kind === "identical" ? 0 : 1);
    expect(result.stderr, name).toBe("");
    expect(result.stdout, name).toBe(readFileSync(join(dir, "pair.expected.json"), "utf8"));
    expect(result.stdout.split("\n")).toHaveLength(2);
    const line = result.stdout.trimEnd();
    expect(canonicalJson(JSON.parse(line))).toBe(line);
  });

  it("pins exact boundaries, prefix symmetry, and one-field mutations", () => {
    const first = JSON.parse(
      readFileSync(join(fixtures, "first-record/pair.expected.json"), "utf8"),
    );
    const last = JSON.parse(readFileSync(join(fixtures, "last-record/pair.expected.json"), "utf8"));
    expect(first.index).toBe(1);
    expect(last.index).toBe(24);

    const prefix = join(fixtures, "prefix");
    const forward = JSON.parse(
      run(["bisect", join(prefix, "a.jsonl"), join(prefix, "b.jsonl")]).stdout,
    );
    const swapped = JSON.parse(
      run(["bisect", join(prefix, "b.jsonl"), join(prefix, "a.jsonl")]).stdout,
    );
    expect(forward).toMatchObject({ kind: "prefix", index: 13, aOffset: null, bOffset: "0013" });
    expect(swapped).toMatchObject({ kind: "prefix", index: 13, aOffset: "0013", bOffset: null });

    const fieldByFixture = {
      "payload-only": "payload",
      "type-only": "type",
      "ts-only": "ts",
    } as const;
    for (const [name, field] of Object.entries(fieldByFixture)) {
      const a = readFileSync(join(fixtures, `${name}/a.jsonl`), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const b = readFileSync(join(fixtures, `${name}/b.jsonl`), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const differing = ["offset", "payload", "ts", "type"].filter(
        (key) => canonicalJson(a[11]![key]) !== canonicalJson(b[11]![key]),
      );
      expect(differing, name).toEqual([field]);
    }
  });

  it("agrees with ef replay and proves the reconvergence trap", async () => {
    const identical = join(fixtures, "identical");
    const bisect = JSON.parse(
      run(["bisect", join(identical, "a.jsonl"), join(identical, "b.jsonl")]).stdout,
    );
    const replay = run(["replay", join(identical, "a.jsonl"), "--digest"]);
    expect(replay.status).toBe(0);
    expect(bisect.lastCommonDigest).toBe(replay.stdout.trim());

    const reconverge = join(fixtures, "reconverge");
    const a = await readDump(join(reconverge, "a.jsonl"), { allowEmpty: true });
    const b = await readDump(join(reconverge, "b.jsonl"), { allowEmpty: true });
    const reducer = await loadReducer();
    expect(digestRecords(a, reducer, 12)).toBe(digestRecords(b, reducer, 12));
    expect(digestRecords(a, reducer, 8)).not.toBe(digestRecords(b, reducer, 8));
    const result = JSON.parse(
      run(["bisect", join(reconverge, "a.jsonl"), join(reconverge, "b.jsonl")]).stdout,
    );
    expect(result).toMatchObject({ kind: "divergence", index: 8 });
  });

  it("honors a custom reducer and keeps stats off stdout", () => {
    const identical = join(fixtures, "identical");
    const reducer = join(replayEvidence, "alt-reducer.mjs");
    const custom = run([
      "bisect",
      join(identical, "a.jsonl"),
      join(identical, "b.jsonl"),
      "--reducer",
      reducer,
      "--stats",
    ]);
    const customResult = JSON.parse(custom.stdout);
    const customReplay = run([
      "replay",
      join(identical, "a.jsonl"),
      "--digest",
      "--reducer",
      reducer,
    ]);
    const defaultReplay = run(["replay", join(identical, "a.jsonl"), "--digest"]);
    expect(custom.status).toBe(0);
    expect(custom.stdout).not.toContain("probes");
    expect(custom.stderr).toMatch(/^probes=\d+ rawPrefixComparisons=\d+ recordsReplayed=\d+\n$/);
    expect(customResult.lastCommonDigest).toBe(customReplay.stdout.trim());
    expect(customResult.lastCommonDigest).not.toBe(defaultReplay.stdout.trim());
  });

  it.each(malformedCorpus)("rejects malformed E0-T04 corpus file %s in both positions", (name) => {
    const valid = join(fixtures, "identical/a.jsonl");
    const corpus = join(replayEvidence, "fuzz");
    const bad = join(corpus, name);
    for (const args of [
      [bad, valid],
      [valid, bad],
    ]) {
      const result = run(["bisect", ...args]);
      expect(result.status, `${name} ${args[0] === bad ? "a" : "b"}`).toBeGreaterThanOrEqual(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(name);
    }
  });

  it("rejects missing bisect inputs and reducers", () => {
    const valid = join(fixtures, "identical/a.jsonl");
    const missing = join(temp, "missing.jsonl");
    const missingResult = run(["bisect", missing, valid]);
    expect(missingResult.status).toBeGreaterThanOrEqual(2);
    expect(missingResult.stdout).toBe("");
    expect(missingResult.stderr).toContain("missing.jsonl");
    const badReducer = run([
      "bisect",
      valid,
      valid,
      "--reducer",
      join(temp, "missing-reducer.mjs"),
    ]);
    expect(badReducer.status).toBeGreaterThanOrEqual(2);
    expect(badReducer.stdout).toBe("");
    expect(badReducer.stderr).toContain("missing-reducer.mjs");
  });

  it("keeps binary-search probes logarithmic on ten thousand records", () => {
    const a = makeLog(10_000);
    const b = a.map((record) => ({ ...record }));
    b[8_999] = { ...b[8_999]!, payload: 17 };
    const aPath = writeDump("large-a.jsonl", a);
    const bPath = writeDump("large-b.jsonl", b);
    const result = run(["bisect", aPath, bPath, "--stats"]);
    const parsed = JSON.parse(result.stdout);
    expect(result.stderr).toMatch(/^probes=\d+ rawPrefixComparisons=\d+ recordsReplayed=\d+\n$/);
    const probes = Number(result.stderr.match(/probes=(\d+)/)?.[1]);
    const rawPrefixComparisons = Number(result.stderr.match(/rawPrefixComparisons=(\d+)/)?.[1]);
    expect(result.status).toBe(1);
    expect(parsed.index).toBe(9_000);
    expect(probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(10_000)) + 4);
    expect(rawPrefixComparisons).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(10_000)) + 4);
  });
});

describe("ef bisect seeded property", () => {
  const seeds = [271828, 314159, 8675309] as const;
  const modes = ["payload", "type", "ts", "replacement", "truncate", "extend"] as const;
  interface PropertyCase {
    readonly seed: number;
    readonly iteration: number;
    readonly mode: (typeof modes)[number];
    readonly length: number;
    readonly base: readonly DumpRecord[];
    readonly other: readonly DumpRecord[];
    readonly expectedIndex: number;
    readonly expectedKind: "divergence" | "prefix";
  }
  const cache = new Map<number, readonly PropertyCase[]>();
  const casesForSeed = (seed: number): readonly PropertyCase[] => {
    const cached = cache.get(seed);
    if (cached !== undefined) return cached;
    const cases: PropertyCase[] = [];
    const next = random(seed);
    for (let iteration = 0; iteration < 75; iteration += 1) {
      const length = iteration === 0 ? 1_100 : 1 + Math.floor(next() * 1_100);
      const base = makeLog(length);
      const mode = modes[Math.floor(next() * modes.length)]!;
      let other: DumpRecord[];
      let expectedIndex: number;
      let expectedKind: "divergence" | "prefix";
      if (mode === "truncate") {
        const count = Math.floor(next() * length);
        other = base.slice(0, count);
        expectedIndex = count + 1;
        expectedKind = "prefix";
      } else if (mode === "extend") {
        other = [...base, makeRecord(length + 1, { type: "increment", payload: 2 })];
        expectedIndex = length + 1;
        expectedKind = "prefix";
      } else {
        const index = 1 + Math.floor(next() * length);
        const mutation =
          mode === "payload"
            ? { payload: index + 2 }
            : mode === "type"
              ? { type: base[index - 1]!.type === "set" ? "increment" : "set" }
              : mode === "ts"
                ? { ts: 50_000 + index }
                : { payload: index + 3, type: "set" };
        other = base.map((record, recordIndex) =>
          recordIndex === index - 1 ? ({ ...record, ...mutation } as DumpRecord) : record,
        );
        expectedIndex = index;
        expectedKind = "divergence";
      }
      cases.push({
        seed,
        iteration,
        mode,
        length,
        base,
        other,
        expectedIndex,
        expectedKind,
      });
    }
    cache.set(seed, cases);
    return cases;
  };
  const chunks = seeds.flatMap((seed) =>
    [0, 25, 50].map((start) => [seed, start, start + 25] as const),
  );

  it.each(chunks)(
    "recovers planted boundaries for seed %i iterations %i-%i",
    async (seed, start, end) => {
      const reducer = await loadReducer();
      for (const testCase of casesForSeed(seed).slice(start, end)) {
        const result = bisectRecords(testCase.base, testCase.other, reducer).result;
        expect(result.index, `${seed}/${testCase.iteration}/${testCase.mode}`).toBe(
          testCase.expectedIndex,
        );
        expect(result.kind, `${seed}/${testCase.iteration}/${testCase.mode}`).toBe(
          testCase.expectedKind,
        );
      }
    },
  );

  it("spans tiny through thousand-record histories", () => {
    const lengths = seeds.flatMap((seed) => casesForSeed(seed).map(({ length }) => length));
    expect(Math.min(...lengths)).toBeLessThan(10);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(1_000);
  });
});
