import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpServer } from "../../packages/server/dist/src/index.js";
import { FileStreamStore } from "../../packages/server/dist/src/store/file.js";
import { MemoryStreamStore } from "../../packages/server/dist/src/store/memory.js";

const evidencePath = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function headers(response) {
  return Object.fromEntries(
    ["content-length", "content-type", "stream-next-offset", "stream-seq"].flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

async function start(store) {
  const server = createHttpServer(store, { longPollTimeoutMs: 100, sseHeartbeatMs: 50 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "differential server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: headers(response), body: await response.text() };
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-e0-t07-differential-"));
  const memory = await start(new MemoryStreamStore());
  const file = await start(new FileStreamStore(dataDir));
  const checks = [];
  try {
    const requests = [
      [
        "create",
        "/streams/diff",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        },
      ],
      [
        "idempotent",
        "/streams/diff",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        },
      ],
      [
        "append",
        "/streams/diff",
        {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "0" },
          body: JSON.stringify({
            events: [
              { type: "set", payload: 1, ts: 1 },
              { type: "push", payload: "two", ts: 2 },
            ],
          }),
        },
      ],
      [
        "stale-sequence",
        "/streams/diff",
        {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "0" },
          body: JSON.stringify({ events: [{ type: "stale", payload: true, ts: 3 }] }),
        },
      ],
      ["read-all", "/streams/diff?offset=-1", {}],
      ["read-mid", "/streams/diff?offset=0000000000000000_0000000000000000", {}],
      ["malformed-offset", "/streams/diff?offset=-2", {}],
      [
        "malformed-event",
        "/streams/diff",
        {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "1" },
          body: JSON.stringify({ events: [{ type: "broken" }] }),
        },
      ],
      ["dump", "/streams/diff/dump", {}],
    ];
    for (const [name, path, init] of requests) {
      const [memoryResponse, fileResponse] = await Promise.all([
        request(memory.base, path, init),
        request(file.base, path, init),
      ]);
      assert(
        JSON.stringify(memoryResponse) === JSON.stringify(fileResponse),
        `${name} diverged between stores`,
      );
      checks.push({ name, path, response: memoryResponse });
    }
    const result = { task: "E0-T07", checks, parity: "byte-identical status/headers/body" };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (evidencePath) {
      mkdirSync(join(evidencePath, ".."), { recursive: true });
      writeFileSync(evidencePath, serialized);
    }
    process.stdout.write(serialized);
  } finally {
    await Promise.all(
      [memory.server, file.server].map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
