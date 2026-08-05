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

    const retained = await responseJson(await fetch(`${streamUrl}/dump`));
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

const dataDir = await mkdtemp(join(tmpdir(), "eforest-e4-t03-provider-"));
try {
  await exercise("memory", {}, false);
  await exercise("file", { dataDir }, true);
  console.log("E4_T03_PROVIDER_OK memory=410 file=410-after-restart");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
