import { describe, expect, it } from "vitest";
import { repoPrIndexStreamId } from "@eforest/pr";
import { type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { PrIndexMaterializer, type StreamAdapter } from "../src/index.js";

class MemoryStreams implements StreamAdapter {
  readonly streams = new Map<string, Array<Event & { readonly offset: Offset }>>();

  async create(streamId: string): Promise<void> {
    if (this.streams.has(streamId)) throw new Error("already exists");
    this.streams.set(streamId, []);
  }

  async exists(streamId: string): Promise<boolean> {
    return this.streams.has(streamId);
  }

  async append(
    streamId: string,
    event: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): Promise<"appended"> {
    const records = this.streams.get(streamId);
    if (records === undefined) throw new Error("missing stream");
    records.push({
      ...event,
      offset: options?.applicationOffset ?? offsetForOrdinal(records.length),
    });
    return "appended";
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    const records = this.streams.get(streamId);
    if (records === undefined) throw new Error("missing stream");
    return [...records];
  }

  async readResolved(streamId: string): Promise<readonly unknown[]> {
    return this.read(streamId);
  }

  follow(): AsyncIterable<unknown> {
    return (async function* () {
      yield* [];
    })();
  }
}

function opened(title: string): Event & { readonly offset: Offset } {
  return {
    type: "pr.opened",
    payload: {
      v: 1,
      sourceBranch: "fs:maple/reading-room:feature:meta",
      targetBranch: "fs:maple/reading-room:main:meta",
      forkOffset: offsetForOrdinal(0),
      title,
      body: "body",
      author: "alice",
    },
    ts: 1,
    offset: offsetForOrdinal(0),
  };
}

describe("PrIndexMaterializer", () => {
  it("updates incrementally and rebuilds a deleted derived index from cataloged PR logs", async () => {
    const streams = new MemoryStreams();
    const prStream = "pr:maple/reading-room/42";
    streams.streams.set(prStream, [opened("Live pull request")]);
    const materializer = new PrIndexMaterializer(streams);

    const openedState = await materializer.applyCommittedPr(prStream);
    expect(openedState.rows).toMatchObject([{ prId: "42", status: "open" }]);

    streams.streams.get(prStream)!.push({
      type: "pr.approved",
      payload: { v: 1, reviewer: "bob" },
      ts: 2,
      offset: offsetForOrdinal(1),
    });
    const approved = await materializer.applyCommittedPr(prStream);
    expect(approved.rows[0]).toMatchObject({ prId: "42", status: "approved" });

    streams.streams.delete(repoPrIndexStreamId("maple", "reading-room"));
    const rebuilt = await materializer.materialize("maple", "reading-room");
    expect(rebuilt).toEqual(approved);
  });
});
