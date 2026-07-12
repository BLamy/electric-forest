import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createHttpServer } from "./http.js";
import { FileStreamStore } from "./store/file.js";

async function startFileServer(): Promise<{
  readonly server: Server;
  readonly base: string;
  readonly dataDir: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-file-live-"));
  const server = createHttpServer(new FileStreamStore(dataDir), {
    longPollTimeoutMs: 500,
    sseHeartbeatMs: 100,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("file server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}`, dataDir };
}

async function stopFileServer(server: Server, dataDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(dataDir, { recursive: true, force: true });
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

async function createStream(base: string, streamId: string): Promise<void> {
  const response = await request(base, `/streams/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId }),
  });
  expect(response.status).toBe(201);
}

async function append(
  base: string,
  streamId: string,
  sequence: number,
  payload: unknown,
): Promise<Response> {
  return request(base, `/streams/${streamId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": String(sequence) },
    body: JSON.stringify({ events: [{ type: "set", payload, ts: sequence }] }),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOneSseFrame(
  response: Response,
): Promise<{ readonly id: string; readonly records: unknown[] }> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE ended before a frame");
    text += decoder.decode(chunk.value, { stream: true });
  }
  const block = text.split("\n\n", 1)[0]!;
  const id = block
    .split("\n")
    .find((line) => line.startsWith("id: "))
    ?.slice(4);
  const data = block
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!id || !data) throw new Error("SSE frame missing id or data");
  await reader.cancel();
  return { id, records: JSON.parse(data) as unknown[] };
}

describe("file-backed live modes", () => {
  it("hands a long-poll reader from catch-up to live at the boundary", async () => {
    const { server, base, dataDir } = await startFileServer();
    try {
      await createStream(base, "boundary");
      expect((await append(base, "boundary", 0, "before-boot")).status).toBe(201);
      const before = JSON.parse(await (await request(base, "/streams/boundary?offset=-1")).text());
      const head = before.at(-1).offset;
      const waiting = request(
        base,
        `/streams/boundary?offset=${encodeURIComponent(head)}&live=long-poll`,
      );
      await delay(30);
      expect((await append(base, "boundary", 1, "after-boot")).status).toBe(201);
      const response = await waiting;
      expect(response.status).toBe(200);
      expect(JSON.parse(await response.text())).toHaveLength(1);
    } finally {
      await stopFileServer(server, dataDir);
    }
  });

  it("resumes SSE from a saved offset after a disconnect", async () => {
    const { server, base, dataDir } = await startFileServer();
    try {
      await createStream(base, "resume");
      expect((await append(base, "resume", 0, "prefix")).status).toBe(201);
      const firstResponse = await request(base, "/streams/resume?offset=-1&live=sse");
      const first = await readOneSseFrame(firstResponse);
      const savedOffset = first.id;
      expect((await append(base, "resume", 1, "suffix")).status).toBe(201);
      const resumedResponse = await request(
        base,
        `/streams/resume?offset=${encodeURIComponent(savedOffset)}&live=sse`,
      );
      const resumed = await readOneSseFrame(resumedResponse);
      expect(resumed.records).toHaveLength(1);
      expect((resumed.records[0] as { payload: unknown }).payload).toBe("suffix");
    } finally {
      await stopFileServer(server, dataDir);
    }
  });

  it("makes an append after file-server boot visible to a live reader", async () => {
    const { server, base, dataDir } = await startFileServer();
    try {
      await createStream(base, "boot");
      const waiting = request(base, "/streams/boot?offset=-1&live=sse");
      await delay(30);
      expect((await append(base, "boot", 0, "visible")).status).toBe(201);
      const response = await waiting;
      const frame = await readOneSseFrame(response);
      expect(frame.records).toHaveLength(1);
      expect((frame.records[0] as { payload: unknown }).payload).toBe("visible");
    } finally {
      await stopFileServer(server, dataDir);
    }
  });
});
