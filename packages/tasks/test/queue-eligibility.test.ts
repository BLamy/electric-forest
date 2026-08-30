import { describe, expect, it } from "vitest";
import {
  E6_T04_BARE_EPIC_GUARD,
  QUEUE_VIOLATION_REASONS,
  admitSelection,
  checkQueueProof,
  comparePriority,
  evaluateQueue,
  isQueueMember,
  normalizeQueueDecision,
  projectQueue,
  queueDigest,
  queueProof,
  renderQueueMarkdown,
  replayTaskLog,
  type QueueTaskSpec,
} from "../src/index.js";
import {
  canonical,
  expectedArtifact,
  frozenGraph,
  frozenGraphNames,
  projectionOf,
  sourcesOf,
} from "./queue-fixture.js";

const spec = (
  id: string,
  status: QueueTaskSpec["status"],
  dependsOn: readonly string[] = [],
  extra: Partial<QueueTaskSpec> = {},
): QueueTaskSpec => {
  const [epic, n] = id.slice(1).split("-T") as [string, string];
  return {
    id,
    epic: Number(epic),
    priority: String(Number(epic) * 100 + Number(n)),
    title: `Task ${id}`,
    status,
    dependsOn,
    capstone: false,
    queueJumpReason: false,
    ...extra,
  };
};

describe("queue eligibility (E6-T04)", () => {
  it("holds every frozen graph to its committed projection, markdown, and digest", () => {
    const names = frozenGraphNames();
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const name of names) {
      const graph = frozenGraph(name);
      const projection = projectionOf(graph);
      expect(`${canonical(projection)}\n`, `${name}: queue.json`).toBe(
        expectedArtifact(name, "queue.json"),
      );
      expect(renderQueueMarkdown(projection), `${name}: QUEUE.md`).toBe(
        expectedArtifact(name, "QUEUE.md"),
      );
      expect(`${queueDigest(projection)}\n`, `${name}: digest`).toBe(
        expectedArtifact(name, "digest"),
      );
      expect(projection.decision.kind === "invalid", `${name}: validity`).toBe(!graph.valid);
      if (projection.decision.kind === "invalid") {
        expect(
          "nextEligible" in projection.decision,
          `${name}: invalid proofs carry no nextEligible`,
        ).toBe(false);
        expect(projection.decision.violations.length).toBeGreaterThan(0);
      }
    }
  });

  it("orders by ascending numeric priority then id, without floats", () => {
    expect(comparePriority("302.5", "302")).toBeGreaterThan(0);
    expect(comparePriority("99", "100")).toBeLessThan(0);
    expect(comparePriority("101.25", "101.3")).toBeLessThan(0);
    expect(comparePriority("12345678901234567890", "12345678901234567891")).toBeLessThan(0);
    const { ordered } = evaluateQueue([
      spec("E2-T01", "pending", [], { priority: "150.25" }),
      spec("E1-T02", "pending"),
      spec("E1-T01", "pending", [], { priority: "102" }),
      spec("E3-T01", "pending", [], { priority: "102" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["E1-T01", "E1-T02", "E3-T01", "E2-T01"]);
  });

  it("satisfies task dependencies only by verified, with an exact reason otherwise", () => {
    for (const status of ["pending", "in-progress", "implemented", "refuted"] as const) {
      const active = status !== "pending";
      const { blocked, decision } = evaluateQueue([
        spec("E1-T01", status),
        spec("E1-T02", "pending", ["E1-T01"], { capstone: true }),
      ]);
      expect(blocked.get("E1-T02")).toEqual([
        { reason: "dep/unverified", ref: "E1-T01", detail: status },
      ]);
      if (active) expect(decision.kind).toBe(status === "refuted" ? "rework" : "in-flight");
      else expect(decision).toEqual({ kind: "eligible", nextEligible: "E1-T01", inFlight: null });
    }
    const verified = evaluateQueue([
      spec("E1-T01", "verified"),
      spec("E1-T02", "pending", ["E1-T01"], { capstone: true }),
    ]);
    expect(verified.blocked.get("E1-T02")).toEqual([]);
    expect(verified.decision).toEqual({ kind: "eligible", nextEligible: "E1-T02", inFlight: null });
  });

  it("satisfies a bare epic dependency only by that epic's unique verified capstone", () => {
    expect(E6_T04_BARE_EPIC_GUARD).toBe(true);
    const nonCapstoneFirst = projectionOf(frozenGraph("bare-epic-noncapstone-first"));
    expect(nonCapstoneFirst.decision).toEqual({
      kind: "eligible",
      nextEligible: "E1-T02",
      inFlight: null,
    });
    expect(nonCapstoneFirst.tasks.find((task) => task.id === "E2-T01")?.blocked).toEqual([
      { reason: "dep/epic-capstone-unverified", ref: "E1", detail: "pending" },
    ]);
    const capstoneVerified = projectionOf(frozenGraph("bare-epic-capstone-verified"));
    expect(capstoneVerified.decision).toEqual({
      kind: "eligible",
      nextEligible: "E2-T01",
      inFlight: null,
    });
    const { blocked } = evaluateQueue([
      spec("E1-T01", "verified"),
      spec("E1-T02", "verified", [], { capstone: true }),
      spec("E2-T01", "pending", ["E1", "E3", "E1-T01", "E1-T01"], { capstone: true }),
      spec("E4-T01", "pending", ["E5"], { capstone: true }),
      spec("E5-T01", "verified"),
      spec("E5-T02", "verified", [], { capstone: false }),
    ]);
    expect(blocked.get("E2-T01")).toEqual([
      { reason: "dep/epic-missing", ref: "E3" },
      { reason: "dep/duplicate-ref", ref: "E1-T01" },
    ]);
    expect(blocked.get("E4-T01")).toEqual([{ reason: "dep/epic-no-capstone", ref: "E5" }]);
  });

  it("admits no second task while one is in-progress or implemented", () => {
    for (const status of ["in-progress", "implemented"] as const) {
      const { decision } = evaluateQueue([
        spec("E1-T01", status),
        spec("E1-T02", "pending"),
        spec("E1-T03", "pending", [], { capstone: true }),
      ]);
      expect(decision).toEqual({ kind: "in-flight", nextEligible: null, inFlight: "E1-T01" });
    }
    const rework = evaluateQueue([
      spec("E1-T01", "refuted"),
      spec("E1-T02", "pending", [], { capstone: true }),
    ]);
    expect(rework.decision).toEqual({ kind: "rework", nextEligible: "E1-T01", inFlight: "E1-T01" });
  });

  it("answers two active tasks and two capstones with an invalid proof, never a winner", () => {
    const projection = projectionOf(frozenGraph("two-active-two-capstones"));
    expect(projection.decision).toEqual({
      kind: "invalid",
      violations: [
        { reason: "queue/multiple-active", refs: ["E1-T01", "E1-T02"] },
        { reason: "capstone/multiple", refs: ["E1"] },
      ],
    });
    expect(renderQueueMarkdown(projection)).toContain("## Invalid queue");
    expect(renderQueueMarkdown(projection)).not.toContain("## Current gate");
    const proof = queueProof(projection);
    expect(
      admitSelection(proof, "E1-T01", sourcesOf(frozenGraph("two-active-two-capstones"))),
    ).toMatchObject({
      ok: false,
      reason: "queue/invalid",
    });
  });

  it("names every violation reason from at least one frozen graph", () => {
    const seen = new Set<string>();
    for (const name of frozenGraphNames()) {
      const projection = projectionOf(frozenGraph(name));
      if (projection.decision.kind === "invalid") {
        for (const violation of projection.decision.violations) seen.add(violation.reason);
      }
    }
    // Two streams can never share an id on a catalog (`spec/id-mismatch` catches the
    // forgery first), so the structural duplicate check is exercised on bare specs.
    const duplicate = evaluateQueue([
      spec("E1-T01", "pending"),
      spec("E1-T01", "pending", [], { capstone: true }),
    ]);
    expect(duplicate.decision).toEqual({
      kind: "invalid",
      violations: [{ reason: "queue/duplicate-id", refs: ["E1-T01"] }],
    });
    seen.add("queue/duplicate-id");
    // `catalog/corrupt` needs a corrupt catalog rather than a graph; it is covered below.
    for (const reason of QUEUE_VIOLATION_REASONS) {
      if (reason === "catalog/corrupt") continue;
      expect(seen.has(reason), reason).toBe(true);
    }
  });

  it("finds cycles that run through bare-epic edges and refuses to call a deadlock exhausted", () => {
    for (const [name, refs] of [
      ["bare-epic-cycle", ["E1-T01", "E2-T01"]],
      ["self-epic-cycle", ["E1-T01"]],
      ["exhausted-all-blocked", ["E1-T01", "E2-T01"]],
    ] as const) {
      const projection = projectionOf(frozenGraph(name));
      expect(projection.decision, name).toEqual({
        kind: "invalid",
        violations: [{ reason: "dep/cycle", refs: [...refs] }],
      });
    }
    const deadlock = projectionOf(frozenGraph("deadlock-no-capstone-epic"));
    expect(deadlock.decision).toEqual({
      kind: "invalid",
      violations: [{ reason: "dep/deadlock", refs: ["E1-T01", "E2-T02"] }],
    });
    // `exhausted` is reachable only when nothing is pending.
    for (const name of frozenGraphNames()) {
      const projection = projectionOf(frozenGraph(name));
      if (projection.decision.kind === "exhausted") {
        expect(
          projection.tasks.every((task) => task.status === "verified"),
          name,
        ).toBe(true);
      }
    }
    // Built directly: a two-epic cycle through both capstones.
    const { decision } = evaluateQueue([
      spec("E1-T01", "pending", ["E2"], { capstone: true }),
      spec("E2-T01", "pending", ["E1"], { capstone: true }),
    ]);
    expect(decision).toEqual({
      kind: "invalid",
      violations: [{ reason: "dep/cycle", refs: ["E1-T01", "E2-T01"] }],
    });
  });

  it("reports a corrupt catalog as an invalid proof, not an empty queue", () => {
    const sources = sourcesOf(frozenGraph("linear-verified-prefix"));
    const corrupt = {
      ...sources,
      catalog: {
        stream: sources.catalog.stream,
        records: [
          ...sources.catalog.records,
          { type: "repo.issue-observed", payload: { v: 1 }, ts: 1 },
        ],
      },
    };
    const projection = projectQueue(corrupt);
    expect(projection.decision).toEqual({
      kind: "invalid",
      violations: [{ reason: "catalog/corrupt", refs: [sources.catalog.stream] }],
    });
    expect(projection.tasks).toEqual([]);
  });

  it("keeps non-members out: a plain issue never labeled and never started is not a task", () => {
    const sources = sourcesOf(frozenGraph("linear-verified-prefix"));
    const plain = sources.tasks[0]!.records.filter((record) => record.type === "issue.opened");
    expect(isQueueMember(replayTaskLog(sources.tasks[0]!.stream, plain), plain)).toBe(false);
    const withPlain = {
      ...sources,
      tasks: sources.tasks.map((task, index) =>
        index === 0 ? { stream: task.stream, records: plain } : task,
      ),
    };
    const projection = projectQueue(withPlain);
    expect(projection.tasks.map((task) => task.id)).toEqual(["E1-T02", "E2-T01", "E2-T02"]);
    expect(projection.sources.tasks.map((head) => head.stream)).not.toContain(
      sources.tasks[0]!.stream,
    );
    // E1-T02 depended on the vanished E1-T01: the queue is now invalid, loudly.
    expect(projection.decision).toEqual({
      kind: "invalid",
      violations: [{ reason: "dep/missing", refs: ["E1-T01"] }],
    });
  });

  it("ignores the body's frontmatter status: replayed state is the only status", () => {
    const graph = frozenGraph("linear-verified-prefix");
    // Claim `verified` in the body of a pending task; the stream says pending.
    const lying = {
      ...graph,
      tasks: graph.tasks.map((task) =>
        task.id === "E2-T01" ? { ...task, status: "pending" as const } : task,
      ),
    };
    const sources = sourcesOf(lying);
    const forged = {
      ...sources,
      tasks: sources.tasks.map((task) =>
        task.stream.endsWith("/E2-T01")
          ? {
              stream: task.stream,
              records: task.records.map((record) =>
                record.type === "issue.opened"
                  ? {
                      ...record,
                      payload: {
                        ...(record.payload as Record<string, unknown>),
                        body: (record.payload as { body: string }).body.replace(
                          "status: pending",
                          "status: verified",
                        ),
                      },
                    }
                  : record,
              ),
            }
          : task,
      ),
    };
    const projection = projectQueue(forged);
    expect(projection.tasks.find((task) => task.id === "E2-T01")?.status).toBe("pending");
    expect(normalizeQueueDecision(projection).selected).toBe("E2-T01");
  });

  it("fences a proof: the head that moved is named, and a stale selection is refused", () => {
    const graph = frozenGraph("linear-verified-prefix");
    const sources = sourcesOf(graph);
    const proof = queueProof(projectQueue(sources));
    expect(proof.decision).toEqual({ kind: "eligible", nextEligible: "E2-T01", inFlight: null });
    expect(checkQueueProof(proof, sources)).toMatchObject({ ok: true });
    expect(admitSelection(proof, "E2-T01", sources)).toMatchObject({ ok: true });
    expect(admitSelection(proof, "E2-T02", sources)).toMatchObject({
      ok: false,
      reason: "queue/not-eligible",
    });
    // The dependency E1-T02 gains one event (a comment) after the proof was obtained.
    const moved = {
      ...sources,
      tasks: sources.tasks.map((task) =>
        task.stream.endsWith("/E1-T02")
          ? {
              stream: task.stream,
              records: [
                ...task.records,
                {
                  type: "issue.commented",
                  payload: { v: 1, commentId: "c1", body: "late" },
                  ts: 300,
                  offset: `0000000000000000_${String(task.records.length).padStart(16, "0")}`,
                },
              ],
            }
          : task,
      ),
    };
    const stale = admitSelection(proof, "E2-T01", moved);
    expect(stale).toMatchObject({
      ok: false,
      reason: "queue/stale-proof",
      stale: {
        stream: "issue:maple/loom/E1-T02",
        cited: proof.heads.find((head) => head.stream.endsWith("/E1-T02"))!.offset,
      },
    });
    // A proof whose heads are current but whose decision was forged is false.
    const forged = {
      ...proof,
      decision: { kind: "eligible" as const, nextEligible: "E2-T02", inFlight: null },
    };
    expect(checkQueueProof(forged, sources)).toMatchObject({
      ok: false,
      reason: "queue/false-proof",
    });
    const forgedDigest = {
      ...proof,
      digest: proof.digest.replace(/^./, proof.digest[0] === "0" ? "1" : "0"),
    };
    expect(checkQueueProof(forgedDigest, sources)).toMatchObject({
      ok: false,
      reason: "queue/false-proof",
    });
  });

  it("changes the decision at the new source head once the in-flight task verifies", () => {
    const before = frozenGraph("implemented-blocks-second");
    const first = projectionOf(before);
    expect(first.decision).toEqual({ kind: "in-flight", nextEligible: null, inFlight: "E1-T01" });
    const after = {
      ...before,
      tasks: before.tasks.map((task) =>
        task.id === "E1-T01" ? { ...task, status: "verified" as const } : task,
      ),
    };
    const second = projectionOf(after);
    expect(second.decision).toEqual({ kind: "eligible", nextEligible: "E1-T02", inFlight: null });
    const headBefore = first.sources.tasks.find((head) => head.stream.endsWith("/E1-T01"))!.offset;
    const headAfter = second.sources.tasks.find((head) => head.stream.endsWith("/E1-T01"))!.offset;
    expect(headAfter > headBefore).toBe(true);
    expect(queueProof(second).heads).toContainEqual({
      stream: "issue:maple/loom/E1-T01",
      offset: headAfter,
    });
    expect(checkQueueProof(queueProof(first), sourcesOf(after))).toMatchObject({
      ok: false,
      reason: "queue/stale-proof",
      stale: { stream: "issue:maple/loom/E1-T01", cited: headBefore, current: headAfter },
    });
  });
});
