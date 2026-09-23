import { OFFSET_BEFORE_FIRST, canonicalJson, stateDigest } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { describe, expect, it } from "vitest";
import {
  TaskRefusalError,
  generateLegalTaskLog,
  isTaskActionType,
  replayTaskLog,
  seededRandom,
  taskEvidenceStreamId,
  taskReducer,
  taskStreamId,
  validateTaskEvent,
  type TaskState,
} from "../src/index.js";
import { frozenTaskLog } from "./fixture.js";
import {
  BUILDER,
  GOLDEN_ATTACHMENTS,
  GOLDEN_EVIDENCE_STREAM,
  GOLDEN_STREAM,
  branch,
  by,
  claimRef,
} from "./golden.js";
import { InMemoryTaskDoor, withoutOffset, type OffsetEvent } from "./helpers.js";

/**
 * E6-T01 critic promotions (2026-08-30). Seeds and shapes differ from the builder's corpus:
 * duplicated, swapped, and relocated loop records must never produce an illegal edge, a
 * silently accepted no-op, or a door/replay digest split; a forged verdict that changes
 * only the claim offset (branch intact) is refused as stale; verdicts cannot cite another
 * task's evidence list; the rework builder cannot verify its own claim.
 */
const LEGAL_EDGES = new Set([
  "pending>in-progress",
  "in-progress>implemented",
  "implemented>refuted",
  "refuted>in-progress",
  "implemented>verified",
]);

async function drive(
  streamId: string,
  events: readonly OffsetEvent[],
): Promise<{ readonly state: TaskState; readonly accepted: readonly OffsetEvent[] }> {
  let state = replayTaskLog(streamId, []);
  const accepted: OffsetEvent[] = [];
  for (const record of events) {
    const action = withoutOffset(record);
    const nextOffset = offsetForOrdinal(accepted.length);
    try {
      await validateTaskEvent(action, {
        streamId,
        state,
        headOffset: accepted.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
        nextOffset,
        records: accepted,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      continue;
    }
    const stamped: OffsetEvent = { ...action, offset: nextOffset };
    const next = taskReducer(state, stamped);
    if (isTaskActionType(record.type)) {
      expect(LEGAL_EDGES.has(`${state.status}>${next.status}`), record.type).toBe(true);
      expect(next, `${record.type} accepted by the door but a no-op on replay`).not.toBe(state);
      if (next.status === "verified" && state.status !== "verified") {
        expect(record.type).toBe("task.verified");
        expect((record.payload as { by: { role: string } }).by.role).toBe("critic");
      }
      for (let index = 0; index < state.attempts.length - 1; index += 1) {
        expect(canonicalJson(next.attempts[index])).toBe(canonicalJson(state.attempts[index]));
      }
    }
    accepted.push(stamped);
    state = next;
  }
  return { state, accepted };
}

describe("tasks/v1 critic attacks", () => {
  it("survives duplicated, swapped, and relocated loop records under fresh seeds", async () => {
    let mutants = 0;
    for (let seed = 0xc41710; seed < 0xc41710 + 40; seed += 1) {
      const generated = generateLegalTaskLog(seed);
      const events = generated.events;
      const legal = await drive(generated.streamId, events);
      expect(legal.accepted).toHaveLength(events.length);
      const variants: OffsetEvent[][] = [];
      events.forEach((record, index) => {
        const duplicated = [...events];
        duplicated.splice(index, 0, record);
        variants.push(duplicated);
        if (index + 1 < events.length) {
          const swapped = [...events];
          [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!];
          variants.push(swapped);
        }
      });
      const random = seededRandom(seed ^ 0x5eed);
      events.forEach((record, index) => {
        if (!isTaskActionType(record.type)) return;
        const moved = [...events];
        moved.splice(index, 1);
        moved.splice(Math.floor(random() * moved.length), 0, record);
        variants.push(moved, [...events, record]);
      });
      for (const variant of variants) {
        mutants += 1;
        const viaDoor = await drive(generated.streamId, variant);
        const replayed = replayTaskLog(generated.streamId, viaDoor.accepted);
        expect(stateDigest(replayed)).toBe(stateDigest(viaDoor.state));
        const stamped = variant.map((record, index) => ({
          ...withoutOffset(record),
          offset: offsetForOrdinal(index),
        }));
        expect(stateDigest(replayTaskLog(generated.streamId, stamped))).toBe(
          stateDigest(replayTaskLog(generated.streamId, [...stamped])),
        );
      }
    }
    expect(mutants).toBeGreaterThan(500);
  });

  it("refuses a verdict whose only forgery is the claim offset (branch and head intact)", async () => {
    const log = frozenTaskLog();
    const door = new InMemoryTaskDoor();
    door.seedAttachments(GOLDEN_EVIDENCE_STREAM, GOLDEN_ATTACHMENTS);
    for (const record of log.slice(0, 9)) await door.dispatch(GOLDEN_STREAM, withoutOffset(record));
    const before = door.snapshot(GOLDEN_STREAM);
    const stateBefore = door.state(GOLDEN_STREAM);
    for (const offset of [4, 5, 7, 9, 99]) {
      const forged = {
        ...withoutOffset(log[9]!),
        payload: { ...(log[9]!.payload as object), claim: claimRef(offset) },
      };
      await expect(door.dispatch(GOLDEN_STREAM, forged)).rejects.toMatchObject({
        reason: "task/stale-claim",
      });
      const replayed = taskReducer(stateBefore, {
        ...forged,
        offset: offsetForOrdinal(9),
      } as OffsetEvent);
      expect(stateDigest(replayed)).toBe(stateDigest(stateBefore));
    }
    expect(door.snapshot(GOLDEN_STREAM)).toEqual(before);
  });

  it("refuses a verdict citing another task's evidence list and a rework builder's self-verdict", async () => {
    const log = frozenTaskLog();
    const door = new InMemoryTaskDoor();
    door.seedAttachments(GOLDEN_EVIDENCE_STREAM, GOLDEN_ATTACHMENTS);
    for (const record of log.slice(0, 9)) await door.dispatch(GOLDEN_STREAM, withoutOffset(record));
    const other = taskEvidenceStreamId(taskStreamId("maple", "reading-room", "E6-T01-other"))!;
    const foreign = {
      ...withoutOffset(log[9]!),
      payload: { ...(log[9]!.payload as object), evidence: { stream: other, attachmentIds: [] } },
    };
    await expect(door.dispatch(GOLDEN_STREAM, foreign)).rejects.toMatchObject({
      reason: "task/foreign-evidence",
    });
    const selfVerdict = {
      ...withoutOffset(log[9]!),
      payload: {
        ...(log[9]!.payload as object),
        by: by(BUILDER, "critic", 9),
        claim: claimRef(8),
        branch: branch(2, 7),
      },
    };
    let caught: unknown;
    try {
      await door.dispatch(GOLDEN_STREAM, selfVerdict);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskRefusalError);
    expect((caught as TaskRefusalError).reason).toBe("task/self-verdict");
    expect(door.state(GOLDEN_STREAM).status).toBe("implemented");
    expect(door.read(GOLDEN_STREAM)).toHaveLength(9);
  });
});
