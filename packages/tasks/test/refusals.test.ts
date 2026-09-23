import { stateDigest } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  TASK_REFUSAL_REASONS,
  TaskRefusalError,
  TaskSchemaError,
  TaskUnknownActionError,
  taskReducer,
} from "../src/index.js";
import { frozenRefusals, frozenTaskLog } from "./fixture.js";
import { GOLDEN_ATTACHMENTS, GOLDEN_EVIDENCE_STREAM, REFUSAL_SCENARIOS } from "./golden.js";
import { InMemoryTaskDoor, withoutOffset } from "./helpers.js";

describe("tasks/v1 refusals", () => {
  const scenarios = frozenRefusals();

  it("freezes every catalogued refusal scenario", () => {
    expect(scenarios.map((scenario) => scenario.name)).toEqual(
      REFUSAL_SCENARIOS.map((scenario) => scenario.name),
    );
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
  });

  for (const scenario of scenarios) {
    it(`refuses ${scenario.name} before append and leaves head and digest untouched`, async () => {
      const log = frozenTaskLog();
      const door = new InMemoryTaskDoor(scenario.actor);
      door.seedAttachments(GOLDEN_EVIDENCE_STREAM, GOLDEN_ATTACHMENTS);
      door.actor = undefined;
      for (const record of log.slice(0, scenario.prefix)) {
        await door.dispatch(scenario.streamId, withoutOffset(record));
      }
      door.actor = scenario.actor;
      const before = door.snapshot(scenario.streamId);
      const stateBefore = door.state(scenario.streamId);
      let caught: unknown;
      try {
        await door.dispatch(scenario.streamId, scenario.event);
      } catch (error) {
        caught = error;
      }
      if (scenario.expect.class === "validator-rejected") {
        expect(caught).toBeInstanceOf(TaskRefusalError);
        expect((caught as TaskRefusalError).reason).toBe(scenario.expect.reason);
        expect(TASK_REFUSAL_REASONS).toContain(scenario.expect.reason);
      } else if (scenario.expect.class === "schema-violation") {
        expect(caught).toBeInstanceOf(TaskSchemaError);
      } else {
        expect(caught).toBeInstanceOf(TaskUnknownActionError);
      }
      expect(door.snapshot(scenario.streamId)).toEqual(before);
      if (scenario.dispatchOnly === true) return;
      const replayed = taskReducer(stateBefore, {
        ...scenario.event,
        offset: `0000000000000000_${String(scenario.prefix).padStart(16, "0")}`,
      } as never);
      expect(stateDigest(replayed)).toBe(stateDigest(stateBefore));
    });
  }

  it("covers every frozen refusal reason at least once", () => {
    const seen = new Set(
      scenarios.flatMap((scenario) =>
        scenario.expect.class === "validator-rejected" ? [scenario.expect.reason] : [],
      ),
    );
    for (const reason of TASK_REFUSAL_REASONS) expect(seen, reason).toContain(reason);
  });
});
