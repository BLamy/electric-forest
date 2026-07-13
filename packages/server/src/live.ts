import type { IncomingMessage, ServerResponse } from "node:http";
import { compareOffsets, type Offset } from "@eforest/protocol";
import type { StreamRecord, StreamStore } from "./store/types.js";

export interface LiveReadOptions {
  readonly longPollTimeoutMs: number;
  readonly sseHeartbeatMs: number;
}

function recordsAfter(
  records: readonly StreamRecord[],
  after: Offset,
  inclusive: boolean,
): readonly StreamRecord[] {
  return records.filter((record) =>
    inclusive
      ? compareOffsets(record.offset, after) >= 0
      : compareOffsets(record.offset, after) > 0,
  );
}

function writeRecords(
  response: ServerResponse,
  records: readonly StreamRecord[],
  head: Offset,
): void {
  const body = JSON.stringify(records);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "stream-next-offset": String(head),
  });
  response.end(body);
}

function writeTimeout(response: ServerResponse, head: Offset): void {
  response.writeHead(204, {
    "content-length": "0",
    "stream-next-offset": String(head),
  });
  response.end();
}

export function handleLongPoll(
  request: IncomingMessage,
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  after: Offset,
  timeoutMs: number,
  inclusive = false,
): void {
  const initial = store.read(streamId, after, inclusive);
  if (initial.length > 0) {
    writeRecords(response, initial, initial.at(-1)!.offset);
    return;
  }

  let settled = false;
  let unsubscribe = () => {};
  const timer = setTimeout(
    () => finish(() => writeTimeout(response, store.head(streamId))),
    timeoutMs,
  );
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
  const finish = (write: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    write();
  };
  const onAppend = (result: { records: readonly StreamRecord[]; head: Offset }) => {
    const records = recordsAfter(result.records, after, inclusive);
    if (records.length === 0) return;
    finish(() => writeRecords(response, records, records.at(-1)!.offset));
  };

  unsubscribe = store.subscribe(streamId, onAppend);
  request.once("aborted", cleanup);
  response.once("close", cleanup);
  response.once("error", cleanup);
}

function sseFrame(records: readonly StreamRecord[]): string {
  const offset = records.at(-1)!.offset;
  return `id: ${offset}\ndata: ${JSON.stringify(records)}\n\n`;
}

export function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  after: Offset,
  heartbeatMs: number,
  inclusive = false,
): void {
  const initial = store.read(streamId, after, inclusive);
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();

  let closed = false;
  let lastOffset = after;
  let unsubscribe = () => {};
  let heartbeat: NodeJS.Timeout | undefined;
  const armHeartbeat = () => {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      if (closed) return;
      response.write(": keep-alive\n\n");
      armHeartbeat();
    }, heartbeatMs);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearTimeout(heartbeat);
    unsubscribe();
  };
  const send = (records: readonly StreamRecord[]) => {
    if (closed || records.length === 0) return;
    const filtered = recordsAfter(records, lastOffset, inclusive);
    if (filtered.length === 0) return;
    lastOffset = filtered.at(-1)!.offset;
    response.write(sseFrame(filtered));
    armHeartbeat();
  };

  send(initial);
  unsubscribe = store.subscribe(streamId, (result) => send(result.records));
  armHeartbeat();
  request.once("aborted", cleanup);
  response.once("close", cleanup);
  response.once("error", cleanup);
}
