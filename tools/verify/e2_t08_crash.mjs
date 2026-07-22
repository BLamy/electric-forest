#!/usr/bin/env node
// E2-T08 crash idempotence: kill the projector at seeded-random append
// boundaries (before OR after the derived append — the two sides of the
// "checkpoint" that does not exist outside the stream), restart it, and prove
// the final derived log carries exactly one event per accepted source event
// with a state digest equal to an uninterrupted run's. The committed seed
// makes the kill schedule reproducible; the transcript is byte-stable.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  OfficialStreamAdapter,
  NamespaceDispatcher,
  RegistryProjector,
  replayRegistryStream,
  registryStateDigest,
} from "../../packages/platform/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-crash-idempotence.txt",
);
const update = process.argv.includes("--update-evidence");

/** The committed seed. Changing it invalidates the committed transcript. */
const CRASH_SEED = 0xe2708;

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ProjectorCrash extends Error {}

class CrashingAdapter {
  constructor(inner, countdown, before) {
    this.inner = inner;
    this.countdown = countdown;
    this.before = before;
    this.appends = 0;
  }
  create(id) {
    return this.inner.create(id);
  }
  read(id) {
    return this.inner.read(id);
  }
  follow(id, signal) {
    return this.inner.follow(id, signal);
  }
  async append(id, event, options) {
    if (this.before && this.countdown === 0) throw new ProjectorCrash();
    const result = await this.inner.append(id, event, options);
    this.appends += 1;
    if (!this.before && this.countdown === 0) throw new ProjectorCrash();
    this.countdown -= 1;
    return result;
  }
}

const ALICE = "auth0|alice";
const BOB = "auth0|bob";
const steps = [
  ["ns:root", "ns.org.create", { v: 1, name: "acme" }, ALICE],
  ["ns:root", "ns.org.create", { v: 1, name: "beta" }, BOB],
  ["ns:root", "ns.org.create", { v: 1, name: "coop" }, ALICE],
  ["ns:org:acme", "ns.project.create", { v: 1, name: "web" }, ALICE],
  ["ns:org:beta", "ns.project.create", { v: 1, name: "api" }, BOB],
  ["ns:org:coop", "ns.project.create", { v: 1, name: "ops" }, ALICE],
  [
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "one", project: "web", visibility: "public" },
    ALICE,
  ],
  [
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "two", project: "web", visibility: "private" },
    ALICE,
  ],
  [
    "ns:org:beta",
    "ns.repo.create",
    { v: 1, name: "three", project: "api", visibility: "private" },
    BOB,
  ],
  [
    "ns:org:coop",
    "ns.repo.create",
    { v: 1, name: "four", project: "ops", visibility: "public" },
    ALICE,
  ],
  ["ns:org:acme", "ns.repo.rename", { v: 1, name: "one", newName: "uno" }, ALICE],
  ["ns:org:acme", "ns.repo.rename", { v: 1, name: "uno", newName: "one" }, ALICE],
  ["ns:org:beta", "ns.repo.set-visibility", { v: 1, name: "three", visibility: "public" }, BOB],
  ["ns:org:coop", "ns.repo.set-visibility", { v: 1, name: "four", visibility: "private" }, ALICE],
  ["ns:org:acme", "ns.repo.rename", { v: 1, name: "two", newName: "dos" }, ALICE],
];

async function buildSource(streams) {
  const ns = new NamespaceDispatcher(streams);
  for (const [index, [streamId, type, payload, sub]] of steps.entries()) {
    await ns.dispatch(streamId, { type, payload, ts: index + 1 }, sub);
  }
}

async function withStore(run) {
  const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const url = await server.start();
  try {
    return await run(new OfficialStreamAdapter({ baseUrl: url }));
  } finally {
    await server.stop();
  }
}

const lines = [
  "E2-T08 crash idempotence",
  `seed=0x${CRASH_SEED.toString(16)}`,
  `source-events=${steps.length}`,
];

// Uninterrupted reference.
const reference = await withStore(async (streams) => {
  await buildSource(streams);
  const projector = new RegistryProjector(streams);
  while ((await projector.syncOnce()) > 0);
  const records = await streams.read("__registry__");
  return { digest: registryStateDigest(replayRegistryStream(records)), length: records.length };
});
assert.equal(reference.length, steps.length);
lines.push(`uninterrupted digest=${reference.digest} events=${reference.length}`);

// Interrupted run under the seeded kill schedule.
const random = prng(CRASH_SEED);
const interrupted = await withStore(async (streams) => {
  await buildSource(streams);
  let crashes = 0;
  for (;;) {
    const countdown = Math.floor(random() * 4);
    const before = random() < 0.5;
    const registryLengthAtStart = await streams
      .read("__registry__")
      .then((records) => records.length)
      .catch(() => 0);
    const crashy = new RegistryProjector(new CrashingAdapter(streams, countdown, before));
    try {
      await crashy.syncOnce();
      lines.push(`restart ${crashes + 1}: clean pass from derived-offset=${registryLengthAtStart}`);
      break;
    } catch (error) {
      if (!(error instanceof ProjectorCrash)) throw error;
      crashes += 1;
      assert.ok(crashes < 100, "crash schedule never let the projector finish");
      lines.push(
        `kill ${crashes}: at derived-offset=${registryLengthAtStart} countdown=${countdown} phase=${before ? "before-append" : "after-append"}`,
      );
    }
  }
  const settled = new RegistryProjector(streams);
  assert.equal(await settled.syncOnce(), 0, "post-crash projector still had work");
  const records = await streams.read("__registry__");
  const sources = records.map(
    (record) => `${record.payload.source.stream}@${record.payload.source.offset}`,
  );
  assert.equal(records.length, steps.length, "derived event count != source event count");
  assert.equal(new Set(sources).size, sources.length, "duplicate source pair in derived log");
  return {
    digest: registryStateDigest(replayRegistryStream(records)),
    length: records.length,
    crashes,
  };
});
assert.ok(interrupted.crashes > 0, "the seed produced no crashes — schedule is vacuous");
assert.equal(interrupted.digest, reference.digest, "interrupted digest != uninterrupted digest");
lines.push(
  `interrupted digest=${interrupted.digest} events=${interrupted.length} crashes=${interrupted.crashes}`,
  "duplicate-source scan: 0 duplicates, 0 missing (exactly one derived event per source event)",
  "digest-equality interrupted==uninterrupted: true",
);

// Double-start: two projector instances over one store.
const doubled = await withStore(async (streams) => {
  await buildSource(streams);
  const a = new RegistryProjector(streams);
  const b = new RegistryProjector(streams);
  await Promise.all([a.syncOnce(), b.syncOnce()]);
  while ((await a.syncOnce()) + (await b.syncOnce()) > 0);
  const records = await streams.read("__registry__");
  const sources = records.map(
    (record) => `${record.payload.source.stream}@${record.payload.source.offset}`,
  );
  assert.equal(records.length, steps.length);
  assert.equal(new Set(sources).size, sources.length, "double-start duplicated a derived event");
  return registryStateDigest(replayRegistryStream(records));
});
assert.equal(doubled, reference.digest);
lines.push("double-start (two projectors, one store): 0 duplicates, digest identical");
lines.push("E2_T08_CRASH_IDEMPOTENCE_OK");

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  assert.equal(readFileSync(evidencePath, "utf8"), transcript, "crash evidence drifted");
  process.stdout.write("e2_t08_crash: OK\n");
}
