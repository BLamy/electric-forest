import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server } from "node:http";
import { canonicalJson, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkpoint,
  StreamReader,
  StreamSeqConflictError,
  StreamWriter,
  type StreamRecord,
} from "../src/index.js";
import { createHttpServer } from "../../server/src/http.js";
import { MemoryStreamStore } from "../../server/src/store/memory.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

const evidenceDir = process.env.EFOREST_EVIDENCE_DIR;
const evidenceFiles = [
  "e0-t08-batched-dump.jsonl",
  "e0-t08-unbatched-dump.jsonl",
  "e0-t08-cold-read.jsonl",
  "e0-t08-tail-longpoll-prefix.jsonl",
  "e0-t08-tail-longpoll-suffix.jsonl",
  "e0-t08-tail-sse-prefix.jsonl",
  "e0-t08-tail-sse-suffix.jsonl",
  "e0-t08-checkpoints.jsonl",
  "e0-t08-fencing-contested-dump.jsonl",
  "e0-t08-fencing-winner-control-dump.jsonl",
  "e0-t08-fencing-settlements.jsonl",
  "e0-t08-wire-roundtrip-client-to-raw.jsonl",
  "e0-t08-wire-roundtrip-raw-to-client.jsonl",
  "e0-t08-digests.txt",
] as const;

function writeJsonl(name: string, values: readonly unknown[]): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    `${evidenceDir}/${name}`,
    values.map((value) => `${canonicalJson(value)}\n`).join(""),
  );
}

function writeDigest(label: string, left: readonly unknown[], right: readonly unknown[]): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(
    `${evidenceDir}/e0-t08-digests.txt`,
    `${label}\t${stateDigest(left)}\t${stateDigest(right)}\n`,
  );
}

function event(index: number): Event {
  return index % 3 === 0
    ? { type: "set", payload: index, ts: index }
    : index % 3 === 1
      ? { type: "push", payload: `value-${index}`, ts: index }
      : { type: "increment", payload: 1, ts: index };
}

async function startServer(): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server = createHttpServer(new MemoryStreamStore(), {
    longPollTimeoutMs: 40,
    sseHeartbeatMs: 20,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function createStream(baseUrl: string, streamId: string): Promise<void> {
  const response = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId }),
  });
  expect(response.status).toBe(201);
}

async function appendRaw(
  baseUrl: string,
  streamId: string,
  sequence: number,
  events: readonly Event[],
): Promise<readonly StreamRecord[]> {
  const response = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": String(sequence) },
    body: JSON.stringify({ events }),
  });
  expect(response.status).toBe(201);
  const body = JSON.parse(response.body) as { events: readonly StreamRecord[] };
  return body.events;
}

async function dump(baseUrl: string, streamId: string): Promise<readonly StreamRecord[]> {
  const response = await request(baseUrl, `/streams/${encodeURIComponent(streamId)}/dump`);
  expect(response.status).toBe(200);
  return response.body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamRecord);
}

async function collectOne(
  iterator: AsyncIterator<{
    readonly events: readonly StreamRecord[];
    readonly checkpoint: { offset: Offset };
  }>,
): Promise<{ readonly events: readonly StreamRecord[]; readonly checkpoint: { offset: Offset } }> {
  const result = await iterator.next();
  if (result.done || result.value === undefined)
    throw new Error("tail ended before a batch arrived");
  return result.value;
}

describe("typed durable-stream client", () => {
  beforeAll(() => {
    if (!evidenceDir) return;
    mkdirSync(evidenceDir, { recursive: true });
    for (const name of evidenceFiles) {
      const path = `${evidenceDir}/${name}`;
      if (existsSync(path)) rmSync(path);
    }
  });

  afterAll(() => undefined);

  it("keeps batching transparent and preserves append order", async () => {
    const { server, baseUrl } = await startServer();
    try {
      await createStream(baseUrl, "batched");
      await createStream(baseUrl, "unbatched");
      const scripted = Array.from({ length: 7 }, (_, index) => event(index));
      const batched = new StreamWriter({
        baseUrl,
        streamId: "batched",
        batchSize: 3,
        batchWindowMs: 1_000,
      });
      const unbatched = new StreamWriter({
        baseUrl,
        streamId: "unbatched",
        batchSize: 1,
        batchWindowMs: 1_000,
      });
      await Promise.all(scripted.map((value) => batched.append(value)));
      await batched.flush();
      await Promise.all(scripted.map((value) => unbatched.append(value)));
      await unbatched.flush();
      const batchedDump = await dump(baseUrl, "batched");
      const unbatchedDump = await dump(baseUrl, "unbatched");
      expect(batchedDump.map(({ type, payload, ts }) => ({ type, payload, ts }))).toEqual(scripted);
      expect(unbatchedDump.map(({ type, payload, ts }) => ({ type, payload, ts }))).toEqual(
        scripted,
      );
      expect(stateDigest(batchedDump)).toBe(stateDigest(unbatchedDump));
      writeJsonl("e0-t08-batched-dump.jsonl", batchedDump);
      writeJsonl("e0-t08-unbatched-dump.jsonl", unbatchedDump);
      writeDigest("batching", batchedDump, unbatchedDump);
    } finally {
      await stopServer(server);
    }
  });

  it.each(["long-poll", "sse"] as const)(
    "resumes an exact %s tail from a persisted checkpoint",
    async (mode) => {
      const { server, baseUrl } = await startServer();
      try {
        const streamId = `resume-${mode}`;
        await createStream(baseUrl, streamId);
        const prefix = await appendRaw(baseUrl, streamId, 0, [event(10), event(11)]);
        const firstReader = new StreamReader({ baseUrl, streamId, reconnectDelayMs: 1 });
        const firstTail = firstReader.tail(checkpoint("-1" as Offset), { mode });
        const firstBatch = await collectOne(firstTail);
        expect(firstBatch.events).toEqual(prefix);
        const saved = firstBatch.checkpoint;
        await firstTail.return?.(undefined);

        const suffix = await appendRaw(baseUrl, streamId, 1, [event(12), event(13), event(14)]);
        const resumedReader = new StreamReader({ baseUrl, streamId, reconnectDelayMs: 1 });
        const resumedTail = resumedReader.tail(saved, { mode });
        const resumedBatch = await collectOne(resumedTail);
        expect(resumedBatch.events).toEqual(suffix);
        expect(resumedBatch.events[0]!.offset > saved.offset).toBe(true);
        await resumedTail.return?.(undefined);

        const cold = await dump(baseUrl, streamId);
        expect(stateDigest([...prefix, ...suffix])).toBe(stateDigest(cold));
        writeJsonl(`e0-t08-tail-${mode === "long-poll" ? "longpoll" : "sse"}-prefix.jsonl`, prefix);
        writeJsonl(`e0-t08-tail-${mode === "long-poll" ? "longpoll" : "sse"}-suffix.jsonl`, suffix);
        writeJsonl("e0-t08-cold-read.jsonl", cold);
        writeJsonl("e0-t08-checkpoints.jsonl", [
          { mode, batch: 0, yieldedCheckpoint: saved, resumedFirstEvent: suffix[0] },
        ]);
        writeDigest(`resume-${mode}`, [...prefix, ...suffix], cold);
      } finally {
        await stopServer(server);
      }
    },
  );

  it("surfaces fencing as a typed error and settles every affected append", async () => {
    const { server, baseUrl } = await startServer();
    try {
      await createStream(baseUrl, "contested");
      await createStream(baseUrl, "winner-control");
      const winnerEvents = [event(20), event(21)];
      const loserEvents = [event(22), event(23)];
      await appendRaw(baseUrl, "contested", 0, winnerEvents);
      const loser = new StreamWriter({
        baseUrl,
        streamId: "contested",
        batchSize: 2,
        batchWindowMs: 1_000,
      });
      const loserPromises = loserEvents.map((value) => loser.append(value));
      const settlements = await Promise.all(
        loserPromises.map(async (promise, index) => {
          try {
            await promise;
            return { index, status: "resolved" as const };
          } catch (error) {
            return {
              index,
              status: "rejected" as const,
              errorClass: error instanceof Error ? error.constructor.name : typeof error,
              streamId: error instanceof StreamSeqConflictError ? error.streamId : undefined,
              sentSequence:
                error instanceof StreamSeqConflictError ? error.sentSequence : undefined,
              responseStatus:
                error instanceof StreamSeqConflictError ? error.response.status : undefined,
            };
          }
        }),
      );
      expect(settlements.every((value) => value.status === "rejected")).toBe(true);
      expect(settlements.every((value) => value.errorClass === "StreamSeqConflictError")).toBe(
        true,
      );
      expect(settlements.every((value) => value.streamId === "contested")).toBe(true);
      expect(settlements.every((value) => value.sentSequence === 0)).toBe(true);
      expect(settlements.every((value) => value.responseStatus === 409)).toBe(true);
      const contested = await dump(baseUrl, "contested");
      const controlWriter = new StreamWriter({
        baseUrl,
        streamId: "winner-control",
        batchSize: 2,
        batchWindowMs: 1_000,
      });
      await Promise.all(winnerEvents.map((value) => controlWriter.append(value)));
      await controlWriter.flush();
      const control = await dump(baseUrl, "winner-control");
      expect(contested.map(({ type, payload, ts }) => ({ type, payload, ts }))).toEqual(
        winnerEvents,
      );
      writeJsonl("e0-t08-fencing-contested-dump.jsonl", contested);
      writeJsonl("e0-t08-fencing-winner-control-dump.jsonl", control);
      writeJsonl("e0-t08-fencing-settlements.jsonl", settlements);
      writeDigest("fencing", contested, control);
    } finally {
      await stopServer(server);
    }
  });

  it("rejects an append whose connection is lost before acknowledgment", async () => {
    const { server, baseUrl } = await startServer();
    try {
      await createStream(baseUrl, "ack-loss");
      const abortingFetch: typeof fetch = async (input, init) => {
        const controller = new AbortController();
        const requestPromise = fetch(input, { ...init, signal: controller.signal });
        controller.abort();
        return requestPromise;
      };
      const writer = new StreamWriter({
        baseUrl,
        streamId: "ack-loss",
        batchSize: 1,
        fetch: abortingFetch,
      });
      await expect(writer.append(event(30))).rejects.toBeDefined();
      const records = await dump(baseUrl, "ack-loss");
      expect(records).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it("round-trips client checkpoints through raw HTTP reads", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const streamId = "wire-roundtrip";
      await createStream(baseUrl, streamId);
      const prefix = await appendRaw(baseUrl, streamId, 0, [event(40), event(41)]);
      const reader = new StreamReader({ baseUrl, streamId });
      const prefixBatch = await collectOne(reader.read("-1" as Offset));
      expect(prefixBatch.events).toEqual(prefix);
      await appendRaw(baseUrl, streamId, 1, [event(42), event(43)]);
      const headResponse = await request(baseUrl, `/streams/${streamId}?offset=-1`);
      const head = headResponse.headers.get("stream-next-offset");
      expect(head).toBeTruthy();
      const rawSuffixResponse = await request(
        baseUrl,
        `/streams/${streamId}?offset=${encodeURIComponent(prefixBatch.checkpoint.offset)}`,
      );
      const rawSuffix = JSON.parse(rawSuffixResponse.body) as readonly StreamRecord[];
      const clientSuffix = await collectOne(reader.read(prefixBatch.checkpoint));
      expect(clientSuffix.events).toEqual(rawSuffix);
      expect(stateDigest(clientSuffix.events)).toBe(stateDigest(rawSuffix));
      const rawOffset = rawSuffix[0]!.offset;
      const clientFromRaw = await collectOne(reader.read(rawOffset));
      const rawFromRaw = JSON.parse(
        (await request(baseUrl, `/streams/${streamId}?offset=${encodeURIComponent(rawOffset)}`))
          .body,
      ) as readonly StreamRecord[];
      expect(clientFromRaw.events).toEqual(rawFromRaw);
      writeJsonl("e0-t08-wire-roundtrip-client-to-raw.jsonl", [
        { head, clientCheckpoint: prefixBatch.checkpoint, rawSuffix },
      ]);
      writeJsonl("e0-t08-wire-roundtrip-raw-to-client.jsonl", [
        { rawOffset, clientSuffix: clientFromRaw.events, rawSuffix: rawFromRaw },
      ]);
    } finally {
      await stopServer(server);
    }
  });
});
