import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { treeDigest, type FsTree } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import {
  applyProjectionBatch,
  runStreamReducer,
  StreamReducerFailure,
  type StreamReducerResult,
} from "./useStreamReducer.js";
import { streamFsReducerDefinition } from "@eforest/reducers";

const streamId = "fs:maple/reading-room:main:meta";
const reducer = { id: "streamfs", version: 2 };
const event = (ordinal: number, path: string) => ({
  type: "fs.dir.create",
  payload: { v: 2, path },
  ts: ordinal + 1,
  offset: offsetForOrdinal(ordinal),
});
const initial: StreamReducerResult = {
  state: streamFsReducerDefinition.initialState,
  checkpoint: OFFSET_BEFORE_FIRST,
  digest: streamFsReducerDefinition.digest(streamFsReducerDefinition.initialState),
  status: "loading",
};

describe("useStreamReducer application checkpoints", () => {
  it("folds each canonical event once and exposes the independent tree digest", () => {
    const result = applyProjectionBatch(streamFsReducerDefinition, initial, {
      events: [event(0, "docs"), event(1, "src")],
      checkpoint: offsetForOrdinal(1),
      reducer,
    });
    expect((result.state as FsTree).dirs).toHaveProperty("docs");
    expect((result.state as FsTree).dirs).toHaveProperty("src");
    expect(result.digest).toBe(treeDigest(result.state as FsTree));
  });

  it.each([
    ["duplicate", [event(0, "docs"), event(0, "src")], offsetForOrdinal(0)],
    ["reordered", [event(0, "docs"), event(1, "src"), event(0, "old")], offsetForOrdinal(0)],
  ])("rejects %s application offsets at the offending offset", (_name, events, offset) => {
    expect(() =>
      applyProjectionBatch(streamFsReducerDefinition, initial, {
        events,
        checkpoint: events.at(-1)!.offset,
        reducer,
      }),
    ).toThrowError(new StreamReducerFailure(offset, "duplicate or out-of-order application event"));
  });

  it("rejects a truncated batch whose checkpoint advances past its final event", () => {
    expect(() =>
      applyProjectionBatch(streamFsReducerDefinition, initial, {
        events: [event(0, "docs")],
        checkpoint: offsetForOrdinal(2),
        reducer,
      }),
    ).toThrow(/checkpoint does not match final event.*0000000000000002/);
  });

  it("rejects an interior gap during bootstrap at the exact missing offset", () => {
    expect(() =>
      applyProjectionBatch(streamFsReducerDefinition, initial, {
        events: [event(0, "docs"), event(2, "src")],
        checkpoint: offsetForOrdinal(2),
        reducer,
      }),
    ).toThrowError(
      new StreamReducerFailure(
        offsetForOrdinal(1),
        `missing application event before observed offset ${offsetForOrdinal(2)}`,
      ),
    );
  });

  it("rejects an interior gap during follow at the exact missing offset", () => {
    const bootstrapped = applyProjectionBatch(streamFsReducerDefinition, initial, {
      events: [event(0, "docs")],
      checkpoint: offsetForOrdinal(0),
      reducer,
    });
    expect(() =>
      applyProjectionBatch(streamFsReducerDefinition, bootstrapped, {
        events: [event(2, "src")],
        checkpoint: offsetForOrdinal(2),
        reducer,
      }),
    ).toThrowError(
      new StreamReducerFailure(
        offsetForOrdinal(1),
        `missing application event before observed offset ${offsetForOrdinal(2)}`,
      ),
    );
  });

  it("bootstraps once and reconnects from the last application checkpoint without reset", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const updates: StreamReducerResult[] = [];
    const replies: Array<Response | Error> = [
      Response.json({
        events: [event(0, "docs")],
        checkpoint: offsetForOrdinal(0),
        reducer,
      }),
      new TypeError("connection reset"),
      Response.json({
        events: [event(1, "src")],
        checkpoint: offsetForOrdinal(1),
        reducer,
      }),
    ];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(String(input));
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (reply === undefined) {
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new DOMException("aborted", "AbortError");
      }
      return reply;
    }) as typeof fetch;

    await runStreamReducer({
      apiPath: "/api/repos/maple/reading-room/main/events",
      streamId,
      reducerId: "streamfs",
      followWaitMs: 1,
      reconnectDelayMs: 0,
      fetch: fetcher,
      signal: controller.signal,
      onUpdate: (result) => {
        updates.push(result);
        if (result.checkpoint === offsetForOrdinal(1)) controller.abort();
      },
    });

    expect(urls.filter((url) => !url.includes("live=1"))).toHaveLength(1);
    expect(urls.slice(1, 3)).toEqual([
      expect.stringContaining(`checkpoint=${encodeURIComponent(offsetForOrdinal(0))}`),
      expect.stringContaining(`checkpoint=${encodeURIComponent(offsetForOrdinal(0))}`),
    ]);
    expect(updates.map(({ status }) => status)).toContain("reconnecting");
    const final = updates.at(-1)!;
    expect((final.state as FsTree).dirs).toHaveProperty("docs");
    expect((final.state as FsTree).dirs).toHaveProperty("src");
    expect(final.digest).toBe(treeDigest(final.state as FsTree));
  });

  it("resumes a retained per-stream checkpoint without replaying from zero", async () => {
    const retained = applyProjectionBatch(streamFsReducerDefinition, initial, {
      events: [event(0, "docs")],
      checkpoint: offsetForOrdinal(0),
      reducer,
    });
    const controller = new AbortController();
    const urls: string[] = [];
    const updates: StreamReducerResult[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) {
        controller.abort();
        return Response.json({
          events: [event(1, "src")],
          checkpoint: offsetForOrdinal(1),
          reducer,
        });
      }
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;

    await runStreamReducer({
      apiPath: "/api/repos/maple/reading-room/feature/events",
      streamId: "fs:maple/reading-room:feature:meta",
      reducerId: "streamfs",
      followWaitMs: 1,
      reconnectDelayMs: 0,
      fetch: fetcher,
      signal: controller.signal,
      initialResult: retained,
      onUpdate: (result) => updates.push(result),
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`live=1&checkpoint=${encodeURIComponent(offsetForOrdinal(0))}`);
    expect((updates.at(-1)!.state as FsTree).dirs).toHaveProperty("src");
  });
});
