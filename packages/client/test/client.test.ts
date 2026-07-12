import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { canonicalJson, replay, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { fixtureInitialState, fixtureReducer } from "@eforest/protocol/fixtures/reducer";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

function appendJsonl(name: string, values: readonly unknown[]): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(
    `${evidenceDir}/${name}`,
    values.map((value) => `${canonicalJson(value)}\n`).join(""),
  );
}

function writeDigest(label: string, left: readonly unknown[], right: readonly unknown[]): void {
  if (!evidenceDir) return;
  const replayDigest = (values: readonly unknown[]) => {
    const events = values.map((value) => {
      const record = value as { type: string; payload: unknown; ts: number };
      return { type: record.type, payload: record.payload, ts: record.ts };
    });
    return stateDigest(replay(events, fixtureReducer, fixtureInitialState));
  };
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(
    `${evidenceDir}/e0-t08-digests.txt`,
    `${label}\t${replayDigest(left)}\t${replayDigest(right)}\n`,
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

async function waitForFile(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `tail worker exited before writing ${path} (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function killProcess(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === "SIGKILL") resolveExit();
      else reject(new Error(`tail worker exited before SIGKILL (code=${code}, signal=${signal})`));
    });
    if (!child.kill("SIGKILL")) reject(new Error("tail worker could not be SIGKILLed"));
  });
}

async function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0 && child.signalCode === null) return;
    throw new Error(
      `resumed tail worker failed (code=${child.exitCode}, signal=${child.signalCode})`,
    );
  }
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolveExit();
      else reject(new Error(`resumed tail worker failed (code=${code}, signal=${signal})`));
    });
  });
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
        const repo = resolve(process.cwd());
        expect(existsSync(join(repo, "packages/client/dist/src/index.js"))).toBe(true);
        const work = mkdtempSync(join(tmpdir(), `eforest-client-${mode}-`));
        const checkpointPath = join(work, "checkpoint.json");
        const prefixPath = join(work, "prefix.json");
        const suffixPath = join(work, "suffix.json");
        const worker = join(repo, "packages/client/test/tail-worker.mjs");
        const firstTailProcess = spawn(
          process.execPath,
          [worker, baseUrl, streamId, mode, "prefix", checkpointPath, prefixPath],
          { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
        );
        firstTailProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));
        await waitForFile(checkpointPath, firstTailProcess);
        expect(JSON.parse(readFileSync(prefixPath, "utf8"))).toEqual(prefix);
        const saved = JSON.parse(readFileSync(checkpointPath, "utf8")) as { offset: Offset };
        await killProcess(firstTailProcess);

        const suffix = await appendRaw(baseUrl, streamId, 1, [event(12), event(13), event(14)]);
        const resumedTailProcess = spawn(
          process.execPath,
          [worker, baseUrl, streamId, mode, "resume", checkpointPath, suffixPath],
          { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
        );
        resumedTailProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));
        await waitForFile(suffixPath, resumedTailProcess);
        await waitForSuccessfulExit(resumedTailProcess);
        const resumedEvents = JSON.parse(
          readFileSync(suffixPath, "utf8"),
        ) as readonly StreamRecord[];
        expect(resumedEvents).toEqual(suffix);
        expect(resumedEvents[0]!.offset > saved.offset).toBe(true);

        const cold = await dump(baseUrl, streamId);
        expect(stateDigest([...prefix, ...suffix])).toBe(stateDigest(cold));
        writeJsonl(`e0-t08-tail-${mode === "long-poll" ? "longpoll" : "sse"}-prefix.jsonl`, prefix);
        writeJsonl(`e0-t08-tail-${mode === "long-poll" ? "longpoll" : "sse"}-suffix.jsonl`, suffix);
        writeJsonl("e0-t08-cold-read.jsonl", cold);
        appendJsonl("e0-t08-checkpoints.jsonl", [
          {
            mode,
            batch: 0,
            yieldedCheckpoint: saved,
            resumedFirstEvent: suffix[0],
            signal: "SIGKILL",
          },
        ]);
        writeDigest(`resume-${mode}`, [...prefix, ...suffix], cold);
      } finally {
        await stopServer(server);
      }
    },
    20_000,
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
      expect(rawSuffix.at(-1)!.offset).toBe(head);
      const clientTail = reader.tail(prefixBatch.checkpoint, { mode: "long-poll" });
      const clientSuffix = await collectOne(clientTail);
      await clientTail.return?.(undefined);
      expect(clientSuffix.events).toEqual(rawSuffix);
      expect(clientSuffix.events.at(-1)!.offset).toBe(head);
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

  it("reconnects after long-poll transport loss and rejects empty SSE frames", async () => {
    const { server, baseUrl } = await startServer();
    try {
      await createStream(baseUrl, "transport-retry");
      const records = await appendRaw(baseUrl, "transport-retry", 0, [event(50)]);
      let attempts = 0;
      const retryingFetch: typeof fetch = async (input, init) => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated long-poll socket loss");
        return fetch(input, init);
      };
      const reader = new StreamReader({
        baseUrl,
        streamId: "transport-retry",
        reconnectDelayMs: 1,
        fetch: retryingFetch,
      });
      const tail = reader.tail("-1" as Offset, { mode: "long-poll" });
      expect((await collectOne(tail)).events).toEqual(records);
      await tail.return?.(undefined);
      expect(attempts).toBeGreaterThanOrEqual(2);

      const malformedFetch: typeof fetch = async () =>
        new Response("id: 0000000000000000_0000000000000000\ndata: []\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      const malformedReader = new StreamReader({
        baseUrl,
        streamId: "transport-retry",
        fetch: malformedFetch,
      });
      await expect(malformedReader.tail("-1" as Offset, { mode: "sse" }).next()).rejects.toThrow(
        "SSE frame has no event records",
      );
    } finally {
      await stopServer(server);
    }
  });
});
