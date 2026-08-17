import { describe, expect, it } from "vitest";
import {
  assertTranscriptCanon,
  canonicalTranscript,
  compareWorktrees,
  expandSchedule,
  expectedMutationCount,
  serializeSchedule,
} from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  it("keeps the offline profile deterministic and path-disjoint", () => {
    const schedule = expandSchedule(7, "offline");
    expect(schedule.profile).toBe("offline");
    expect(serializeSchedule(schedule)).toBe(serializeSchedule(expandSchedule(7, "offline")));
    const partition = schedule.steps.findIndex(
      ({ op }) => op.type === "stop" && op.machine === "B",
    );
    const offlineSteps = schedule.steps.slice(partition + 1).filter(({ op }) =>
      ["write", "append", "delete", "rename"].includes(op.type),
    );
    const pathsByMachine = new Map<string, Set<string>>();
    for (const { machine, op } of offlineSteps) {
      const paths = pathsByMachine.get(machine) ?? new Set<string>();
      if (op.type === "rename") {
        paths.add(op.from);
        paths.add(op.to);
      } else if ("path" in op) {
        paths.add(op.path);
      }
      pathsByMachine.set(machine, paths);
    }
    const left = pathsByMachine.get("A") ?? new Set<string>();
    const right = pathsByMachine.get("B") ?? new Set<string>();
    expect([...left].filter((path) => right.has(path))).toEqual([]);
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

  it("compares visible bytes and ignores control metadata", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "sync-harness-compare-"));
    const left = join(root, "left");
    const right = join(root, "right");
    try {
      mkdirSync(join(left, ".ef"), { recursive: true });
      mkdirSync(join(right, ".ef"), { recursive: true });
      writeFileSync(join(left, ".ef", "head"), "a");
      writeFileSync(join(right, ".ef", "head"), "b");
      writeFileSync(join(left, "same.txt"), "one");
      writeFileSync(join(right, "same.txt"), "two");
      expect(compareWorktrees(left, right)).toEqual([{ path: "same.txt", kind: "content" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts only mutating schedule operations", () => {
    expect(expectedMutationCount(expandSchedule(1))).toBe(6);
  });
});
