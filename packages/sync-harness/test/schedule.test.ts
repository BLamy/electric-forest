import { describe, expect, it } from "vitest";
import {
  assertTranscriptCanon,
  canonicalTranscript,
  expandSchedule,
  serializeSchedule,
} from "../src/index.js";

describe("sync harness schedule contract", () => {
  it("expands the same seed deterministically and adjacent seeds differently", () => {
    expect(expandSchedule(41)).toEqual(expandSchedule(41));
    expect(serializeSchedule(expandSchedule(41))).not.toBe(serializeSchedule(expandSchedule(42)));
  });

  it("uses the frozen version and includes a partition window", () => {
    const schedule = expandSchedule(7);
    expect(schedule.version).toBe(1);
    expect(schedule.steps.some(({ op }) => op.type === "stop")).toBe(true);
    expect(schedule.steps.some(({ op }) => op.type === "restart")).toBe(true);
  });

  it("rejects runtime-specific transcript content", () => {
    const transcript = canonicalTranscript({
      version: 1,
      seed: 1,
      profile: "default",
      mode: "lockstep",
      steps: [],
      final: { digestA: "a", digestB: "a", replayDigest: "a" },
    });
    expect(() => assertTranscriptCanon(transcript)).not.toThrow();
    expect(() => assertTranscriptCanon(`${transcript} pid=12`)).toThrow();
    expect(() => assertTranscriptCanon(`${transcript} 2026-08-17T12:00:00`)).toThrow();
  });
});
