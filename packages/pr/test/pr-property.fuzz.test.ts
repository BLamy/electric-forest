import { readFileSync } from "node:fs";
import { compareOffsets, stateDigest, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { afterEach, describe, expect, it } from "vitest";
import {
  PR_ACTION_TYPES,
  PR_REFUSAL_REASONS,
  prInitialStateForStream,
  prReducer,
  type PrState,
} from "../src/index.js";
import {
  event,
  openedPayload,
  prSnapshot,
  startPrHttpFixture,
  type PrHttpFixture,
} from "./helpers.js";

const SEED_FILE =
  ".eforest/tasks/epic-5-the-meadow/E5-T02-pr-event-model/evidence/e5-t02-seeds.txt";
const SEQUENCES_PER_SEED = 128;

let fixture: PrHttpFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

function committedSeeds(): readonly number[] {
  return readFileSync(SEED_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const seed = Number.parseInt(line, 16);
      if (!Number.isSafeInteger(seed)) throw new TypeError(`invalid property seed: ${line}`);
      return seed >>> 0;
    });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickIndex(random: () => number, length: number): number {
  return Math.floor(random() * length);
}

function arbitraryAction(
  fixtureValue: PrHttpFixture,
  random: () => number,
  sequence: number,
  step: number,
): Event {
  const actionType = PR_ACTION_TYPES[pickIndex(random, PR_ACTION_TYPES.length)]!;
  const ts = sequence * 100 + step;
  if (actionType === "pr.opened") {
    return event(actionType, openedPayload(fixtureValue), ts);
  }
  if (actionType === "pr.review-comment") {
    const replyMode = pickIndex(random, 3);
    return event(
      actionType,
      {
        v: 1,
        author: ["alice", "bob", "carol"][pickIndex(random, 3)]!,
        body: `comment-${sequence}-${step}`,
        ...(pickIndex(random, 3) === 0 ? { path: "src/meadow.ts" } : {}),
        ...(replyMode === 0
          ? {}
          : { replyTo: offsetForOrdinal(pickIndex(random, Math.max(1, step + 3))) }),
      },
      ts,
    );
  }
  if (actionType === "pr.approved") {
    return event(
      actionType,
      { v: 1, reviewer: ["alice", "bob", "carol"][pickIndex(random, 3)]! },
      ts,
    );
  }
  if (actionType === "pr.changes-requested") {
    return event(
      actionType,
      {
        v: 1,
        reviewer: ["alice", "bob", "carol"][pickIndex(random, 3)]!,
        body: `changes-${sequence}-${step}`,
      },
      ts,
    );
  }
  if (actionType === "pr.merged") {
    return event(actionType, { v: 1, mergedBy: "maintainer" }, ts);
  }
  return event(
    actionType,
    {
      v: 1,
      closedBy: "maintainer",
      ...(pickIndex(random, 2) === 0 ? {} : { reason: `close-${sequence}-${step}` }),
    },
    ts,
  );
}

function generatedSequence(
  fixtureValue: PrHttpFixture,
  random: () => number,
  sequence: number,
): readonly Event[] {
  const length = 8 + pickIndex(random, 8);
  const arbitrary = Array.from({ length }, (_, step) =>
    arbitraryAction(fixtureValue, random, sequence, step + 6),
  );
  switch (sequence % 32) {
    case 0:
      return [
        event("pr.opened", openedPayload(fixtureValue), sequence * 100),
        event("pr.approved", { v: 1, reviewer: "bob" }, sequence * 100 + 1),
        event("pr.merged", { v: 1, mergedBy: "maintainer" }, sequence * 100 + 2),
        ...arbitrary,
      ];
    case 1:
      return [
        event("pr.opened", openedPayload(fixtureValue), sequence * 100),
        event("pr.review-comment", { v: 1, author: "bob", body: "root" }, sequence * 100 + 1),
        event(
          "pr.changes-requested",
          { v: 1, reviewer: "bob", body: "change" },
          sequence * 100 + 2,
        ),
        event("pr.approved", { v: 1, reviewer: "bob" }, sequence * 100 + 3),
        event("pr.closed", { v: 1, closedBy: "alice" }, sequence * 100 + 4),
        ...arbitrary,
      ];
    case 2:
      return [
        event("pr.approved", { v: 1, reviewer: "bob" }, sequence * 100),
        event("pr.opened", openedPayload(fixtureValue), sequence * 100 + 1),
        ...arbitrary,
      ];
    default:
      return arbitrary;
  }
}

function mergeEligible(events: readonly Event[]): boolean {
  const verdicts = new Map<string, "approved" | "changes-requested">();
  for (const current of events) {
    if (current.type !== "pr.approved" && current.type !== "pr.changes-requested") continue;
    const reviewer = (current.payload as { readonly reviewer: string }).reviewer;
    verdicts.set(reviewer, current.type === "pr.approved" ? "approved" : "changes-requested");
  }
  const latest = [...verdicts.values()];
  return latest.includes("approved") && !latest.includes("changes-requested");
}

function assertCanonicalState(state: PrState): void {
  expect(state.approvals).toEqual([...new Set(state.approvals)].sort());
  expect(state.reviews.map((review) => review.id)).toEqual(
    state.reviews.map((review) => review.id).sort(compareOffsets),
  );
  expect(state.threads.map((thread) => thread.root)).toEqual(
    state.threads.map((thread) => thread.root).sort(compareOffsets),
  );
  for (const thread of state.threads) {
    expect(thread.comments.length).toBeGreaterThan(0);
    expect(thread.comments.every((comment) => comment.kind === "comment")).toBe(true);
    expect(thread.comments.map((comment) => comment.id)).toEqual(
      thread.comments.map((comment) => comment.id).sort(compareOffsets),
    );
    expect(thread.comments[0]!.id).toBe(thread.root);
  }
}

function assertAcceptedLog(events: readonly Event[]): void {
  if (events.length === 0) return;
  expect(events[0]!.type).toBe("pr.opened");
  let terminal = false;
  for (const [index, current] of events.entries()) {
    expect(terminal, `accepted event after terminal at index ${index}`).toBe(false);
    if (current.type === "pr.merged") {
      expect(mergeEligible(events.slice(0, index))).toBe(true);
    }
    if (current.type === "pr.merged" || current.type === "pr.closed") terminal = true;
  }
}

describe("seeded PR workflow properties through the real HTTP door", () => {
  it("holds machine, neutrality, and replay invariants for at least 500 sequences", async () => {
    fixture = await startPrHttpFixture();
    const seeds = committedSeeds();
    expect(seeds.length * SEQUENCES_PER_SEED).toBeGreaterThanOrEqual(500);
    const generated = new Map(PR_ACTION_TYPES.map((type) => [type, 0]));
    const accepted = new Map(PR_ACTION_TYPES.map((type) => [type, 0]));
    let acceptedCount = 0;
    let refusalCount = 0;

    for (const [seedIndex, seed] of seeds.entries()) {
      const random = mulberry32(seed);
      for (let local = 0; local < SEQUENCES_PER_SEED; local += 1) {
        const sequence = seedIndex * SEQUENCES_PER_SEED + local;
        const streamId = await fixture.createPr(`fuzz-${seedIndex}-${local}`);
        const actions = generatedSequence(fixture, random, sequence);
        let before = await prSnapshot(fixture.streams, streamId);

        for (const current of actions) {
          generated.set(
            current.type as (typeof PR_ACTION_TYPES)[number],
            generated.get(current.type as (typeof PR_ACTION_TYPES)[number])! + 1,
          );
          const result = await fixture.dispatch(streamId, current);
          const after = await prSnapshot(fixture.streams, streamId);
          if (result.status === 202) {
            acceptedCount += 1;
            accepted.set(
              current.type as (typeof PR_ACTION_TYPES)[number],
              accepted.get(current.type as (typeof PR_ACTION_TYPES)[number])! + 1,
            );
            expect(after.records).toHaveLength(before.records.length + 1);
            expect(after.records.at(-1)!.type).toBe(current.type);
            expect(result.offset).toBe(offsetForOrdinal(before.records.length));
            if (current.type === "pr.merged") {
              expect(before.state.status).toBe("approved");
              expect(mergeEligible(before.records)).toBe(true);
            }
            assertCanonicalState(after.state);
            assertAcceptedLog(after.records);
          } else {
            refusalCount += 1;
            expect(result.status).toBe(409);
            const response = JSON.parse(result.body) as {
              readonly error: { readonly class: string; readonly reason: string };
            };
            expect(response.error.class).toBe("validator-rejected");
            expect(PR_REFUSAL_REASONS).toContain(response.error.reason);
            expect(after).toEqual(before);
          }
          before = after;
        }

        assertAcceptedLog(before.records);
        const firstReplay = before.records.reduce(prReducer, prInitialStateForStream(streamId));
        const secondReplay = before.records.reduce(prReducer, prInitialStateForStream(streamId));
        expect(firstReplay).toEqual(before.state);
        expect(stateDigest(firstReplay)).toBe(stateDigest(secondReplay));
      }
    }

    expect(acceptedCount).toBeGreaterThan(0);
    expect(refusalCount).toBeGreaterThan(0);
    for (const actionType of PR_ACTION_TYPES) {
      expect(generated.get(actionType), `generated ${actionType}`).toBeGreaterThan(0);
      expect(accepted.get(actionType), `accepted ${actionType}`).toBeGreaterThan(0);
    }
    console.info(
      `E5_T02_PROPERTY sequences=${seeds.length * SEQUENCES_PER_SEED} accepted=${acceptedCount} refused=${refusalCount} generated=${JSON.stringify(Object.fromEntries(generated))} acceptedEvents=${JSON.stringify(Object.fromEntries(accepted))} seeds=${seeds.map((seed) => `0x${seed.toString(16).padStart(8, "0")}`).join(",")}`,
    );
  }, 120_000);
});
