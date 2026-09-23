import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeCapability,
  capabilityBaseDigest,
  capabilityForLease,
  capabilityTokenDigest,
  capabilityTokenForFence,
  createCriticWorkspace,
  isRunEvent,
  leaseStateDigest,
  runArtifactEvent,
  runExitedEvent,
  runInputEvent,
  runLogDigest,
  runMutationAcceptedEvent,
  runProjectionBytes,
  replayRunLog,
  runStateDigest,
  runStreamId,
  ScriptedAgentAdapter,
  scanWorkspace,
  removeWorkspace,
  type AgentAdapterContext,
  type LeaseRecord,
  type LeaseState,
} from "../src/index.js";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const BRANCH = "fs:maple/reading-room:e6-t07-run:meta";
const EVIDENCE = "evidence:maple/reading-room/issue/E6-T07";

function baseLease(
  role: "builder" | "critic" = "builder",
): Omit<LeaseRecord, "capabilityBaseDigest" | "capabilityTokenDigest"> {
  return {
    v: 1,
    leaseId: "lease-test",
    org: "maple",
    repo: "reading-room",
    taskId: "E6-T07",
    runId: "run-test",
    actor: role === "builder" ? "builder" : "critic",
    role,
    branch: { stream: BRANCH, head: offsetForOrdinal(0) },
    evidenceStream: EVIDENCE,
    queueProofDigest: DIGEST_A,
    projectOffset: "-1",
    capabilityId: "cap-test",
    fence: 1,
    createdAt: 1000,
  };
}

function issued(role: "builder" | "critic" = "builder") {
  const withoutToken = baseLease(role);
  const token = capabilityTokenForFence("base-secret-0123456789", 1);
  const lease: LeaseRecord = {
    ...withoutToken,
    capabilityBaseDigest: capabilityBaseDigest(token),
    capabilityTokenDigest: capabilityTokenDigest(token),
  };
  const capability = capabilityForLease(lease, token);
  const state: LeaseState = {
    v: 1,
    stream: "agent-lease:maple/reading-room/E6-T07",
    head: "-1",
    nextFence: 2,
    active: lease,
    lastLeaseId: lease.leaseId,
    terminal: null,
  };
  return { lease, capability, token, state };
}

describe("E6-T07 run protocol", () => {
  it("replays the same run stream twice to identical state and log digests", () => {
    const run = runStreamId("maple", "run-test");
    const started = {
      type: "run.started" as const,
      payload: {
        v: 1 as const,
        run,
        taskId: "E6-T07",
        actor: "builder",
        role: "builder" as const,
        leaseId: "lease-test",
        capabilityId: "cap-test",
        branch: { stream: BRANCH, head: offsetForOrdinal(0) },
        evidenceStream: EVIDENCE,
        queueProofDigest: DIGEST_A,
        projectOffset: "-1" as const,
      },
      ts: 1000,
    };
    const records = [
      started,
      runInputEvent({ name: "task-spec", digest: DIGEST_B, size: 12 }, 1001),
      runArtifactEvent(
        { artifactId: "artifact-1", kind: "run-log", digest: DIGEST_A, size: 64 },
        1002,
      ),
      runMutationAcceptedEvent(
        {
          operationId: "mutation-1",
          target: "branch",
          stream: BRANCH,
          eventType: "fs.file.write",
          targetOffset: offsetForOrdinal(1),
        },
        1003,
      ),
      runExitedEvent({ status: "completed", exitCode: 0 }, 1004),
    ];
    expect(records.every(isRunEvent)).toBe(true);
    const first = records.map((event, index) => ({ ...event, offset: offsetForOrdinal(index) }));
    const second = records.map((event, index) => ({ ...event, offset: offsetForOrdinal(index) }));
    expect(runStateDigest(runReducerForTest(run, first))).toBe(
      runStateDigest(runReducerForTest(run, second)),
    );
    expect(runLogDigest(first)).toBe(runLogDigest(second));
    expect(runProjectionBytes(runReducerForTest(run, first))).toContain("run-test");
  });

  it("keeps the builder/critic capability matrix narrow and fences old tokens", () => {
    const builder = issued("builder");
    const runTarget = { kind: "run" as const, stream: builder.capability.runStream };
    expect(
      authorizeCapability({
        capability: builder.capability,
        token: builder.token,
        lease: builder.lease,
        leaseState: builder.state,
        operation: "run.append",
        target: runTarget,
      }).allowed,
    ).toBe(true);
    expect(
      authorizeCapability({
        capability: builder.capability,
        token: builder.token,
        lease: builder.lease,
        leaseState: builder.state,
        operation: "branch.write",
        target: { kind: "branch", stream: BRANCH.replace(":meta", ":file:src/index.ts") },
      }).allowed,
    ).toBe(true);
    const critic = issued("critic");
    expect(
      authorizeCapability({
        capability: critic.capability,
        token: critic.token,
        lease: critic.lease,
        leaseState: critic.state,
        operation: "branch.write",
        target: { kind: "branch", stream: BRANCH },
      }),
    ).toEqual({ allowed: false, reason: "capability/branch-read-only" });
    const advancedLease: LeaseRecord = {
      ...builder.lease,
      fence: 2,
      capabilityTokenDigest: capabilityTokenDigest(capabilityTokenForFence(builder.token, 2)),
    };
    const advancedState: LeaseState = { ...builder.state, nextFence: 3, active: advancedLease };
    expect(
      authorizeCapability({
        capability: builder.capability,
        token: builder.token,
        lease: advancedLease,
        leaseState: advancedState,
        operation: "run.append",
        target: runTarget,
      }),
    ).toEqual({ allowed: false, reason: "capability/stale-fence" });
    expect(leaseStateDigest(advancedState)).not.toBe(leaseStateDigest(builder.state));
  });

  it("creates a critic workspace from only the committed manifests", async () => {
    const base = await mkdtemp(join(tmpdir(), "eforest-loop-test-"));
    const workspace = await createCriticWorkspace(
      {
        taskSpec: "# E6-T07\n",
        diffManifest: [{ path: "packages/loop/src/run/events.ts", digest: DIGEST_A }],
        claim: "run digest is stable",
        evidenceManifest: [{ id: "run-log", digest: DIGEST_B }],
      },
      {
        baseDir: base,
        environment: { role: "builder", taskId: "E6-T07", runId: "run-test", branchStream: BRANCH },
      },
    );
    try {
      expect(workspace.role).toBe("critic");
      expect(workspace.files.map((file) => file.path)).toEqual([
        "task/spec.md",
        "task/claim.txt",
        "task/diff-manifest.json",
        "task/evidence-manifest.json",
      ]);
      expect(await scanWorkspace(workspace.root)).toEqual([]);
      expect(workspace.environment).not.toHaveProperty("BUILDER_TRANSCRIPT");
      expect(workspace.environment).not.toHaveProperty("AUTH_TOKEN");
    } finally {
      await removeWorkspace(workspace.root);
      await removeWorkspace(base);
    }
  });

  it("runs scripted steps through the transport-neutral adapter", async () => {
    const events: unknown[] = [];
    const context: AgentAdapterContext = {
      role: "builder",
      taskId: "E6-T07",
      runId: "run-test",
      workspace: {
        v: 1,
        role: "builder",
        root: "/tmp/isolated",
        files: [],
        inputsDigest: DIGEST_A,
        environment: { CI: "1" },
      },
      inputs: { taskSpecDigest: DIGEST_A },
      now: () => 1000,
      assertActive: async () => undefined,
      append: async (event) => {
        events.push(event);
      },
      mutate: async (request) => ({
        operationId: request.operationId,
        target: request.target,
        stream: request.stream,
        targetOffset: offsetForOrdinal(0),
      }),
    };
    const result = await new ScriptedAgentAdapter([
      { kind: "input", name: "spec", digest: DIGEST_A, size: 1 },
      { kind: "tool", tool: "format", ok: true, outputDigest: DIGEST_B },
      {
        kind: "mutation",
        operationId: "mutation-1",
        target: "branch",
        stream: BRANCH,
        event: { type: "fs.file.write", payload: { v: 1 }, ts: 1000 },
      },
      { kind: "exit", status: "completed" },
    ]).run(context);
    expect(result).toEqual({ status: "completed", mutations: 1, steps: 4 });
    expect(events).toHaveLength(2);
  });
});

function runReducerForTest(stream: string, records: readonly unknown[]) {
  return replayRunLog(stream, records);
}
