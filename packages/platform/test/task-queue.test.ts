import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  admitSelection,
  checkQueueProof,
  graphReadme,
  projectQueue,
  queueDigest,
  queueProof,
  renderQueueMarkdown,
  type QueueGraphTask,
  type QueueProjection,
  type QueueProof,
  type QueueSources,
} from "@eforest/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PlatformGateway,
  createPlatformServer,
  listenPlatformServer,
  type AuthzInput,
  type AuthorizationVerifier,
} from "../src/index.js";

const EVIDENCE_DIR = new URL(
  "../../../.eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/evidence/",
  import.meta.url,
);
const PRINT = process.env.EFOREST_E6_T04_PRINT === "1";
const ORG = "maple";
const REPO = "queue-live";
const AGENT = "agent-ash";
const CRITIC = "agent-fern";
const HUMAN = "human-rowan";

function artifact(name: string): string {
  return readFileSync(new URL(name, EVIDENCE_DIR), "utf8");
}

/** Freeze switch: with EFOREST_E6_T04_PRINT=1 the transcript is emitted; otherwise it must match the committed bytes. */
function expectFrozen(name: string, text: string): void {
  if (PRINT) {
    console.log(`E6_T04_ARTIFACT_BEGIN ${name}`);
    console.log(text.trimEnd());
    console.log(`E6_T04_ARTIFACT_END ${name}`);
    return;
  }
  expect(text, name).toBe(artifact(name));
}

function decideByCredential(input: AuthzInput) {
  const sub = input.principal.kind === "identified" ? input.principal.sub : "";
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: sub.startsWith("human-") ? ("repo-owner" as const) : ("grant:write" as const),
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    const sub = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : "";
    if (sub === "") throw new TypeError("missing bearer identity");
    return { sub };
  },
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function cleanEvent(record: Event, index: number): Event & { readonly offset: Offset } {
  const payload = record.payload as Record<string, unknown>;
  return {
    type: record.type,
    payload: Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    ts: record.ts,
    offset: offsetForOrdinal(index),
  };
}

interface QueueResponse {
  readonly streamId: string;
  readonly offset: string;
  readonly digest: string;
  readonly projection: QueueProjection;
  readonly proof: QueueProof;
  readonly markdown: string;
}

const task = (
  id: string,
  status: QueueGraphTask["status"],
  deps: readonly string[],
  capstone = false,
): QueueGraphTask => {
  const [epic, n] = id.slice(1).split("-T") as [string, string];
  return {
    id,
    epic: Number(epic),
    priority: String(Number(epic) * 100 + Number(n)),
    title: `Task ${id} does one thing`,
    status,
    depends_on: deps,
    estimate: "M",
    capstone,
  };
};

describe("task queue query on the real gateway (E6-T04)", () => {
  let official: ReturnType<typeof createDurableStreamTestServer>;
  let officialUrl: string;
  let streams: OfficialStreamAdapter;
  let gateway: PlatformGateway;
  let server: Server;
  let baseUrl: string;
  const transcript: string[] = [];

  beforeAll(async () => {
    official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    officialUrl = await official.start();
    streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
    gateway = newGateway();
    server = createPlatformServer((request) => gateway.handle(request));
    baseUrl = await listenPlatformServer(server);
  });

  afterAll(async () => {
    gateway.terminate();
    await closeServer(server);
    await official.stop();
  });

  function newGateway(): PlatformGateway {
    return new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl: officialUrl }),
      decideAuthorization: decideByCredential,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
    });
  }

  async function dispatchAs(sub: string, streamId: string, action: Event): Promise<Offset> {
    const response = await fetch(`${baseUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sub}`,
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: JSON.stringify({ streamId, event: action }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(202);
    return (JSON.parse(body) as { readonly offset: Offset }).offset;
  }

  async function records(
    streamId: string,
  ): Promise<readonly (Event & { readonly offset: Offset })[]> {
    try {
      return ((await streams.read(streamId)) as readonly Event[]).map(cleanEvent);
    } catch {
      return [];
    }
  }

  /** Re-read every source the way a second process would, straight from the substrate. */
  async function sources(repo: string): Promise<QueueSources> {
    const catalogStream = `repo-issues:${ORG}/${repo}`;
    const catalog = await records(catalogStream);
    const issueStreams = [
      ...new Set(
        catalog.map(
          (record) => (record.payload as { readonly issueStreamId: string }).issueStreamId,
        ),
      ),
    ].sort();
    const tasks = [];
    for (const stream of issueStreams) tasks.push({ stream, records: await records(stream) });
    return { catalog: { stream: catalogStream, records: catalog }, tasks };
  }

  async function getQueue(repo: string, sub = AGENT, url = baseUrl) {
    const response = await fetch(`${url}/api/repos/${ORG}/${repo}/queue`, {
      headers: { authorization: `Bearer ${sub}` },
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as QueueResponse };
  }

  function log(step: string, body: QueueResponse): void {
    transcript.push(
      `E6_T04_QUEUE ${canonicalJson({
        step,
        catalog: body.proof.queue,
        decision: body.proof.decision,
        digest: body.digest,
        heads: body.proof.heads,
        tasks: body.projection.tasks.map((entry) => ({
          id: entry.id,
          status: entry.status,
          blocked: entry.blocked,
        })),
      })}`,
    );
  }

  async function seed(repo: string, spec: QueueGraphTask): Promise<void> {
    const stream = `issue:${ORG}/${repo}/${spec.id}`;
    const evidence = `evidence:${ORG}/${repo}/issue/${spec.id}`;
    const branch = {
      stream: `fs:${ORG}/${repo}:b-${spec.id.toLowerCase()}:meta`,
      head: offsetForOrdinal(3),
    };
    const builder = {
      actor: AGENT,
      role: "builder" as const,
      run: `agent-run:${ORG}/${spec.id.toLowerCase()}-run-1`,
    };
    await dispatchAs(AGENT, stream, {
      type: "issue.opened",
      payload: { v: 1, title: spec.title, body: graphReadme(spec) },
      ts: 100,
    });
    await dispatchAs(AGENT, stream, {
      type: "issue.labeled",
      payload: { v: 1, label: "task" },
      ts: 101,
    });
    if (spec.capstone) {
      await dispatchAs(AGENT, stream, {
        type: "issue.labeled",
        payload: { v: 1, label: "capstone" },
        ts: 102,
      });
    }
    await dispatchAs(AGENT, evidence, {
      type: "evidence.linked",
      payload: {
        v: 1,
        attachmentId: "log-1",
        kind: "replay-recording",
        url: "https://app.replay.io/recording/log-1",
      },
      ts: 110,
    });
    if (spec.status === "pending") return;
    await dispatchAs(AGENT, stream, {
      type: "task.started",
      payload: { v: 1, by: builder },
      ts: 120,
    });
    if (spec.status === "in-progress") return;
    await dispatchAs(AGENT, stream, {
      type: "task.claimed",
      payload: {
        v: 1,
        by: builder,
        branch,
        evidence: { stream: evidence, attachmentIds: ["log-1"] },
        summary: `claim ${spec.id}`,
      },
      ts: 121,
    });
  }

  async function verify(repo: string, id: string): Promise<Offset> {
    const stream = `issue:${ORG}/${repo}/${id}`;
    const evidence = `evidence:${ORG}/${repo}/issue/${id}`;
    const branch = {
      stream: `fs:${ORG}/${repo}:b-${id.toLowerCase()}:meta`,
      head: offsetForOrdinal(3),
    };
    const critic = {
      actor: CRITIC,
      role: "critic" as const,
      run: `agent-run:${ORG}/${id.toLowerCase()}-run-2`,
    };
    const claim = (await records(stream)).find((record) => record.type === "task.claimed")!;
    return dispatchAs(CRITIC, stream, {
      type: "task.verified",
      payload: {
        v: 1,
        by: critic,
        claim: { stream, offset: claim.offset },
        branch,
        evidence: { stream: evidence, attachmentIds: ["log-1"] },
        summary: `verified ${id}`,
      },
      ts: 122,
    });
  }

  it("derives the queue from the catalog and task streams, cites every head, and re-decides at the new head", async () => {
    for (const [index, label] of ["task", "capstone"].entries()) {
      await dispatchAs(HUMAN, `repo-labels:${ORG}/${REPO}`, {
        type: "label.created",
        payload: { v: 1, labelId: label, name: label, color: "green" },
        ts: 10 + index,
      });
    }
    const empty = await getQueue(REPO);
    expect(empty.status).toBe(200);
    expect(empty.body.projection.tasks).toEqual([]);
    expect(empty.body.proof.decision).toEqual({
      kind: "exhausted",
      nextEligible: null,
      inFlight: null,
    });
    expect(empty.body.proof.queue.offset).toBe("-1");
    log("empty", empty.body);

    await seed(REPO, task("E1-T01", "implemented", []));
    await seed(REPO, task("E1-T02", "pending", ["E1-T01"]));
    await seed(REPO, task("E1-T03", "pending", ["E1-T02"], true));
    await seed(REPO, task("E2-T01", "pending", ["E1"], true));

    const first = await getQueue(REPO);
    expect(first.status).toBe(200);
    expect(first.body.streamId).toBe(`repo-issues:${ORG}/${REPO}`);
    expect(first.body.proof.decision).toEqual({
      kind: "in-flight",
      nextEligible: null,
      inFlight: "E1-T01",
    });
    expect(first.body.projection.tasks.map((entry) => entry.id)).toEqual([
      "E1-T01",
      "E1-T02",
      "E1-T03",
      "E2-T01",
    ]);
    expect(first.body.projection.tasks.find((entry) => entry.id === "E2-T01")?.blocked).toEqual([
      { reason: "dep/epic-capstone-unverified", ref: "E1", detail: "pending" },
    ]);
    // Every cited head is the actual current head of that stream, and a second process
    // replaying the same streams derives the same digest, proof, and markdown.
    const before = await sources(REPO);
    expect(first.body.proof.queue.offset).toBe(offsetForOrdinal(before.catalog.records.length - 1));
    for (const head of first.body.proof.heads) {
      const stream = before.tasks.find((entry) => entry.stream === head.stream)!;
      expect(head.offset, head.stream).toBe(offsetForOrdinal(stream.records.length - 1));
    }
    const replayed = projectQueue(before);
    expect(queueDigest(replayed)).toBe(first.body.digest);
    expect(canonicalJson(queueProof(replayed))).toBe(canonicalJson(first.body.proof));
    expect(renderQueueMarkdown(replayed)).toBe(first.body.markdown);
    expect(checkQueueProof(first.body.proof, before)).toMatchObject({ ok: true });
    log("in-flight", first.body);

    // A second gateway on the same substrate returns the identical body.
    const other = newGateway();
    const otherServer = createPlatformServer((request) => other.handle(request));
    const otherUrl = await listenPlatformServer(otherServer);
    try {
      const twin = await getQueue(REPO, AGENT, otherUrl);
      expect(twin.text).toBe(first.text);
    } finally {
      other.terminate();
      await closeServer(otherServer);
    }

    const verdictOffset = await verify(REPO, "E1-T01");
    const second = await getQueue(REPO);
    expect(second.body.proof.decision).toEqual({
      kind: "eligible",
      nextEligible: "E1-T02",
      inFlight: null,
    });
    expect(second.body.proof.heads.find((head) => head.stream.endsWith("/E1-T01"))?.offset).toBe(
      verdictOffset,
    );
    expect(second.body.digest).not.toBe(first.body.digest);
    const after = await sources(REPO);
    // The old proof is stale, and it names the exact stream that moved.
    const cited = first.body.proof.heads.find((head) => head.stream.endsWith("/E1-T01"))!.offset;
    expect(checkQueueProof(first.body.proof, after)).toMatchObject({
      ok: false,
      reason: "queue/stale-proof",
      stale: { stream: `issue:${ORG}/${REPO}/E1-T01`, cited, current: verdictOffset },
    });
    expect(admitSelection(first.body.proof, "E1-T02", after)).toMatchObject({
      ok: false,
      reason: "queue/stale-proof",
    });
    expect(admitSelection(second.body.proof, "E1-T02", after)).toMatchObject({ ok: true });
    expect(admitSelection(second.body.proof, "E1-T03", after)).toMatchObject({
      ok: false,
      reason: "queue/not-eligible",
    });
    log("eligible", second.body);

    // A second active task is impossible through the door (E6-T01 refuses nothing here —
    // starting E1-T02 is legal) but the queue is honest about it: after E1-T02 starts,
    // E1-T03 stays blocked and nothing else is eligible.
    const builder = {
      actor: AGENT,
      role: "builder" as const,
      run: `agent-run:${ORG}/e1-t02-run-1`,
    };
    await dispatchAs(AGENT, `issue:${ORG}/${REPO}/E1-T02`, {
      type: "task.started",
      payload: { v: 1, by: builder },
      ts: 130,
    });
    const third = await getQueue(REPO);
    expect(third.body.proof.decision).toEqual({
      kind: "in-flight",
      nextEligible: null,
      inFlight: "E1-T02",
    });
    log("second-in-flight", third.body);

    expectFrozen("e6-t04-endpoint.txt", `${transcript.join("\n")}\n`);
  });

  it("refuses bad requests before touching any stream", async () => {
    const post = await fetch(`${baseUrl}/api/repos/${ORG}/${REPO}/queue`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT}` },
    });
    expect(post.status).toBe(405);
    const malformed = await fetch(`${baseUrl}/api/repos/${ORG}/Not%20A%20Repo/queue`, {
      headers: { authorization: `Bearer ${AGENT}` },
    });
    expect(malformed.status).toBe(404);
  });
});
