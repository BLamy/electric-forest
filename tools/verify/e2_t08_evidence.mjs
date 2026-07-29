#!/usr/bin/env node
// E2-T08 golden verification + rebuild determinism:
//  - every committed dump replays (ef CLI, frozen reducers) to its committed
//    digest — a drifted golden fails here first;
//  - the frozen dispatch script is re-driven live against a fresh store: every
//    refusal fires with its frozen reason and the resulting dumps are BYTE
//    IDENTICAL to the committed fixtures (refusal-neutral == valid
//    subsequence, proven live);
//  - per-identity filtered listings recompute to the committed literals;
//  - two `ef registry rebuild` child processes (distinct pids) over stores
//    seeded from the committed SOURCE dumps alone produce byte-identical
//    __registry__ logs matching the committed derived dump and digest.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  OfficialStreamAdapter,
  NamespaceDispatcher,
  NamespaceRefusalError,
  filterForIdentity,
  registryEntries,
  restrictToOwnRelations,
  replayRegistryStream,
  registryStateDigest,
} from "../../packages/platform/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(root, "packages/platform/fixtures/registry");
const efBin = resolve(root, "packages/cli/dist/src/bin.js");
const nsReducer = resolve(root, "packages/platform/ns-reducer.mjs");
const registryReducer = resolve(root, "packages/platform/registry-reducer.mjs");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-rebuild-determinism.txt",
);
const update = process.argv.includes("--update-evidence");
const fixtures = ["two-orgs-lifecycle", "refusal-neutral"];
const lines = ["E2-T08 rebuild determinism — two independent node processes per fixture"];

function replayDigest(dumpPath, reducer) {
  const child = spawnSync(
    process.execPath,
    [efBin, "replay", dumpPath, "--digest", "--reducer", reducer],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, `${dumpPath}: ${child.stdout}${child.stderr}`);
  assert.match(child.stdout, /^[0-9a-f]{64}\n$/);
  return child.stdout.trim();
}

function readDump(path) {
  return readFileSync(path, "utf8");
}

for (const name of fixtures) {
  const dir = join(fixtureRoot, name);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  assert.equal(expected.schema, 1);

  // 1. Committed dumps replay to committed digests through the frozen CLI.
  for (const [streamId, meta] of Object.entries(expected.streams)) {
    const digest = replayDigest(join(dir, meta.dump), nsReducer);
    assert.equal(digest, meta.digest, `${name}/${streamId} digest drifted`);
  }
  const registryDigest = replayDigest(join(dir, expected.registry.dump), registryReducer);
  assert.equal(registryDigest, expected.registry.digest, `${name}/__registry__ digest drifted`);

  // 2. Re-drive the frozen script live: refusals fire with frozen reasons and
  //    the store's dumps end byte-identical to the committed fixtures.
  const liveServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const liveUrl = await liveServer.start();
  const liveStreams = new OfficialStreamAdapter({ baseUrl: liveUrl });
  const dispatcher = new NamespaceDispatcher(liveStreams);
  for (const step of expected.script) {
    try {
      await dispatcher.dispatch(
        step.streamId,
        { type: step.type, payload: step.payload, ts: step.ts },
        step.sub,
      );
      assert.equal(
        step.refusal,
        undefined,
        `${name}: expected refusal ${step.refusal} at ts=${step.ts}`,
      );
    } catch (error) {
      if (!(error instanceof NamespaceRefusalError)) throw error;
      assert.equal(error.reason, step.refusal, `${name}: wrong refusal at ts=${step.ts}`);
    }
  }
  for (const [streamId, meta] of Object.entries(expected.streams)) {
    const records = await liveStreams.read(streamId);
    const live = records.map((record) => canonicalJson(record)).join("\n") + "\n";
    assert.equal(
      live,
      readDump(join(dir, meta.dump)),
      `${name}/${streamId}: live re-drive diverged from the committed dump`,
    );
  }
  await liveServer.stop();

  // 3. Filtered listings recompute to the committed literals.
  const registryRecords = readDump(join(dir, expected.registry.dump))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const state = replayRegistryStream(registryRecords);
  assert.equal(registryStateDigest(state), expected.registry.digest);
  for (const [label, doors] of Object.entries(expected.listings)) {
    const sub =
      label === "anonymous"
        ? null
        : { alice: "auth0|alice", bob: "auth0|bob", carol: "auth0|carol", dave: "auth0|dave" }[
            label
          ];
    const filtered = filterForIdentity(state, expected.identityView, sub);
    assert.deepEqual(
      registryEntries(filterForIdentity(state, expected.identityView, null)),
      doors.public,
      `${name}/${label} public listing drifted`,
    );
    for (const [org, entries] of Object.entries(doors.orgs)) {
      const scoped = Object.hasOwn(filtered.orgs, org)
        ? { orgs: { [org]: filtered.orgs[org] } }
        : { orgs: {} };
      assert.deepEqual(registryEntries(scoped), entries, `${name}/${label} org/${org} drifted`);
    }
    if (sub !== null) {
      assert.deepEqual(
        registryEntries(restrictToOwnRelations(filtered, expected.identityView, sub)),
        doors.me,
        `${name}/${label} me listing drifted`,
      );
    }
  }

  // 4. Two child-process rebuilds over source-dump-seeded stores.
  const scratch = mkdtempSync(join(tmpdir(), `e2-t08-golden-${name}-`));
  try {
    const storeA = join(scratch, "a");
    const seedServer = createDurableStreamTestServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: storeA,
    });
    const seedUrl = await seedServer.start();
    const seedStreams = new OfficialStreamAdapter({ baseUrl: seedUrl });
    for (const [streamId, meta] of Object.entries(expected.streams)) {
      await seedStreams.create(streamId);
      for (const line of readDump(join(dir, meta.dump)).trimEnd().split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        await seedStreams.append(streamId, record, { sequence: record.offset });
      }
    }
    await seedServer.stop();
    const storeB = join(scratch, "b");
    cpSync(storeA, storeB, { recursive: true });
    const runs = [storeA, storeB].map((store) => {
      const child = spawnSync(
        process.execPath,
        [efBin, "registry", "rebuild", "--data-dir", store],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      assert.equal(child.status, 0, `${name}: rebuild failed: ${child.stderr}`);
      const pid = Number(/pid=(\d+)/.exec(child.stderr)?.[1]);
      assert.ok(Number.isSafeInteger(pid), "rebuild did not print its pid");
      return { digest: child.stdout.trim(), pid, store };
    });
    assert.notEqual(runs[0].pid, runs[1].pid, `${name}: rebuild processes shared a pid`);
    for (const run of runs) {
      assert.equal(run.digest, expected.registry.digest, `${name}: rebuild digest != golden`);
      const readBack = createDurableStreamTestServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: run.store,
      });
      const readUrl = await readBack.start();
      const records = await new OfficialStreamAdapter({ baseUrl: readUrl }).read("__registry__");
      await readBack.stop();
      run.dump = records.map((record) => canonicalJson(record)).join("\n") + "\n";
    }
    assert.equal(runs[0].dump, runs[1].dump, `${name}: rebuild logs differ across processes`);
    assert.equal(
      runs[0].dump,
      readDump(join(dir, expected.registry.dump)),
      `${name}: rebuilt log differs from the committed derived dump`,
    );
    lines.push(
      `fixture=${name} pid-a=${runs[0].pid} pid-b=${runs[1].pid} distinct=true`,
      `fixture=${name} digest=${runs[0].digest} matches-golden=true`,
      `fixture=${name} logs-byte-identical=true matches-committed-derived-dump=true events=${expected.registry.events}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`${name}: goldens re-earned\n`);
}
lines.push("E2_T08_REBUILD_DETERMINISM_OK");

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  // pids vary per run; validate the committed transcript structurally and
  // against the (deterministic) digests just re-earned.
  const committed = readFileSync(evidencePath, "utf8").trim().split("\n");
  assert.equal(committed.at(-1), "E2_T08_REBUILD_DETERMINISM_OK");
  for (const name of fixtures) {
    const expected = JSON.parse(readFileSync(join(fixtureRoot, name, "expected.json"), "utf8"));
    const pidLine = committed.find((line) => line.startsWith(`fixture=${name} pid-a=`));
    assert.ok(pidLine, `committed determinism transcript missing pid line for ${name}`);
    const match = /pid-a=(\d+) pid-b=(\d+) distinct=true/.exec(pidLine);
    assert.ok(match !== null && match[1] !== match[2], `committed pids not distinct: ${pidLine}`);
    assert.ok(
      committed.includes(`fixture=${name} digest=${expected.registry.digest} matches-golden=true`),
      `committed digest line drifted for ${name}`,
    );
  }
  process.stdout.write("e2_t08_evidence: OK\n");
}
