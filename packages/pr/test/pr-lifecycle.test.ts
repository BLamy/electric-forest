import { readFileSync } from "node:fs";
import { OFFSET_BEFORE_FIRST, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { reducerForStream, replayWithReducer } from "@eforest/reducers";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalReviews,
  canonicalThreads,
  prInitialState,
  prInitialStateForStream,
  prReducer,
  type PrReview,
  type PrState,
} from "../src/index.js";
import {
  bootstrapPrState,
  event,
  openedPayload,
  prSnapshot,
  startPrHttpFixture,
  type PrHttpFixture,
} from "./helpers.js";

let fixture: PrHttpFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

function at(index: number): Offset {
  return offsetForOrdinal(index);
}

function evidence(name: string): string {
  return readFileSync(
    new URL(
      `../../../.eforest/tasks/epic-5-the-meadow/E5-T02-pr-event-model/evidence/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}

function stateShape(fixtureValue: PrHttpFixture, patch: Partial<PrState> = {}): PrState {
  return {
    v: 1,
    status: "open",
    sourceBranch: fixtureValue.sourceStream,
    targetBranch: fixtureValue.mainStream,
    forkOffset: fixtureValue.forkOffset,
    title: "Add the meadow",
    body: "A replayable proposal",
    author: "alice",
    approvals: [],
    reviews: [],
    threads: [],
    openedAtOffset: at(0),
    resolvedAtOffset: OFFSET_BEFORE_FIRST,
    ...patch,
  };
}

describe("PR lifecycle over the real dispatch door", () => {
  it("folds the six-event merged golden at every application offset", async () => {
    fixture = await startPrHttpFixture();
    const prStream = await fixture.createPr("merged-golden");
    const rootComment = {
      id: at(1),
      kind: "comment" as const,
      author: "bob",
      body: "Please explain the edge",
      path: "src/meadow.ts",
    };
    const changes = {
      id: at(2),
      kind: "changes-requested" as const,
      reviewer: "bob",
      body: "Please add the boundary",
    };
    const reply = {
      id: at(3),
      kind: "comment" as const,
      author: "alice",
      body: "Boundary added",
      replyTo: at(1),
    };
    const approval = { id: at(4), kind: "approved" as const, reviewer: "bob" };
    const steps: readonly {
      readonly event: Event;
      readonly expected: PrState;
    }[] = [
      {
        event: event("pr.opened", openedPayload(fixture), 10),
        expected: stateShape(fixture),
      },
      {
        event: event(
          "pr.review-comment",
          { v: 1, author: "bob", body: rootComment.body, path: rootComment.path },
          11,
        ),
        expected: stateShape(fixture, {
          reviews: [rootComment],
          threads: [{ root: at(1), comments: [rootComment] }],
        }),
      },
      {
        event: event("pr.changes-requested", { v: 1, reviewer: "bob", body: changes.body }, 12),
        expected: stateShape(fixture, {
          reviews: [rootComment, changes],
          threads: [{ root: at(1), comments: [rootComment] }],
        }),
      },
      {
        event: event(
          "pr.review-comment",
          { v: 1, author: "alice", body: reply.body, replyTo: at(1) },
          13,
        ),
        expected: stateShape(fixture, {
          reviews: [rootComment, changes, reply],
          threads: [{ root: at(1), comments: [rootComment, reply] }],
        }),
      },
      {
        event: event("pr.approved", { v: 1, reviewer: "bob" }, 14),
        expected: stateShape(fixture, {
          status: "approved",
          approvals: ["bob"],
          reviews: [rootComment, changes, reply, approval],
          threads: [{ root: at(1), comments: [rootComment, reply] }],
        }),
      },
      {
        event: event("pr.merged", { v: 1, mergedBy: "maintainer" }, 15),
        expected: stateShape(fixture, {
          status: "merged",
          approvals: ["bob"],
          reviews: [rootComment, changes, reply, approval],
          threads: [{ root: at(1), comments: [rootComment, reply] }],
          resolvedAtOffset: at(5),
        }),
      },
    ];

    for (const [index, step] of steps.entries()) {
      const result = await fixture.dispatch(prStream, step.event);
      expect(result.status).toBe(202);
      expect(result.offset).toBe(at(index));
      expect(await bootstrapPrState(fixture.streams, prStream)).toEqual(step.expected);
    }

    const snapshot = await prSnapshot(fixture.streams, prStream);
    expect(snapshot.dump).toBe(evidence("e5-t02-lifecycle-merged.jsonl"));
    expect(snapshot.state).toEqual(steps.at(-1)!.expected);
    expect(snapshot.records.map((record) => record.offset)).toEqual(
      steps.map((_, index) => at(index)),
    );
    const definition = reducerForStream(prStream);
    expect(definition?.id).toBe("pr");
    expect(replayWithReducer(definition!, snapshot.records, prStream)).toEqual({
      state: steps.at(-1)!.expected,
      digest: stateDigest(steps.at(-1)!.expected),
    });
  });

  it("derives approval down, up, and into a legal close", async () => {
    fixture = await startPrHttpFixture();
    const prStream = await fixture.createPr("closed-golden");
    const events = [
      event("pr.opened", openedPayload(fixture), 20),
      event("pr.approved", { v: 1, reviewer: "carol" }, 21),
      event("pr.changes-requested", { v: 1, reviewer: "carol", body: "One more test" }, 22),
      event("pr.approved", { v: 1, reviewer: "carol" }, 23),
      event("pr.closed", { v: 1, closedBy: "alice", reason: "superseded" }, 24),
    ];
    const progression = ["open", "approved", "open", "approved", "closed"] as const;
    const approvals = [[], ["carol"], [], ["carol"], ["carol"]];
    for (const [index, current] of events.entries()) {
      expect((await fixture.dispatch(prStream, current)).status).toBe(202);
      const state = await bootstrapPrState(fixture.streams, prStream);
      expect(state.status).toBe(progression[index]);
      expect(state.approvals).toEqual(approvals[index]);
      expect(state.resolvedAtOffset).toBe(index === 4 ? at(4) : "-1");
    }
    const final = await prSnapshot(fixture.streams, prStream);
    expect(final.dump).toBe(evidence("e5-t02-lifecycle-closed.jsonl"));
    expect(final.state).toEqual(
      stateShape(fixture, {
        status: "closed",
        approvals: ["carol"],
        reviews: [
          { id: at(1), kind: "approved", reviewer: "carol" },
          {
            id: at(2),
            kind: "changes-requested",
            reviewer: "carol",
            body: "One more test",
          },
          { id: at(3), kind: "approved", reviewer: "carol" },
        ],
        resolvedAtOffset: at(4),
      }),
    );
  });

  it("preserves outstanding changes-requested across a canonical JSON state roundtrip", () => {
    const streamId = "pr:maple/reading-room/json-roundtrip";
    const branchMain = "fs:maple/reading-room:main:meta";
    const branchFeature = "fs:maple/reading-room:feature:meta";
    const withOffset = (current: Event, index: number): Event =>
      ({ ...current, offset: at(index) }) as Event;
    let state = prReducer(
      prInitialStateForStream(streamId),
      withOffset(
        event("pr.opened", {
          v: 1,
          sourceBranch: branchFeature,
          targetBranch: branchMain,
          forkOffset: at(0),
          title: "Roundtrip",
          body: "State is the whole machine",
          author: "alice",
        }),
        0,
      ),
    );
    state = prReducer(
      state,
      withOffset(
        event("pr.changes-requested", {
          v: 1,
          reviewer: "carol",
          body: "Hold this open",
        }),
        1,
      ),
    );
    const serialized = JSON.stringify(state);
    const restored = JSON.parse(serialized) as PrState;
    const afterBob = prReducer(
      restored,
      withOffset(event("pr.approved", { v: 1, reviewer: "bob" }), 2),
    );
    expect(afterBob.status).toBe("open");
    expect(afterBob.approvals).toEqual(["bob"]);
    expect(afterBob.reviews).toEqual([
      {
        id: at(1),
        kind: "changes-requested",
        reviewer: "carol",
        body: "Hold this open",
      },
      { id: at(2), kind: "approved", reviewer: "bob" },
    ]);
    const afterCarol = prReducer(
      JSON.parse(JSON.stringify(afterBob)) as PrState,
      withOffset(event("pr.approved", { v: 1, reviewer: "carol" }), 3),
    );
    expect(afterCarol.status).toBe("approved");
    expect(afterCarol.approvals).toEqual(["bob", "carol"]);
  });

  it("is total and deterministic over a hand-built door-illegal dump", () => {
    const withOffset = (current: Event, index: number): Event =>
      ({ ...current, offset: at(index) }) as Event;
    const illegal: readonly Event[] = [
      withOffset(event("pr.approved", { v: 1, reviewer: "bob" }), 0),
      withOffset(
        event("pr.opened", {
          v: 1,
          sourceBranch: "fs:maple/reading-room:feature:meta",
          targetBranch: "fs:maple/reading-room:main:meta",
          forkOffset: at(0),
          title: "Illegal input",
          body: "Reducer remains total",
          author: "alice",
        }),
        1,
      ),
      withOffset(event("pr.approved", { v: 1, reviewer: "bob" }), 2),
      withOffset(event("pr.merged", { v: 1, mergedBy: "alice" }), 3),
      withOffset(event("pr.review-comment", { v: 1, author: "bob", body: "too late" }), 4),
    ];
    const first = illegal.reduce(prReducer, prInitialState);
    const second = illegal.reduce(prReducer, prInitialState);
    expect(first.status).toBe("merged");
    expect(first.openedAtOffset).toBe(at(1));
    expect(first.resolvedAtOffset).toBe(at(3));
    expect(stateDigest(first)).toBe(stateDigest(second));
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it("sorts an out-of-order review union and threads comments only", () => {
    const root = { id: at(1), kind: "comment" as const, author: "a", body: "root" };
    const approval = { id: at(2), kind: "approved" as const, reviewer: "b" };
    const reply = {
      id: at(3),
      kind: "comment" as const,
      author: "c",
      body: "reply",
      replyTo: at(1),
    };
    const changes = {
      id: at(4),
      kind: "changes-requested" as const,
      reviewer: "d",
      body: "change",
    };
    const outOfOrder: readonly PrReview[] = [changes, reply, approval, root];

    expect(canonicalReviews(outOfOrder)).toEqual([root, approval, reply, changes]);
    expect(canonicalThreads(outOfOrder)).toEqual([{ root: at(1), comments: [root, reply] }]);
  });

  it("no-ops a reply whose existing parent is not lexically earlier", () => {
    const withOffset = (current: Event, offset: Offset): Event => ({ ...current, offset }) as Event;
    let state = prReducer(
      prInitialState,
      withOffset(
        event("pr.opened", {
          v: 1,
          sourceBranch: "fs:maple/reading-room:feature:meta",
          targetBranch: "fs:maple/reading-room:main:meta",
          forkOffset: at(0),
          title: "Backwards reply",
          body: "Reducer totality",
          author: "alice",
        }),
        at(0),
      ),
    );
    state = prReducer(
      state,
      withOffset(event("pr.review-comment", { v: 1, author: "bob", body: "future parent" }), at(5)),
    );
    const beforeReply = state;
    const afterReply = prReducer(
      state,
      withOffset(
        event("pr.review-comment", {
          v: 1,
          author: "carol",
          body: "backwards reply",
          replyTo: at(5),
        }),
        at(4),
      ),
    );

    expect(afterReply).toBe(beforeReply);
    expect(afterReply.reviews).toEqual([
      { id: at(5), kind: "comment", author: "bob", body: "future parent" },
    ]);
  });
});
