import { canonicalJson, sha256Hex, stateDigest } from "@eforest/protocol";
import { issueInitialStateForStream, issueReducer } from "@eforest/issues";
import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  generateLegalTaskLog,
  replayTaskLog,
  taskEvidenceStreamId,
  taskReducer,
} from "../src/index.js";
import { artifact } from "./fixture.js";
import { InMemoryTaskDoor, withoutOffset } from "./helpers.js";

interface PropertyCorpus {
  readonly seedStart: number;
  readonly cases: number;
  readonly corpusDigest: string;
}

function corpus(): PropertyCorpus {
  const lines = artifact("e6-t01-property.txt").trim().split("\n");
  const value = (key: string): string => {
    const line = lines.find((entry) => entry.startsWith(`${key}=`));
    expect(line, key).toBeDefined();
    return line!.slice(key.length + 1);
  };
  return {
    seedStart: Number.parseInt(value("seed-start"), 16),
    cases: Number(value("cases")),
    corpusDigest: value("corpus-sha256"),
  };
}

describe("tasks/v1 transition sequences", () => {
  const { seedStart, cases, corpusDigest } = corpus();

  it("accepts 1,000 generated legal sequences event-by-event and replays each identically", async () => {
    expect(cases).toBe(1000);
    const digests: string[] = [];
    const statuses = new Map<string, number>();
    let attempts = 0;
    for (let index = 0; index < cases; index += 1) {
      const generated = generateLegalTaskLog(seedStart + index);
      const door = new InMemoryTaskDoor();
      door.seedAttachments(taskEvidenceStreamId(generated.streamId)!, [
        "log-1",
        "log-2",
        "log-3",
        "log-4",
        "replay-1",
        "replay-2",
        "replay-3",
        "replay-4",
      ]);
      for (const record of generated.events) {
        expect(await door.dispatch(generated.streamId, withoutOffset(record))).toBe(record.offset);
      }
      const viaDoor = door.state(generated.streamId);
      const viaReplay = replayTaskLog(generated.streamId, generated.events);
      const again = generated.events.reduce(taskReducer, replayTaskLog(generated.streamId, []));
      const digest = stateDigest(viaReplay);
      expect(stateDigest(viaDoor)).toBe(digest);
      expect(stateDigest(again)).toBe(digest);
      expect(TASK_STATUSES).toContain(viaReplay.status);
      statuses.set(viaReplay.status, (statuses.get(viaReplay.status) ?? 0) + 1);
      attempts += viaReplay.attempts.length;
      // append-only attempt history: every attempt keeps its number and rework link
      viaReplay.attempts.forEach((attempt, position) => {
        expect(attempt.n).toBe(position + 1);
        if (position > 0)
          expect(attempt.reworkOf).toBe(viaReplay.attempts[position - 1]!.verdict!.offset);
      });
      if (viaReplay.status === "verified") {
        const last = viaReplay.attempts.at(-1)!;
        expect(viaReplay.verification?.claim).toBe(last.claim?.offset);
        expect(viaReplay.verification?.critic.actor).not.toBe(last.builder.actor);
      }
      const issue = generated.events.reduce(
        issueReducer,
        issueInitialStateForStream(generated.streamId),
      );
      expect(canonicalJson(viaReplay.issue)).toBe(canonicalJson(issue));
      digests.push(digest);
    }
    for (const status of TASK_STATUSES)
      expect(statuses.get(status) ?? 0, status).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThan(cases);
    expect(sha256Hex(new TextEncoder().encode(`${digests.join("\n")}\n`))).toBe(corpusDigest);
  });

  it("is total over fuzzed well-formed events and refuses unknown versions and types", () => {
    const generated = generateLegalTaskLog(seedStart);
    const state = replayTaskLog(generated.streamId, generated.events);
    const digest = stateDigest(state);
    const mutants = [
      {
        type: "task.started",
        payload: { v: 1, by: { actor: "x", role: "builder", run: "agent-run:maple/x" } },
        ts: 1,
      },
      { type: "task.claimed", payload: { v: 1 }, ts: 1 },
      { type: "task.verified", payload: { v: "1" }, ts: 1 },
      { type: "task.verified", payload: [], ts: 1 },
      { type: "task.refuted", payload: { v: 1, by: null }, ts: 1 },
      { type: "task.started", payload: { v: 0 }, ts: 1 },
      { type: "tasks.started", payload: { v: 1 }, ts: 1 },
      { type: "issue.blessed", payload: { v: 1 }, ts: 1 },
      { type: "", payload: undefined, ts: Number.NaN },
    ];
    for (const mutant of mutants) {
      const next = taskReducer(state, {
        ...mutant,
        offset: "0000000000000000_0000000000000099",
      } as never);
      expect(stateDigest(next)).toBe(digest);
    }
  });
});
