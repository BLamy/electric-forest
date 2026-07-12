import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHttpServer } from "../../packages/server/dist/src/index.js";

const outputPath = process.argv[2];
const root = resolve(process.cwd());

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventDigest(value) {
  return digest(JSON.stringify({ type: value.type, payload: value.payload, ts: value.ts }));
}

function headersFor(response) {
  return response.headers.get("stream-seq");
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, streamSeq: headersFor(response), body: await response.text() };
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
  const runs = [];
  const tempRoot = mkdtempSync(join("/tmp", "eforest-independent-races-"));
  const checker = resolve(root, "tools/verify/check_race.mjs");

  try {
    for (let run = 0; run < 12; run += 1) {
      const streamPath = `/streams/fresh-race-${run}`;
      let response = await request(base, streamPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run, source: "fresh-independent-race" }),
      });
      assert(response.status === 201, `run ${run} create returned ${response.status}`);
      const attempts = [];
      for (let sequence = 0; sequence < 4; sequence += 1) {
        const events = [0, 1].map((writer) => ({
          type: "fresh-race",
          payload: { marker: `independent-${run}-${sequence}-${writer}`, run, sequence, writer },
          ts: run * 100 + sequence,
        }));
        const responses = await Promise.all(
          events.map((value) =>
            request(base, streamPath, {
              method: "POST",
              headers: { "content-type": "application/json", "stream-seq": String(sequence) },
              body: JSON.stringify({ events: [value] }),
            }),
          ),
        );
        responses.forEach((result, writer) => {
          attempts.push({
            sequence,
            payloadDigest: eventDigest(events[writer]),
            status: result.status,
            responseSequence: Number(result.streamSeq ?? "NaN"),
          });
        });
      }
      response = await request(base, `${streamPath}/dump`);
      assert(response.status === 200, `run ${run} dump returned ${response.status}`);
      const dumpPath = join(tempRoot, `race-${run}-dump.jsonl`);
      const attemptsPath = join(tempRoot, `race-${run}-attempts.json`);
      writeFileSync(dumpPath, response.body);
      writeFileSync(attemptsPath, `${JSON.stringify(attempts)}\n`);
      const checked = spawnSync(process.execPath, [checker, dumpPath, attemptsPath, "--replay"], {
        cwd: root,
        encoding: "utf8",
      });
      assert(
        checked.status === 0,
        `run ${run} checker failed: ${checked.stderr || checked.stdout}`,
      );
      runs.push({
        run,
        attempts,
        dump: response.body,
        digest: digest(response.body),
        checker: checked.stdout.trim(),
      });
    }
    const evidence = {
      task: "E0-T05",
      run: "fresh-independent-concurrent-races",
      raceCount: runs.length,
      sequenceCount: 4,
      writersPerSequence: 2,
      checkerInvariant:
        "every refused attempt reports exactly the sequence that won the same contest",
      runs,
    };
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, serialized);
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
