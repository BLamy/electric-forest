import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canonicalJson, type Event } from "@eforest/protocol";
import { createHttpServer } from "./http.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

interface TestRequest {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function startServer(): Promise<{
  server: ReturnType<typeof createHttpServer>;
  base: string;
}> {
  const server = createHttpServer();
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolveStop, reject) => {
    server.close((error) => (error ? reject(error) : resolveStop()));
  });
}

async function request(base: string, path: string, init: TestRequest = {}): Promise<TestResponse> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function json(body: string): unknown {
  return JSON.parse(body) as unknown;
}

function eventDigest(event: Event): string {
  return createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex");
}

describe("durable stream HTTP protocol", () => {
  it("covers create, append, fencing, reads, dump, and log-neutral errors", async () => {
    const { server, base } = await startServer();
    try {
      const config = { name: "alpha", version: 1 };
      const created = await request(base, "/streams/alpha", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      expect(created.status).toBe(201);
      expect(json(created.body)).toMatchObject({ created: true, stream: "alpha", streamSeq: -1 });

      const repeated = await request(base, "/streams/alpha", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      expect(repeated.status).toBe(200);
      expect(json(repeated.body)).toMatchObject({ created: false, streamSeq: -1 });

      const conflict = await request(base, "/streams/alpha", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, version: 2 }),
      });
      expect(conflict.status).toBe(409);

      const events: Event[] = [
        { type: "set", payload: 2, ts: 1 },
        { type: "push", payload: "first", ts: 2 },
      ];
      const appended = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: JSON.stringify({ events }),
      });
      expect(appended.status).toBe(201);
      expect(appended.headers.get("stream-seq")).toBe("0");
      const appendedRecords = json(appended.body) as { events: Array<{ offset: string }> };
      expect(appendedRecords.events).toHaveLength(2);

      const advanced = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "1" },
        body: JSON.stringify({
          events: [{ type: "advance", payload: "second-batch", ts: 3 }],
        }),
      });
      expect(advanced.status).toBe(201);
      expect(advanced.headers.get("stream-seq")).toBe("1");

      const beforeRejectedAppend = await request(base, "/streams/alpha/dump");

      const replayedSequence = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: JSON.stringify({ events: [events[0]] }),
      });
      expect(replayedSequence.status).toBe(409);
      expect(replayedSequence.headers.get("stream-seq")).toBe("1");

      const currentSequenceReplay = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "1" },
        body: JSON.stringify({ events: [events[0]] }),
      });
      expect(currentSequenceReplay.status).toBe(409);
      expect(currentSequenceReplay.headers.get("stream-seq")).toBe("1");
      expect((await request(base, "/streams/alpha/dump")).body).toBe(beforeRejectedAppend.body);

      const staleSequence = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "-1" },
        body: JSON.stringify({ events: [events[0]] }),
      });
      expect(staleSequence.status).toBe(400);
      expect((await request(base, "/streams/alpha/dump")).body).toBe(beforeRejectedAppend.body);

      const all = await request(base, "/streams/alpha?offset=-1");
      expect(all.status).toBe(200);
      const allRecords = json(all.body) as Array<{ offset: string }>;
      expect(allRecords).toHaveLength(3);
      expect(all.headers.get("stream-next-offset")).toBe(allRecords[2]?.offset);

      const mid = await request(
        base,
        `/streams/alpha?offset=${encodeURIComponent(allRecords[0]!.offset)}`,
      );
      expect(mid.status).toBe(200);
      expect(json(mid.body)).toEqual([allRecords[1], allRecords[2]]);

      const beforeFirstPrefix = await request(
        base,
        "/streams/alpha?offset=0000000000000000_000000000000000",
      );
      expect(beforeFirstPrefix.status).toBe(200);
      expect(json(beforeFirstPrefix.body)).toEqual(allRecords);

      const pastHead = await request(
        base,
        "/streams/alpha?offset=9999999999999999_9999999999999999",
      );
      expect(pastHead.status).toBe(200);
      expect(json(pastHead.body)).toEqual([]);
      expect(pastHead.headers.get("stream-next-offset")).toBe(allRecords[2]?.offset);

      const malformedOffset = await request(base, "/streams/alpha?offset=-2");
      expect(malformedOffset.status).toBe(400);
      const emptyOffset = await request(base, "/streams/alpha?offset=");
      expect(emptyOffset.status).toBe(400);

      const beforeMalformedBody = await request(base, "/streams/alpha/dump");
      const malformedBody = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "2" },
        body: JSON.stringify({
          events: [{ type: "accepted", payload: true, ts: 3 }, { type: "broken" }],
        }),
      });
      expect(malformedBody.status).toBe(400);
      const afterMalformedBody = await request(base, "/streams/alpha/dump");
      expect(afterMalformedBody.body).toBe(beforeMalformedBody.body);

      const wrongContentType = await request(base, "/streams/alpha", {
        method: "POST",
        headers: { "content-type": "text/plain", "stream-seq": "2" },
        body: JSON.stringify({ events: [events[0]] }),
      });
      expect(wrongContentType.status).toBe(400);

      const missing = await request(base, "/streams/missing?offset=-1");
      expect(missing.status).toBe(404);

      const dump = await request(base, "/streams/alpha/dump");
      expect(dump.status).toBe(200);
      expect(dump.headers.get("content-type")).toContain("application/x-ndjson");
      expect(dump.body).toBe(allRecords.map((record) => canonicalJson(record)).join("\n") + "\n");
    } finally {
      await stopServer(server);
    }

    const restarted = await startServer();
    try {
      expect((await request(restarted.base, "/streams/alpha?offset=-1")).status).toBe(404);
    } finally {
      await stopServer(restarted.server);
    }
  });

  it("proves twenty independent concurrent-writer races with an invariant checker", async () => {
    const { server, base } = await startServer();
    const checker = resolve(process.cwd(), "tools/verify/check_race.mjs");
    const work = resolve(process.cwd(), "packages/server/work");
    mkdirSync(work, { recursive: true });
    try {
      for (let run = 0; run < 20; run += 1) {
        const streamId = `race-${run}`;
        const created = await request(base, `/streams/${streamId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run }),
        });
        expect(created.status).toBe(201);
        const attempts: Array<{
          sequence: number;
          payloadDigest: string;
          status: number;
          responseSequence: number;
        }> = [];

        for (let sequence = 0; sequence < 3; sequence += 1) {
          const events: Event[] = [0, 1].map((writer) => ({
            type: "race",
            payload: { run, sequence, writer },
            ts: run * 10 + sequence,
          }));
          const responses = await Promise.all(
            events.map((event) =>
              request(base, `/streams/${streamId}`, {
                method: "POST",
                headers: { "content-type": "application/json", "stream-seq": String(sequence) },
                body: JSON.stringify({ events: [event] }),
              }),
            ),
          );
          responses.forEach((response, index) => {
            const responseSequence = Number(response.headers.get("stream-seq") ?? "NaN");
            attempts.push({
              sequence,
              payloadDigest: eventDigest(events[index]!),
              status: response.status,
              responseSequence,
            });
          });
        }

        const dump = await request(base, `/streams/${streamId}/dump`);
        expect(dump.status).toBe(200);
        const temp = mkdtempSync(join(tmpdir(), "eforest-race-"));
        const dumpPath = join(temp, "dump.jsonl");
        const attemptsPath = join(temp, "attempts.json");
        writeFileSync(dumpPath, dump.body);
        writeFileSync(attemptsPath, JSON.stringify(attempts));
        const checked = spawnSync(
          process.execPath,
          [checker, dumpPath, attemptsPath, "--skip-replay"],
          {
            cwd: process.cwd(),
            encoding: "utf8",
          },
        );
        expect(checked.status, checked.stderr || checked.stdout).toBe(0);
        writeFileSync(join(work, `race-${run}-dump.jsonl`), dump.body);
        writeFileSync(
          join(work, `race-${run}-attempts.json`),
          JSON.stringify(attempts, null, 2) + "\n",
        );
        rmSync(temp, { recursive: true, force: true });
      }
    } finally {
      await stopServer(server);
    }
  }, 60_000);
});
