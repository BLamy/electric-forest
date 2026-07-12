import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHttpServer } from "../../packages/server/dist/src/index.js";

const outputPath = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function selectedHeaders(headers) {
  const names = ["allow", "content-length", "content-type", "stream-next-offset", "stream-seq"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return {
    status: response.status,
    headers: selectedHeaders(response.headers),
    body: await response.text(),
  };
}

function event(type, payload, ts) {
  return { type, payload, ts };
}

async function main() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "server did not expose a TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const streamPath = "/streams/critic-independent";
  const checks = [];

  const record = (name, method, path, headers, body, response, extra = {}) => {
    checks.push({ name, request: { method, path, headers, body }, response, ...extra });
  };

  try {
    let response = await request(base, streamPath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "fresh-critic", version: 1 }),
    });
    record(
      "create",
      "PUT",
      streamPath,
      { "content-type": "application/json" },
      JSON.stringify({ source: "fresh-critic", version: 1 }),
      response,
    );
    assert(response.status === 201, `create returned ${response.status}`);

    const firstBatch = [event("seed", { branch: "independent" }, 10)];
    response = await request(base, streamPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: JSON.stringify({ events: firstBatch }),
    });
    record(
      "append-sequence-0",
      "POST",
      streamPath,
      { "content-type": "application/json", "stream-seq": "0" },
      JSON.stringify({ events: firstBatch }),
      response,
    );
    assert(response.status === 201, `sequence 0 returned ${response.status}`);

    const secondBatch = [event("set", 2, 20), event("push", "two", 21)];
    response = await request(base, streamPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "1" },
      body: JSON.stringify({ events: secondBatch }),
    });
    record(
      "append-sequence-1",
      "POST",
      streamPath,
      { "content-type": "application/json", "stream-seq": "1" },
      JSON.stringify({ events: secondBatch }),
      response,
    );
    assert(response.status === 201, `sequence 1 returned ${response.status}`);

    const beforeStale = await request(base, `${streamPath}/dump`);
    response = await request(base, streamPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: JSON.stringify({ events: [event("stale", true, 30)] }),
    });
    record(
      "stale-positive-sequence",
      "POST",
      streamPath,
      { "content-type": "application/json", "stream-seq": "0" },
      JSON.stringify({ events: [event("stale", true, 30)] }),
      response,
      { dumpBeforeDigest: sha256(beforeStale.body) },
    );
    assert(response.status === 409, `stale positive returned ${response.status}`);
    assert(
      response.headers["stream-seq"] === "1",
      "stale positive did not report current sequence 1",
    );
    const afterStale = await request(base, `${streamPath}/dump`);
    assert(afterStale.body === beforeStale.body, "stale positive changed the dump");
    checks.at(-1).dumpAfterDigest = sha256(afterStale.body);

    const beforeCurrentReplay = afterStale;
    response = await request(base, streamPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "1" },
      body: JSON.stringify({ events: [event("duplicate", true, 31)] }),
    });
    record(
      "current-sequence-replay",
      "POST",
      streamPath,
      { "content-type": "application/json", "stream-seq": "1" },
      JSON.stringify({ events: [event("duplicate", true, 31)] }),
      response,
      { dumpBeforeDigest: sha256(beforeCurrentReplay.body) },
    );
    assert(response.status === 409, `current sequence replay returned ${response.status}`);
    assert(
      response.headers["stream-seq"] === "1",
      "current sequence replay reported the wrong sequence",
    );
    const afterCurrentReplay = await request(base, `${streamPath}/dump`);
    assert(afterCurrentReplay.body === beforeCurrentReplay.body, "current replay changed the dump");
    checks.at(-1).dumpAfterDigest = sha256(afterCurrentReplay.body);

    const thirdBatch = [event("tail", { n: 3 }, 40)];
    response = await request(base, streamPath, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "2" },
      body: JSON.stringify({ events: thirdBatch }),
    });
    record(
      "append-sequence-2",
      "POST",
      streamPath,
      { "content-type": "application/json", "stream-seq": "2" },
      JSON.stringify({ events: thirdBatch }),
      response,
    );
    assert(response.status === 201, `sequence 2 returned ${response.status}`);

    const all = await request(base, `${streamPath}?offset=-1`);
    record("read-all", "GET", `${streamPath}?offset=-1`, {}, "", all);
    assert(all.status === 200, `read-all returned ${all.status}`);
    const records = JSON.parse(all.body);
    assert(records.length === 4, `read-all returned ${records.length} records instead of 4`);
    const firstOffset = records[0].offset;
    const thirdOffset = records[2].offset;
    const offsetCases = [
      ["read-prefix", "0000000000000000_000000000000000", 4],
      ["read-after-first", firstOffset, 3],
      ["read-after-third", thirdOffset, 1],
      ["read-past-head", "9999999999999999_9999999999999999", 0],
    ];
    for (const [name, offset, expectedLength] of offsetCases) {
      response = await request(base, `${streamPath}?offset=${encodeURIComponent(offset)}`);
      record(name, "GET", `${streamPath}?offset=${encodeURIComponent(offset)}`, {}, "", response);
      assert(response.status === 200, `${name} returned ${response.status}`);
      assert(
        JSON.parse(response.body).length === expectedLength,
        `${name} returned the wrong suffix length`,
      );
    }

    for (const [name, path] of [
      ["read-negative-two", `${streamPath}?offset=-2`],
      ["read-empty-offset", `${streamPath}?offset=`],
      ["read-malformed-offset", `${streamPath}?offset=not-an-offset`],
    ]) {
      response = await request(base, path);
      record(name, "GET", path, {}, "", response);
      assert(response.status === 400, `${name} returned ${response.status}`);
    }

    const rejectedBodies = [
      ["malformed-json", "{", { "content-type": "application/json", "stream-seq": "3" }],
      [
        "empty-events",
        JSON.stringify({ events: [] }),
        { "content-type": "application/json", "stream-seq": "3" },
      ],
      [
        "missing-events",
        JSON.stringify({}),
        { "content-type": "application/json", "stream-seq": "3" },
      ],
      [
        "broken-event",
        JSON.stringify({ events: [event("accepted", true, 50), { type: "broken" }] }),
        { "content-type": "application/json", "stream-seq": "3" },
      ],
      [
        "wrong-content-type",
        JSON.stringify({ events: [event("wrong", true, 51)] }),
        { "content-type": "text/plain", "stream-seq": "3" },
      ],
    ];
    for (const [name, body, headers] of rejectedBodies) {
      const before = await request(base, `${streamPath}/dump`);
      response = await request(base, streamPath, { method: "POST", headers, body });
      record(name, "POST", streamPath, headers, body, response, {
        dumpBeforeDigest: sha256(before.body),
      });
      assert(response.status === 400, `${name} returned ${response.status}`);
      const after = await request(base, `${streamPath}/dump`);
      assert(after.body === before.body, `${name} changed the dump`);
      checks.at(-1).dumpAfterDigest = sha256(after.body);
    }

    response = await request(base, streamPath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "fresh-critic", version: 2 }),
    });
    record(
      "config-conflict",
      "PUT",
      streamPath,
      { "content-type": "application/json" },
      JSON.stringify({ source: "fresh-critic", version: 2 }),
      response,
    );
    assert(response.status === 409, `config conflict returned ${response.status}`);

    response = await request(base, "/streams/independent-missing?offset=-1");
    record("missing-stream", "GET", "/streams/independent-missing?offset=-1", {}, "", response);
    assert(response.status === 404, `missing stream returned ${response.status}`);

    const finalDump = await request(base, `${streamPath}/dump`);
    const evidence = {
      task: "E0-T05",
      run: "fresh-independent-http-fuzz",
      replay: "N/A (server-only task)",
      finalDumpDigest: sha256(finalDump.body),
      finalDump,
      checks,
    };
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, serialized);
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
