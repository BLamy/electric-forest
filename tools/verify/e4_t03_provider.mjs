#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const providerModule = await import(
  `${
    pathToFileURL(
      resolve(root, "packages/server/node_modules/@durable-streams/server/dist/index.js"),
    ).href
  }?e4-t03-provider`
);
const { DurableStreamTestServer } = providerModule;

async function responseJson(response) {
  const text = await response.text();
  assert.notEqual(text.length, 0, `provider returned an empty response for ${response.url}`);
  return JSON.parse(text);
}

async function exercise(label, options, expectRestart) {
  const streamId = `e4-t03-provider-${label}`;
  const startServer = () => new DurableStreamTestServer({ host: "127.0.0.1", port: 0, ...options });
  let server = startServer();
  const baseUrl = await server.start();
  const streamUrl = `${baseUrl}/streams/${encodeURIComponent(streamId)}`;

  try {
    const created = await fetch(streamUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
    });
    assert.equal(created.status, 201);

    for (const value of ["before", "snapshot", "tail"]) {
      const appended = await fetch(streamUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value, headers: { operation: "write" } }),
      });
      assert.ok(appended.status === 201 || appended.status === 204);
    }

    const beforeCompaction = await responseJson(await fetch(streamUrl));
    assert.equal(beforeCompaction.length, 3);
    const firstOffset = beforeCompaction[0]?.headers?.offset;
    const snapshotOffset = beforeCompaction[1]?.headers?.offset;
    assert.match(firstOffset, /^\d+_\d+$/);
    assert.match(snapshotOffset, /^\d+_\d+$/);

    const compacted = await fetch(`${streamUrl}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotOffset }),
    });
    assert.equal(compacted.status, 200);
    assert.equal((await responseJson(compacted)).snapshotOffset, snapshotOffset);

    const gone = await fetch(`${streamUrl}?offset=${encodeURIComponent(firstOffset)}`);
    assert.equal(gone.status, 410);
    assert.equal(gone.headers.get("stream-snapshot-offset"), snapshotOffset);
    assert.equal((await responseJson(gone)).snapshotOffset, snapshotOffset);

    const retainedResponse = await fetch(`${streamUrl}/dump`);
    const retained = await responseJson(retainedResponse);
    const advertisedTransportOffsets = JSON.parse(
      retainedResponse.headers.get("stream-dump-offsets") ?? "null",
    );
    assert.ok(Array.isArray(advertisedTransportOffsets));
    assert.equal(advertisedTransportOffsets.length, retained.length);
    assert.ok(advertisedTransportOffsets.every((offset) => /^\d+_\d+$/.test(offset)));
    assert.deepEqual(
      retained.map((record) => record.value),
      ["tail"],
      `${label} provider dump did not retain only the post-snapshot tail`,
    );

    if (expectRestart) {
      await server.stop();
      server = startServer();
      const restartedUrl = await server.start();
      const restartedStreamUrl = `${restartedUrl}/streams/${encodeURIComponent(streamId)}`;
      const afterRestartGone = await fetch(
        `${restartedStreamUrl}?offset=${encodeURIComponent(firstOffset)}`,
      );
      assert.equal(afterRestartGone.status, 410);
      assert.equal(
        (await responseJson(await fetch(`${restartedStreamUrl}/dump`)))[0]?.value,
        "tail",
      );
    }
  } finally {
    await server.stop();
  }
}

async function exerciseForkBoundaries(label, options) {
  const server = new DurableStreamTestServer({ host: "127.0.0.1", port: 0, ...options });
  const baseUrl = await server.start();
  const parentId = `e4-t03-provider-${label}-fork-parent`;
  const forkId = `e4-t03-provider-${label}-fork-active`;
  const staleForkId = `e4-t03-provider-${label}-fork-stale`;
  const parentUrl = `${baseUrl}/streams/${encodeURIComponent(parentId)}`;
  const forkUrl = `${baseUrl}/streams/${encodeURIComponent(forkId)}`;
  try {
    assert.equal(
      (
        await fetch(parentUrl, {
          method: "PUT",
          headers: { "content-type": "application/json" },
        })
      ).status,
      201,
    );
    for (const value of ["before", "snapshot", "tail"]) {
      const response = await fetch(parentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value, headers: { operation: "write" } }),
      });
      assert.ok(response.status === 201 || response.status === 204);
    }
    const records = await responseJson(await fetch(parentUrl));
    const firstOffset = records[0]?.headers?.offset;
    const snapshotOffset = records[1]?.headers?.offset;
    assert.match(firstOffset, /^\d+_\d+$/);
    assert.match(snapshotOffset, /^\d+_\d+$/);

    const activeFork = await fetch(forkUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "Stream-Forked-From": new URL(parentUrl).pathname,
        "Stream-Fork-Offset": firstOffset,
      },
    });
    assert.equal(activeFork.status, 201);
    const forkCompaction = await fetch(`${forkUrl}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotOffset: firstOffset }),
    });
    assert.equal(forkCompaction.status, 409);
    assert.equal(await forkCompaction.text(), "Cannot compact a forked stream");
    const blocked = await fetch(`${parentUrl}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotOffset }),
    });
    assert.equal(blocked.status, 409);

    assert.equal((await fetch(forkUrl, { method: "DELETE" })).status, 204);
    assert.equal(
      (
        await fetch(`${parentUrl}/compact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ snapshotOffset }),
        })
      ).status,
      200,
    );

    const staleFork = await fetch(`${baseUrl}/streams/${encodeURIComponent(staleForkId)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "Stream-Forked-From": new URL(parentUrl).pathname,
        "Stream-Fork-Offset": firstOffset,
      },
    });
    assert.equal(staleFork.status, 400);

    assert.equal((await fetch(parentUrl)).status, 410);
    assert.equal((await fetch(`${parentUrl}?offset=-1`)).status, 410);
    return { active: blocked.status, forked: forkCompaction.status, stale: staleFork.status };
  } finally {
    await server.stop();
  }
}

const dataDir = await mkdtemp(join(tmpdir(), "eforest-e4-t03-provider-"));
const forkDataDir = await mkdtemp(join(tmpdir(), "eforest-e4-t03-provider-forks-"));
try {
  await exercise("memory", {}, false);
  await exercise("file", { dataDir }, true);
  const memoryForkGuards = await exerciseForkBoundaries("memory", {});
  const fileForkGuards = await exerciseForkBoundaries("file", { dataDir: forkDataDir });
  assert.deepEqual(memoryForkGuards, { active: 409, forked: 409, stale: 400 });
  assert.deepEqual(fileForkGuards, { active: 409, forked: 409, stale: 400 });
  console.log(
    "E4_T03_PROVIDER_OK memory=410 file=410-after-restart fork-guards=memory:409/409/400,file:409/409/400",
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await rm(forkDataDir, { recursive: true, force: true });
}
