import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, stateDigest } from "@eforest/protocol";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  NamespaceDispatcher,
  OfficialStreamAdapter,
  registryStateDigest,
  RegistryProjector,
  replayRegistryStream,
  type StreamAdapter,
} from "../src/index.js";
import { buildLifecycleTree, registryHttpFixture, SUBJECTS } from "./registry.helpers.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const efBin = join(repoRoot, "packages/cli/dist/src/bin.js");

/** Seed committed with the task — the crash schedule is derived from it alone. */
const CRASH_SEED = 0xe2708;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  if (process.env.EFOREST_TEST_PREBUILT === "1") {
    if (!existsSync(efBin)) {
      throw new Error("EFOREST_TEST_PREBUILT=1 requires a built @eforest/cli entrypoint");
    }
    return;
  }
  const result = spawnSync("pnpm", ["--filter", "@eforest/cli", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`cli build failed: ${result.stdout}${result.stderr}`);
  }
}, 60_000);

interface RebuildRun {
  readonly digest: string;
  readonly pid: number;
  readonly dump: string;
}

function runRebuild(dataDir: string, force = false): RebuildRun {
  const child = spawnSync(
    process.execPath,
    [efBin, "registry", "rebuild", "--data-dir", dataDir, ...(force ? ["--force"] : [])],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  const digest = child.stdout.trim();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const pid = Number(/pid=(\d+)/.exec(child.stderr)?.[1]);
  expect(Number.isSafeInteger(pid)).toBe(true);
  return { digest, pid, dump: dumpRegistry(dataDir) };
}

/** Read the __registry__ log back through the store's own surface. */
function dumpRegistry(dataDir: string): string {
  const outPath = join(
    tmpdir(),
    `e2-t08-dump-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  const read = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const { createDurableStreamTestServer } = await import(${JSON.stringify(
        join(repoRoot, "packages/server/dist/src/index.js"),
      )});
      const { OfficialStreamAdapter } = await import(${JSON.stringify(
        join(repoRoot, "packages/platform/dist/src/index.js"),
      )});
      const { canonicalJson } = await import(${JSON.stringify(
        join(repoRoot, "packages/protocol/dist/src/index.js"),
      )});
      const { writeFileSync } = await import("node:fs");
      const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir: process.argv[1] });
      const url = await server.start();
      const records = await new OfficialStreamAdapter({ baseUrl: url }).read("__registry__");
      writeFileSync(process.argv[2], records.map((record) => canonicalJson(record)).join("\\n") + "\\n");
      await server.stop();
      `,
      dataDir,
      outPath,
    ],
    { encoding: "utf8", env: { ...process.env }, cwd: repoRoot },
  );
  expect(read.status, read.stderr).toBe(0);
  const dump = readFileSync(outPath, "utf8");
  rmSync(outPath, { force: true });
  return dump;
}

describe("bet-4 destruction", () => {
  it("deletes the materialized index entirely and rebuilds it byte-identically from the source logs alone", async () => {
    const dataDir = scratch("e2-t08-destruction-");
    const fixture = await registryHttpFixture({ dataDir });
    await buildLifecycleTree(fixture);
    const before = (await fixture.streams.read("__registry__")) as readonly {
      readonly offset: string;
    }[];
    expect(before.length).toBe(11);
    const digestBefore = registryStateDigest(replayRegistryStream(before));
    const headBefore = before.at(-1)!.offset;

    // Plant a leftover materialization copy the rebuild MUST NOT read.
    const leftover = join(dataDir, "__registry__.cache.jsonl");
    writeFileSync(leftover, before.map((record) => canonicalJson(record)).join("\n") + "\n");

    // Stop the projector, then delete the derived stream's persisted data
    // through the store's own surface — the source ns:* logs untouched.
    fixture.projector.stop();
    expect(await fixture.streams.delete("__registry__")).toBe(true);
    await expect(fixture.streams.read("__registry__")).rejects.toThrow();
    await fixture.stop();

    // Corrupt one byte of the planted leftover: the rebuild output must be
    // unaffected because it never reads it.
    const bytes = readFileSync(leftover);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    writeFileSync(leftover, bytes);

    const rebuilt = runRebuild(dataDir);
    expect(rebuilt.digest).toBe(digestBefore);
    const rebuiltRecords = rebuilt.dump
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly offset: string });
    expect(rebuiltRecords.length).toBe(11);
    expect(rebuiltRecords.at(-1)!.offset).toBe(headBefore);
    expect(registryStateDigest(replayRegistryStream(rebuiltRecords))).toBe(digestBefore);
  }, 60_000);

  it("refuses to rebuild while __registry__ survives, unless --force discards it", async () => {
    const dataDir = scratch("e2-t08-force-");
    const fixture = await registryHttpFixture({ dataDir });
    await buildLifecycleTree(fixture);
    const digestBefore = registryStateDigest(
      replayRegistryStream(await fixture.streams.read("__registry__")),
    );
    fixture.projector.stop();
    await fixture.stop();
    const refused = spawnSync(
      process.execPath,
      [efBin, "registry", "rebuild", "--data-dir", dataDir],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--force");
    const forced = runRebuild(dataDir, true);
    expect(forced.digest).toBe(digestBefore);
  }, 60_000);

  it("two independent-process rebuilds are byte-identical (distinct pids)", async () => {
    const dataDir = scratch("e2-t08-determinism-");
    const fixture = await registryHttpFixture({ dataDir });
    await buildLifecycleTree(fixture);
    fixture.projector.stop();
    expect(await fixture.streams.delete("__registry__")).toBe(true);
    await fixture.stop();
    const copyDir = scratch("e2-t08-determinism-copy-");
    cpSync(dataDir, copyDir, { recursive: true });
    const first = runRebuild(dataDir);
    const second = runRebuild(copyDir);
    expect(second.pid).not.toBe(first.pid);
    expect(second.digest).toBe(first.digest);
    expect(second.dump).toBe(first.dump);
    expect(first.dump.length).toBeGreaterThan(0);
    // The frozen total rebuild order (ns:root first, then each ns:org:<org>
    // in lexicographic org order) is enforced INSIDE the vitest suite too: the
    // rebuilt derived log must be byte-identical to the committed golden dump,
    // so a reordered rebuild cannot stay green under `pnpm test` alone.
    const goldenDump = readFileSync(
      join(repoRoot, "packages/platform/fixtures/registry/two-orgs-lifecycle/registry.jsonl"),
      "utf8",
    );
    expect(first.dump).toBe(goldenDump);
  }, 90_000);
});

class ProjectorCrash extends Error {
  constructor() {
    super("projector killed by schedule");
    this.name = "ProjectorCrash";
  }
}

/** mulberry32 — deterministic from the committed seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Crashes the projector at scheduled append boundaries — either BEFORE the
 * derived append leaves (killing between the source read and the derived
 * append) or AFTER it commits (killing before the checkpoint is "saved" —
 * which is the point: there is no checkpoint write to lose, the checkpoint IS
 * the appended event).
 */
class CrashingAdapter implements StreamAdapter {
  private countdown: number;
  private readonly before: boolean;

  constructor(
    private readonly inner: StreamAdapter,
    countdown: number,
    before: boolean,
  ) {
    this.countdown = countdown;
    this.before = before;
  }

  create(streamId: string): Promise<void> {
    return this.inner.create(streamId);
  }

  read(streamId: string): Promise<readonly unknown[]> {
    return this.inner.read(streamId);
  }

  follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown> {
    return this.inner.follow(streamId, signal);
  }

  async append(
    streamId: string,
    event: Parameters<StreamAdapter["append"]>[1],
    options?: Parameters<StreamAdapter["append"]>[2],
  ): ReturnType<StreamAdapter["append"]> {
    if (this.before && this.countdown === 0) throw new ProjectorCrash();
    const result = await this.inner.append(streamId, event, options);
    if (!this.before) {
      if (this.countdown === 0) throw new ProjectorCrash();
      this.countdown -= 1;
    } else {
      this.countdown -= 1;
    }
    return result;
  }
}

describe("crash idempotence (seed committed)", () => {
  it("kills the projector at randomized offsets; the derived log has exactly one event per source event and the digest equals an uninterrupted run", async () => {
    const { alice, bob } = SUBJECTS;
    const random = prng(CRASH_SEED);
    const killSchedule: { readonly countdown: number; readonly before: boolean }[] = [];

    async function buildSource(streams: OfficialStreamAdapter): Promise<number> {
      const ns = new NamespaceDispatcher(streams);
      const event = (type: string, payload: unknown, ts: number) => ({ type, payload, ts });
      const steps: readonly [string, string, unknown, string][] = [
        ["ns:root", "ns.org.create", { v: 1, name: "acme" }, alice],
        ["ns:root", "ns.org.create", { v: 1, name: "beta" }, bob],
        ["ns:root", "ns.org.create", { v: 1, name: "coop" }, alice],
        ["ns:org:acme", "ns.project.create", { v: 1, name: "web" }, alice],
        ["ns:org:beta", "ns.project.create", { v: 1, name: "api" }, bob],
        ["ns:org:coop", "ns.project.create", { v: 1, name: "ops" }, alice],
        [
          "ns:org:acme",
          "ns.repo.create",
          { v: 1, name: "one", project: "web", visibility: "public" },
          alice,
        ],
        [
          "ns:org:acme",
          "ns.repo.create",
          { v: 1, name: "two", project: "web", visibility: "private" },
          alice,
        ],
        [
          "ns:org:beta",
          "ns.repo.create",
          { v: 1, name: "three", project: "api", visibility: "private" },
          bob,
        ],
        [
          "ns:org:coop",
          "ns.repo.create",
          { v: 1, name: "four", project: "ops", visibility: "public" },
          alice,
        ],
        ["ns:org:acme", "ns.repo.rename", { v: 1, name: "one", newName: "uno" }, alice],
        ["ns:org:acme", "ns.repo.rename", { v: 1, name: "uno", newName: "one" }, alice],
        [
          "ns:org:beta",
          "ns.repo.set-visibility",
          { v: 1, name: "three", visibility: "public" },
          bob,
        ],
        [
          "ns:org:coop",
          "ns.repo.set-visibility",
          { v: 1, name: "four", visibility: "private" },
          alice,
        ],
        ["ns:org:acme", "ns.repo.rename", { v: 1, name: "two", newName: "dos" }, alice],
      ];
      let ts = 1;
      for (const [streamId, type, payload, sub] of steps) {
        await ns.dispatch(streamId, event(type, payload, ts) as never, sub);
        ts += 1;
      }
      return steps.length;
    }

    // Uninterrupted reference run.
    const referenceServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const referenceUrl = await referenceServer.start();
    const referenceStreams = new OfficialStreamAdapter({ baseUrl: referenceUrl });
    const sourceCount = await buildSource(referenceStreams);
    const reference = new RegistryProjector(referenceStreams);
    await reference.syncOnce();
    const referenceRecords = await referenceStreams.read("__registry__");
    const referenceDigest = registryStateDigest(replayRegistryStream(referenceRecords));
    await referenceServer.stop();
    expect(referenceRecords.length).toBe(sourceCount);

    // Interrupted run: crash + restart until a clean pass completes.
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const url = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl: url });
    await buildSource(streams);
    let crashes = 0;
    for (;;) {
      const countdown = Math.floor(random() * 4);
      const before = random() < 0.5;
      killSchedule.push({ countdown, before });
      const crashy = new RegistryProjector(new CrashingAdapter(streams, countdown, before));
      try {
        await crashy.syncOnce();
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectorCrash);
        crashes += 1;
        expect(crashes).toBeLessThan(100);
      }
    }
    // A final, uninterrupted projector confirms nothing remains to project.
    const settled = new RegistryProjector(streams);
    expect(await settled.syncOnce()).toBe(0);

    const records = (await streams.read("__registry__")) as readonly {
      readonly payload: { readonly source: { readonly stream: string; readonly offset: string } };
    }[];
    // Exactly one derived event per accepted source event: none missing…
    expect(records.length).toBe(sourceCount);
    // …and no duplicate source pairs.
    const sources = records.map(
      (record) => `${record.payload.source.stream}@${record.payload.source.offset}`,
    );
    expect(new Set(sources).size).toBe(sources.length);
    const digest = registryStateDigest(replayRegistryStream(records));
    expect(digest).toBe(referenceDigest);
    expect(crashes).toBeGreaterThan(0);
    await server.stop();

    // Double-start: two projector instances against one store never
    // duplicate a derived event (sequence fencing).
    const doubleServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const doubleUrl = await doubleServer.start();
    const doubleStreams = new OfficialStreamAdapter({ baseUrl: doubleUrl });
    await buildSource(doubleStreams);
    const a = new RegistryProjector(doubleStreams);
    const b = new RegistryProjector(doubleStreams);
    await Promise.all([a.syncOnce(), b.syncOnce()]);
    // Racing passes may each abort on the other's sequence conflict; run to
    // fixpoint the way the loop does.
    while ((await a.syncOnce()) + (await b.syncOnce()) > 0) {
      // converging
    }
    const doubled = (await doubleStreams.read("__registry__")) as typeof records;
    expect(doubled.length).toBe(sourceCount);
    const doubledSources = doubled.map(
      (record) => `${record.payload.source.stream}@${record.payload.source.offset}`,
    );
    expect(new Set(doubledSources).size).toBe(doubledSources.length);
    expect(registryStateDigest(replayRegistryStream(doubled))).toBe(referenceDigest);
    await doubleServer.stop();
  }, 120_000);

  it("restarts on a copy of the stream-store directory alone and answers identically", async () => {
    const dataDir = scratch("e2-t08-restart-");
    const fixture = await registryHttpFixture({ dataDir });
    await buildLifecycleTree(fixture);
    const expected = await Promise.all(
      (["public", "org/acme", "me"] as const).map(async (door) => {
        const response = await fetch(`${fixture.baseUrl}/registry/${door}`, {
          headers:
            door === "public"
              ? {}
              : { authorization: `Bearer ${await fixture.token(SUBJECTS.alice)}` },
        });
        return [door, response.status, await response.text()] as const;
      }),
    );
    // Abrupt halt: no graceful flush beyond what the store already fsynced.
    fixture.projector.stop();
    await fixture.stop();
    const copyDir = scratch("e2-t08-restart-copy-");
    cpSync(dataDir, copyDir, { recursive: true });
    rmSync(dataDir, { recursive: true, force: true });
    const restarted = await registryHttpFixture({ dataDir: copyDir });
    // The restarted server re-verifies identities; reuse its own tokens.
    for (const [door, status, body] of expected) {
      const response = await fetch(`${restarted.baseUrl}/registry/${door}`, {
        headers:
          door === "public"
            ? {}
            : { authorization: `Bearer ${await restarted.token(SUBJECTS.alice)}` },
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
    }
    await restarted.stop();
  }, 60_000);
});

describe("registry dump digest instrument", () => {
  it("ef replay --digest over a __registry__ dump equals registryStateDigest", async () => {
    const dataDir = scratch("e2-t08-replay-");
    const fixture = await registryHttpFixture({ dataDir });
    await buildLifecycleTree(fixture);
    const records = await fixture.streams.read("__registry__");
    const digest = registryStateDigest(replayRegistryStream(records));
    const dumpPath = join(scratch("e2-t08-dump-"), "registry.jsonl");
    writeFileSync(dumpPath, records.map((record) => canonicalJson(record)).join("\n") + "\n");
    const replayed = spawnSync(
      process.execPath,
      [
        efBin,
        "replay",
        dumpPath,
        "--digest",
        "--reducer",
        join(repoRoot, "packages/platform/registry-reducer.mjs"),
      ],
      { encoding: "utf8", cwd: repoRoot },
    );
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(replayed.stdout.trim()).toBe(digest);
    // Sanity: the dump digest is over canonical state, not the raw records.
    expect(digest).not.toBe(stateDigest(records));
    await fixture.stop();
  }, 60_000);
});
