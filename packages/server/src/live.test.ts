import { type Server } from "node:http";
import { compareOffsets, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import { createHttpServer, type HttpServerOptions } from "./http.js";
import { MemoryStreamStore } from "./store/memory.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

interface SseFrame {
  readonly id: Offset;
  readonly records: readonly Record<string, unknown>[];
}

async function startServer(options: HttpServerOptions = {}): Promise<{
  readonly server: Server;
  readonly base: string;
}> {
  const server = createHttpServer(new MemoryStreamStore(), options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<TestResponse> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function append(base: string, streamId: string, sequence: number, events: readonly Event[]) {
  return request(base, `/streams/${streamId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": String(sequence) },
    body: JSON.stringify({ events }),
  });
}

async function create(base: string, streamId: string): Promise<void> {
  const response = await request(base, `/streams/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId }),
  });
  expect(response.status).toBe(201);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectLongPoll(
  base: string,
  streamId: string,
  expectedRecords: number,
  startOffset: Offset = "-1" as Offset,
): Promise<{
  readonly records: readonly Record<string, unknown>[];
  readonly responses: readonly TestResponse[];
}> {
  let offset = startOffset;
  const records: Record<string, unknown>[] = [];
  const responses: TestResponse[] = [];
  while (records.length < expectedRecords) {
    const response = await request(
      base,
      `/streams/${streamId}?offset=${encodeURIComponent(offset)}&live=long-poll`,
    );
    responses.push(response);
    if (response.status === 204) {
      offset = response.headers.get("stream-next-offset") as Offset;
      expect(offset).toBeTruthy();
      continue;
    }
    expect(response.status).toBe(200);
    const batch = JSON.parse(response.body) as Record<string, unknown>[];
    expect(batch.length).toBeGreaterThan(0);
    records.push(...batch);
    offset = response.headers.get("stream-next-offset") as Offset;
    expect(offset).toBe(batch.at(-1)?.offset);
  }
  return { records, responses };
}

function parseSseBlocks(text: string): { readonly frames: SseFrame[]; readonly comments: number } {
  const frames: SseFrame[] = [];
  let comments = 0;
  for (const block of text.split("\n\n")) {
    if (block.length === 0) continue;
    if (block.startsWith(":")) {
      comments += 1;
      continue;
    }
    const lines = block.split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!id || !data) continue;
    frames.push({ id: id as Offset, records: JSON.parse(data) as Record<string, unknown>[] });
  }
  return { frames, comments };
}

async function collectSse(
  base: string,
  streamId: string,
  expectedRecords: number,
  startOffset: Offset = "-1" as Offset,
): Promise<{
  readonly records: readonly Record<string, unknown>[];
  readonly frames: readonly SseFrame[];
}> {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/streams/${streamId}?offset=${encodeURIComponent(startOffset)}&live=sse`,
    { signal: controller.signal },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (parseSseBlocks(text).frames.flatMap((frame) => frame.records).length < expectedRecords) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before the expected records arrived");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  const parsed = parseSseBlocks(text);
  return {
    frames: parsed.frames,
    records: parsed.frames.flatMap((frame) => frame.records),
  };
}

async function collectSseWindow(
  base: string,
  streamId: string,
  durationMs: number,
  startOffset: Offset,
): Promise<{ readonly frames: readonly SseFrame[]; readonly comments: number }> {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/streams/${streamId}?offset=${encodeURIComponent(startOffset)}&live=sse`,
    { signal: controller.signal },
  );
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + durationMs;
  let text = "";
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read().then((chunk) => ({ kind: "chunk" as const, chunk })),
        delay(Math.max(1, deadline - Date.now())).then(() => ({ kind: "timeout" as const })),
      ]);
      if (result.kind === "timeout") break;
      if (result.chunk.done) break;
      text += decoder.decode(result.chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return parseSseBlocks(text);
}

describe("live durable stream HTTP modes", () => {
  it("converges long-poll and SSE tails, including exact resume", async () => {
    const { server, base } = await startServer();
    try {
      const streamId = "converge";
      await create(base, streamId);
      const batches: readonly Event[][] = [
        [{ type: "set", payload: 1, ts: 1 }],
        [
          { type: "push", payload: "two", ts: 2 },
          { type: "push", payload: "three", ts: 3 },
        ],
        [{ type: "set", payload: 4, ts: 4 }],
      ];
      const total = batches.reduce((count, batch) => count + batch.length, 0);
      const longPollA = collectLongPoll(base, streamId, total);
      const longPollB = collectLongPoll(base, streamId, total);
      const sseA = collectSse(base, streamId, total);
      const sseB = collectSse(base, streamId, total);
      await delay(30);
      for (const [sequence, batch] of batches.entries()) {
        await delay(20 + sequence * 15);
        expect((await append(base, streamId, sequence, batch)).status).toBe(201);
      }
      const [longPollTailA, longPollTailB, sseTailA, sseTailB] = await Promise.all([
        longPollA,
        longPollB,
        sseA,
        sseB,
      ]);
      const cold = JSON.parse(
        (await request(base, `/streams/${streamId}?offset=-1`)).body,
      ) as Record<string, unknown>[];
      for (const tail of [longPollTailA, longPollTailB, sseTailA, sseTailB]) {
        expect(stateDigest(tail.records)).toBe(stateDigest(cold));
      }
      for (const sse of [sseTailA, sseTailB]) {
        expect(sse.frames).toHaveLength(3);
        expect(sse.frames.map((frame) => frame.id)).toEqual(
          sse.frames.map((frame) => frame.records.at(-1)?.offset),
        );
        for (let index = 1; index < sse.frames.length; index += 1) {
          expect(compareOffsets(sse.frames[index]!.id, sse.frames[index - 1]!.id)).toBeGreaterThan(
            0,
          );
        }
      }

      const first = await collectSse(base, streamId, total, "-1" as Offset);
      const savedOffset = first.frames.at(-1)!.id;
      expect(compareOffsets(savedOffset, "-1" as Offset)).toBeGreaterThan(0);
      expect(
        (await append(base, streamId, 3, [{ type: "push", payload: "five", ts: 5 }])).status,
      ).toBe(201);
      const resumed = await collectSse(base, streamId, 1, savedOffset);
      expect(compareOffsets(resumed.records[0]!.offset as Offset, savedOffset)).toBeGreaterThan(0);
      const resumedCold = JSON.parse(
        (await request(base, `/streams/${streamId}?offset=-1`)).body,
      ) as Record<string, unknown>[];
      expect(stateDigest([...first.records, ...resumed.records])).toBe(stateDigest(resumedCold));
    } finally {
      await stopServer(server);
    }
  }, 20_000);

  it("returns the exact long-poll timeout shape and re-arms from its head", async () => {
    const { server, base } = await startServer({ longPollTimeoutMs: 1_000 });
    try {
      const streamId = "timeout";
      await create(base, streamId);
      const started = performance.now();
      const timeout = await request(base, `/streams/${streamId}?offset=-1&live=long-poll`);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThanOrEqual(1_500);
      expect(timeout.status).toBe(204);
      expect(timeout.body).toBe("");
      expect(timeout.headers.get("stream-next-offset")).toBe("-1");
      expect(
        (await append(base, streamId, 0, [{ type: "set", payload: "after-timeout", ts: 1 }]))
          .status,
      ).toBe(201);
      const resumed = await request(
        base,
        `/streams/${streamId}?offset=${encodeURIComponent(timeout.headers.get("stream-next-offset")!)}&live=long-poll`,
      );
      expect(resumed.status).toBe(200);
      expect(JSON.parse(resumed.body)).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  }, 5_000);

  it("sends heartbeats while quiescent and never wakes tails for rejected appends", async () => {
    const { server, base } = await startServer({ longPollTimeoutMs: 200, sseHeartbeatMs: 50 });
    try {
      const streamId = "fenced";
      await create(base, streamId);
      expect(
        (await append(base, streamId, 0, [{ type: "seed", payload: true, ts: 1 }])).status,
      ).toBe(201);
      const head = JSON.parse((await request(base, `/streams/${streamId}?offset=-1`)).body).at(-1)
        .offset as Offset;
      const longPollPromise = request(
        base,
        `/streams/${streamId}?offset=${encodeURIComponent(head)}&live=long-poll`,
      );
      const ssePromise = collectSseWindow(base, streamId, 260, head);
      await delay(25);
      const rejected = await append(base, streamId, 0, [
        { type: "rejected", payload: true, ts: 2 },
      ]);
      expect(rejected.status).toBe(409);
      const timeout = await longPollPromise;
      expect(timeout.status).toBe(204);
      const sse = await ssePromise;
      expect(sse.frames).toHaveLength(0);
      expect(sse.comments).toBeGreaterThanOrEqual(2);
    } finally {
      await stopServer(server);
    }
  }, 5_000);
});
