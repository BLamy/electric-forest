/** E6-T07: authenticated agent-run HTTP doors over two independent coordinators. */
import type { Event, Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { emptyView, type AuthorizationView } from "@eforest/identity";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  createBuilderWorkspace,
  runInputEvent,
  ScriptedAgentAdapter,
  removeWorkspace,
} from "@eforest/loop";
import {
  projectQueue,
  queueProof,
  queueSourcesFromGraph,
  type QueueGraph,
  type QueueSourceStream,
} from "@eforest/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRunCoordinator,
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PlatformGateway,
  createPlatformServer,
  listenPlatformServer,
  type StreamAdapter,
  type AuthorizationContext,
  type AuthorizationVerifier,
} from "../src/index.js";

const ORG = "maple";
const REPO = "reading-room";
const TASK = "E6-T07";
const BRANCH = `fs:${ORG}/${REPO}:e6-t07-run:meta`;
const AUTHORIZATION = "Bearer agent-fixture";
const CAPABILITY_HEADER = "x-eforest-capability";

interface StampedEvent extends Event {
  readonly offset: Offset;
}

interface AcceptedResponse {
  readonly lease: {
    readonly leaseId: string;
    readonly fence: number;
    readonly capabilityTokenDigest: string;
  };
  readonly token: string;
  readonly run: { readonly status: string; readonly head: Offset | "-1" };
}

function withoutOffset(record: StampedEvent): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

async function seedStream(
  streams: OfficialStreamAdapter,
  source: QueueSourceStream,
): Promise<void> {
  await streams.create(source.stream);
  for (const [index, record] of source.records.entries()) {
    const offset = (record as StampedEvent).offset ?? offsetForOrdinal(index);
    await streams.append(source.stream, withoutOffset(record as StampedEvent), {
      sequence: offset,
      applicationOffset: offset,
    });
  }
}

function fixtureGraph(): QueueGraph {
  return {
    name: "e6-t07-agent-run",
    tasks: [
      {
        id: TASK,
        epic: 6,
        priority: "607",
        title: "Agent-run protocol",
        status: "pending",
        depends_on: [],
        estimate: "L",
        capstone: false,
      },
    ],
  };
}

function fixtureAuthorization(): AuthorizationVerifier {
  const identity: AuthorizationView = emptyView();
  return {
    verifyAuthorization: async () => ({ sub: "builder-fixture" }),
    authorizationContext: async (header): Promise<AuthorizationContext> => {
      if (header !== AUTHORIZATION) throw new TypeError("invalid fixture credential");
      return {
        principal: { kind: "identified", sub: "builder-fixture", grantId: "grant-fixture" },
        identity,
        identityOffset: "-1",
      };
    },
  };
}

async function closeServer(server: ReturnType<typeof createPlatformServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

class CrashOnceAfterAppend implements StreamAdapter {
  private crashed = false;

  constructor(
    private readonly delegate: OfficialStreamAdapter,
    private readonly target: string,
  ) {}

  create(streamId: string): Promise<void> {
    return this.delegate.create(streamId);
  }

  exists(streamId: string): Promise<boolean> {
    return this.delegate.exists(streamId);
  }

  async append(
    streamId: string,
    event: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): Promise<void | "appended" | "producer-duplicate-closed"> {
    const result = await this.delegate.append(streamId, event, options);
    if (streamId === this.target && options?.idempotencyKey === "mutation-crash" && !this.crashed) {
      this.crashed = true;
      throw new Error("simulated-worker-crash");
    }
    return result;
  }

  read(streamId: string): Promise<readonly unknown[]> {
    return this.delegate.read(streamId);
  }

  readResolved(streamId: string): Promise<readonly unknown[]> {
    return this.delegate.readResolved(streamId);
  }

  async *follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown> {
    yield* this.delegate.follow(streamId, signal);
  }
}

describe("E6-T07 agent-run doors", () => {
  let official: ReturnType<typeof createDurableStreamTestServer> | undefined;
  let gateways: PlatformGateway[] = [];
  let servers: ReturnType<typeof createPlatformServer>[] = [];
  let gatewayUrls: string[] = [];
  let officialUrl = "";

  beforeAll(async () => {
    official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    officialUrl = await official.start();
    const seed = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const sources = queueSourcesFromGraph(ORG, REPO, fixtureGraph());
    await seedStream(seed, sources.catalog);
    await seedStream(seed, sources.tasks[0]!);

    for (const fill of [7, 19]) {
      const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
      const coordinator = new AgentRunCoordinator({
        streams,
        now: () => 1_000,
        random: (size) => new Uint8Array(size).fill(fill),
      });
      const gateway = new PlatformGateway({
        verifier: fixtureAuthorization(),
        streams,
        agentRuns: coordinator,
        namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
        rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
      });
      const server = createPlatformServer((request) => gateway.handle(request));
      gateways.push(gateway);
      servers.push(server);
      gatewayUrls.push(await listenPlatformServer(server));
    }
  }, 120_000);

  afterAll(async () => {
    gateways.forEach((gateway) => gateway.terminate());
    await Promise.all(servers.map((server) => closeServer(server)));
    await official?.stop();
    gateways = [];
    servers = [];
    gatewayUrls = [];
    official = undefined;
  });

  it("admits one of 100 racers, rotates the fence, and refuses old-token writes", async () => {
    const unauthorized = await fetch(`${gatewayUrls[0]}/api/agent-runs/leases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const sources = queueSourcesFromGraph(ORG, REPO, fixtureGraph());
    const proof = queueProof(projectQueue(sources));
    const branch = { stream: BRANCH, head: offsetForOrdinal(0) };
    const responses = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const response = await fetch(
          `${gatewayUrls[index % gatewayUrls.length]}/api/agent-runs/leases`,
          {
            method: "POST",
            headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
            body: JSON.stringify({
              org: ORG,
              repo: REPO,
              taskId: TASK,
              runId: `run-${String(index)}`,
              role: "builder",
              branch,
              projectOffset: "-1",
              queueProof: proof,
            }),
          },
        );
        return { index, status: response.status, body: (await response.json()) as unknown };
      }),
    );
    const accepted = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status === 409);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(99);
    expect(
      refused.every((response) => {
        const body = response.body as { readonly error?: { readonly reason?: unknown } };
        return (
          body.error?.reason === "lease/already-held" || body.error?.reason === "lease/stale-fence"
        );
      }),
    ).toBe(true);

    const winner = accepted[0]!;
    const winnerRunId = `run-${String(winner.index)}`;
    const body = winner.body as AcceptedResponse;
    expect(body.run.status).toBe("running");
    expect(body.lease.fence).toBe(1);
    expect(body.token).toMatch(/^cap_v1\.[A-Za-z0-9_-]+\.1$/);

    const inspectUrl = `${gatewayUrls[winner.index % gatewayUrls.length]}/api/agent-runs/runs/${encodeURIComponent(winnerRunId)}?org=${ORG}&repo=${REPO}&taskId=${TASK}`;
    const inspected = await fetch(inspectUrl, { headers: { authorization: AUTHORIZATION } });
    expect(inspected.status).toBe(200);
    const initial = (await inspected.json()) as {
      readonly lease: {
        readonly active: { readonly leaseId: string; readonly fence: number } | null;
      };
      readonly run: { readonly status: string; readonly head: Offset | "-1" };
    };
    expect(initial.lease.active?.leaseId).toBe(body.lease.leaseId);
    expect(initial.run.status).toBe("running");

    const ownerUrl = gatewayUrls[winner.index % gatewayUrls.length]!;
    const heartbeat = await fetch(
      `${ownerUrl}/api/agent-runs/leases/${encodeURIComponent(body.lease.leaseId)}/heartbeat`,
      {
        method: "POST",
        headers: {
          authorization: AUTHORIZATION,
          [CAPABILITY_HEADER]: body.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ org: ORG, repo: REPO, taskId: TASK }),
      },
    );
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = (await heartbeat.json()) as {
      readonly token: string;
      readonly lease: { readonly fence: number };
      readonly run: { readonly head: Offset | "-1" };
    };
    expect(heartbeatBody.lease.fence).toBe(2);
    expect(heartbeatBody.token).not.toBe(body.token);

    const staleAppend = await fetch(
      `${ownerUrl}/api/agent-runs/runs/${encodeURIComponent(winnerRunId)}/events`,
      {
        method: "POST",
        headers: {
          authorization: AUTHORIZATION,
          [CAPABILITY_HEADER]: body.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          org: ORG,
          repo: REPO,
          taskId: TASK,
          expectedOffset: heartbeatBody.run.head,
          event: runInputEvent({ name: "stale", digest: "a".repeat(64), size: 1 }, 1_001),
        }),
      },
    );
    expect(staleAppend.status).toBe(409);
    const staleBody = await staleAppend.json();
    expect(staleBody.error.reason).toBe("capability/stale-fence");

    const released = await fetch(
      `${ownerUrl}/api/agent-runs/leases/${encodeURIComponent(body.lease.leaseId)}/release`,
      {
        method: "POST",
        headers: {
          authorization: AUTHORIZATION,
          [CAPABILITY_HEADER]: heartbeatBody.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ org: ORG, repo: REPO, taskId: TASK }),
      },
    );
    expect(released.status).toBe(200);
    const releasedBody = (await released.json()) as {
      readonly lease: null;
      readonly run: { readonly status: string };
    };
    expect(releasedBody.lease).toBeNull();
    expect(releasedBody.run.status).toBe("aborted");

    const storage = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const leaseRecords = await storage.readResolved(`agent-lease:${ORG}/${REPO}/${TASK}`);
    const runRecords = await storage.readResolved(`agent-run:${ORG}/${winnerRunId}`);
    expect(JSON.stringify(leaseRecords)).not.toContain("cap_v1.");
    expect(JSON.stringify(runRecords)).not.toContain("cap_v1.");
    expect(await storage.exists(BRANCH)).toBe(false);
  });

  it("replays a pending mutation after a post-append crash without duplicating it", async () => {
    const sources = queueSourcesFromGraph(ORG, REPO, fixtureGraph());
    const proof = queueProof(projectQueue(sources));
    const target = `${BRANCH.replace(":meta", ":file:crash")}`;
    const storage = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const coordinator = new AgentRunCoordinator({
      streams: new CrashOnceAfterAppend(storage, target),
      now: () => 2_000,
      random: (size) => new Uint8Array(size).fill(31),
    });
    const acquired = await coordinator.acquire({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "crash-run",
      actor: "builder-fixture",
      role: "builder",
      branch: { stream: BRANCH, head: offsetForOrdinal(0) },
      projectOffset: "-1",
      queueProof: proof,
    });
    const mutation: Event = {
      type: "fs.file.create",
      payload: { v: 2, path: "crash.txt", contentStreamId: `${target}:content` },
      ts: 2_001,
    };
    await expect(
      coordinator.appendMutation({
        org: ORG,
        repo: REPO,
        taskId: TASK,
        runId: "crash-run",
        actor: "builder-fixture",
        token: acquired.token,
        expectedOffset: acquired.run.head,
        operationId: "mutation-crash",
        target: "branch",
        stream: target,
        expectedTargetOffset: "-1",
        mutation,
      }),
    ).rejects.toThrow("simulated-worker-crash");

    const afterCrash = await coordinator.inspect({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "crash-run",
    });
    expect(afterCrash.run.mutationIntents).toEqual(["mutation-crash"]);
    expect(afterCrash.run.mutationIds).toEqual([]);
    const retried = await coordinator.appendMutation({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "crash-run",
      actor: "builder-fixture",
      token: acquired.token,
      expectedOffset: afterCrash.run.head,
      operationId: "mutation-crash",
      target: "branch",
      stream: target,
      expectedTargetOffset: "-1",
      mutation,
    });
    expect(retried.receipt.targetOffset).toBe(offsetForOrdinal(0));
    expect(retried.run.mutationIds).toEqual(["mutation-crash"]);
    expect(await storage.readResolved(target)).toHaveLength(1);
    const runRecords = await storage.readResolved("agent-run:maple/crash-run");
    expect(
      runRecords.filter(
        (record) => (record as { readonly type?: unknown }).type === "run.mutation-intent",
      ),
    ).toHaveLength(1);
    expect(
      runRecords.filter(
        (record) => (record as { readonly type?: unknown }).type === "run.mutation-accepted",
      ),
    ).toHaveLength(1);
    await coordinator.release({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      leaseId: acquired.lease.leaseId,
      actor: "builder-fixture",
      token: acquired.token,
    });
  });

  it("runs a scripted adapter through the same append and terminal doors", async () => {
    const sources = queueSourcesFromGraph(ORG, REPO, fixtureGraph());
    const proof = queueProof(projectQueue(sources));
    const storage = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const coordinator = new AgentRunCoordinator({
      streams: storage,
      now: () => 3_000,
      random: (size) => new Uint8Array(size).fill(43),
    });
    const acquired = await coordinator.acquire({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "adapter-run",
      actor: "builder-fixture",
      role: "builder",
      branch: { stream: BRANCH, head: offsetForOrdinal(0) },
      projectOffset: "-1",
      queueProof: proof,
    });
    const workspace = await createBuilderWorkspace(
      { taskSpec: "# E6-T07\n", branchStream: BRANCH, branchHead: offsetForOrdinal(0) },
      {
        environment: {
          role: "builder",
          taskId: TASK,
          runId: "adapter-run",
          branchStream: BRANCH,
        },
      },
    );
    try {
      const result = await coordinator.runAdapter({
        org: ORG,
        repo: REPO,
        taskId: TASK,
        runId: "adapter-run",
        actor: "builder-fixture",
        token: acquired.token,
        workspace,
        inputs: { taskSpecDigest: "a".repeat(64) },
        adapter: new ScriptedAgentAdapter([
          { kind: "input", name: "task-spec", digest: "a".repeat(64), size: 8 },
          { kind: "tool", tool: "git.diff", ok: true, outputDigest: "b".repeat(64) },
          { kind: "gate", gate: "typecheck", ok: true, exitCode: 0, outputDigest: "a".repeat(64) },
          {
            kind: "artifact",
            artifactId: "adapter-log",
            artifactKind: "run-log",
            digest: "b".repeat(64),
            size: 16,
          },
          { kind: "exit", status: "completed" },
        ]),
      });
      expect(result).toEqual({ status: "completed", mutations: 0, steps: 5 });
      const inspected = await coordinator.inspect({
        org: ORG,
        repo: REPO,
        taskId: TASK,
        runId: "adapter-run",
      });
      expect(inspected.run.status).toBe("completed");
      expect(inspected.run.inputs).toBe(1);
      expect(inspected.run.toolResults).toBe(1);
      expect(inspected.run.gateResults).toBe(1);
      expect(inspected.run.artifacts).toBe(1);
      expect(inspected.run.terminal).toEqual({ type: "run.exited", status: "completed" });
    } finally {
      await removeWorkspace(workspace.root);
    }
    await coordinator.release({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      leaseId: acquired.lease.leaseId,
      actor: "builder-fixture",
      token: acquired.token,
    });
  });

  it("revokes the run at the next boundary after the project pauses", async () => {
    const sources = queueSourcesFromGraph(ORG, REPO, fixtureGraph());
    const proof = queueProof(projectQueue(sources));
    const storage = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const coordinator = new AgentRunCoordinator({
      streams: storage,
      now: () => 4_000,
      random: (size) => new Uint8Array(size).fill(59),
    });
    const acquired = await coordinator.acquire({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "paused-run",
      actor: "builder-fixture",
      role: "builder",
      branch: { stream: BRANCH, head: offsetForOrdinal(0) },
      projectOffset: "-1",
      queueProof: proof,
    });
    const projectStream = `project:${ORG}/${REPO}`;
    const projectOffset = offsetForOrdinal(0);
    await storage.create(projectStream);
    await storage.append(
      projectStream,
      {
        type: "project.transitioned",
        payload: {
          v: 1,
          by: { actor: "human-fixture", role: "human" },
          to: "paused",
          expectedOffset: "-1",
          statusReason: "maintenance",
        },
        ts: 4_001,
      },
      { sequence: projectOffset, applicationOffset: projectOffset },
    );

    await expect(
      coordinator.appendRunEvent({
        org: ORG,
        repo: REPO,
        taskId: TASK,
        runId: "paused-run",
        actor: "builder-fixture",
        token: acquired.token,
        expectedOffset: acquired.run.head,
        event: runInputEvent({ name: "blocked", digest: "a".repeat(64), size: 7 }, 4_002),
      }),
    ).rejects.toThrow("lease/project-not-building");

    const inspected = await coordinator.inspect({
      org: ORG,
      repo: REPO,
      taskId: TASK,
      runId: "paused-run",
    });
    expect(inspected.lease.active).toBeNull();
    expect(inspected.lease.terminal).toBe("revoked");
    expect(inspected.run.status).toBe("aborted");
    expect(inspected.run.terminal).toEqual({ type: "run.revoked", status: "aborted" });

    await expect(
      coordinator.appendRunEvent({
        org: ORG,
        repo: REPO,
        taskId: TASK,
        runId: "paused-run",
        actor: "builder-fixture",
        token: acquired.token,
        expectedOffset: inspected.run.head,
        event: runInputEvent({ name: "blocked-again", digest: "b".repeat(64), size: 12 }, 4_003),
      }),
    ).rejects.toThrow("lease/not-active");
    const runRecords = await storage.readResolved("agent-run:maple/paused-run");
    expect(
      runRecords.filter((record) => (record as { readonly type?: unknown }).type === "run.revoked"),
    ).toHaveLength(1);
  });
});
