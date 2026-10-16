import { canonicalJson, stateDigest } from "@eforest/protocol";
import { issueInitialStateForStream, issueReducer } from "@eforest/issues";
import { describe, expect, it } from "vitest";
import {
  TASKS_REDUCER_ID,
  replayTaskLog,
  taskInitialStateForStream,
  taskReducer,
  tasksReducerDefinition,
} from "../src/index.js";
import { artifact, frozenDigest, frozenTaskLog } from "./fixture.js";
import {
  BUILDER,
  CRITIC,
  GOLDEN_ATTACHMENTS,
  GOLDEN_EVIDENCE_STREAM,
  GOLDEN_OFFSET_EVENTS,
  GOLDEN_STREAM,
  run,
} from "./golden.js";
import { InMemoryTaskDoor, canonicalDump, withoutOffset } from "./helpers.js";

describe("tasks/v1 lifecycle", () => {
  it("accepts the frozen valid log through the door and lands on the frozen state", async () => {
    const door = new InMemoryTaskDoor();
    door.seedAttachments(GOLDEN_EVIDENCE_STREAM, GOLDEN_ATTACHMENTS);
    for (const record of GOLDEN_OFFSET_EVENTS) {
      expect(await door.dispatch(GOLDEN_STREAM, withoutOffset(record))).toBe(record.offset);
    }
    expect(canonicalDump(door.read(GOLDEN_STREAM))).toBe(artifact("e6-t01-task.jsonl"));
    const state = door.state(GOLDEN_STREAM);
    expect(canonicalJson(state)).toBe(artifact("e6-t01-task.state.json").trim());
    expect(stateDigest(state)).toBe(frozenDigest());
  });

  it("replays the frozen log twice to byte-identical digests and the expected linkage", () => {
    const log = frozenTaskLog();
    const first = replayTaskLog(GOLDEN_STREAM, log);
    const second = replayTaskLog(GOLDEN_STREAM, [...log]);
    expect(stateDigest(first)).toBe(stateDigest(second));
    expect(stateDigest(first)).toBe(frozenDigest());
    expect(first.status).toBe("verified");
    expect(first.attempts).toHaveLength(2);
    expect(first.attempts[0]?.claim?.offset).toBe(log[4]!.offset);
    expect(first.attempts[0]?.verdict?.kind).toBe("refuted");
    expect(first.attempts[0]?.verdict?.findings).toHaveLength(2);
    expect(first.attempts[0]?.verdict?.findings?.[0]?.fingerprint).toBe(
      "digest-diverges-at-offset-2",
    );
    expect(first.attempts[1]?.reworkOf).toBe(log[5]!.offset);
    expect(first.attempts[1]?.claim?.offset).toBe(log[8]!.offset);
    expect(first.verification).toEqual({
      attempt: 2,
      claim: log[8]!.offset,
      critic: { actor: CRITIC, run: run(4) },
      offset: log[9]!.offset,
    });
    expect(first.attempts[1]?.builder).toEqual({ actor: BUILDER, run: run(3) });
  });

  it("round-trips the issue half byte-for-byte with the E5 issue reducer", () => {
    const log = frozenTaskLog();
    const task = replayTaskLog(GOLDEN_STREAM, log);
    const issue = log.reduce(issueReducer, issueInitialStateForStream(GOLDEN_STREAM));
    expect(canonicalJson(task.issue)).toBe(canonicalJson(issue));
    expect(task.issue.labels).toEqual(["bug"]);
    expect(task.issue.comments.map((comment) => comment.commentId)).toEqual(["c-1", "c-2"]);
    expect(task.issue.state).toBe("open");
    expect(task.issue.issueId).toBe(task.taskId);
  });

  it("registers as tasks/v1 over issue streams with stream-derived identity", () => {
    expect(tasksReducerDefinition.id).toBe(TASKS_REDUCER_ID);
    expect(tasksReducerDefinition.matchesStream(GOLDEN_STREAM)).toBe(true);
    expect(tasksReducerDefinition.matchesStream("pr:maple/reading-room/1")).toBe(false);
    expect(() => taskInitialStateForStream("task:maple/reading-room/x")).toThrow(/invalid task/);
    const initial = taskInitialStateForStream(GOLDEN_STREAM);
    expect(initial.taskId).toBe("E6-T01-golden");
    expect(initial.issue.issueId).toBe("E6-T01-golden");
    expect(tasksReducerDefinition.digest(initial)).toBe(stateDigest(initial));
  });

  it("keeps every illegal-but-present event a deterministic no-op on replay", () => {
    const log = frozenTaskLog();
    const state = replayTaskLog(GOLDEN_STREAM, log);
    const again = taskReducer(state, log[9]!);
    expect(again).toBe(state);
    const stale = taskReducer(replayTaskLog(GOLDEN_STREAM, log.slice(0, 9)), {
      ...log[9]!,
      payload: {
        ...(log[9]!.payload as object),
        claim: { stream: GOLDEN_STREAM, offset: log[4]!.offset },
      },
    });
    expect(stale.status).toBe("implemented");
    expect(taskReducer(state, { type: "task.blessed", payload: { v: 1 }, ts: 1 })).toBe(state);
    expect(taskReducer(state, { type: "task.started", payload: { v: 2 }, ts: 1 })).toBe(state);
    expect(taskReducer(state, { type: "task.started", payload: null, ts: 1 })).toBe(state);
    const offsetless = { type: log[3]!.type, payload: log[3]!.payload, ts: log[3]!.ts };
    expect(taskReducer(replayTaskLog(GOLDEN_STREAM, log.slice(0, 3)), offsetless).status).toBe(
      "pending",
    );
  });
});
