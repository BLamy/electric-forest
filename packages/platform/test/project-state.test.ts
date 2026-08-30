import type { Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  OFFSET_BEFORE_FIRST,
  canonicalJson,
  sha256Hex,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { replayWithReducer } from "@eforest/reducers";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PROJECT_REFUSAL_REASONS,
  PlatformGateway,
  createPlatformServer,
  guardLoopAction,
  listenPlatformServer,
  projectProjectionBytes,
  projectReducerDefinition,
  replayProjectLog,
  type AuthzInput,
  type AuthorizationVerifier,
  type ProjectActorRole,
  type ProjectQueueProof,
  type ProjectState,
  type ProjectStatus,
} from "../src/index.js";
import {
  AGENT,
  CRITIC,
  HUMAN,
  LIFECYCLE_EVENTS,
  LIFECYCLE_FENCES,
  LIFECYCLE_PROOF,
  LIFECYCLE_REPO,
  LIFECYCLE_STREAM,
  MATRIX,
  ORG,
  launch,
  transition,
  type MatrixAction,
  type MatrixRow,
} from "./project-golden.js";

const EVIDENCE_DIR = new URL(
  "../../../.eforest/tasks/epic-6-the-loop/E6-T03-project-state-machine/evidence/",
  import.meta.url,
);
const WORK_DIR = new URL(
  "../../../.eforest/tasks/epic-6-the-loop/E6-T03-project-state-machine/work/projection/",
  import.meta.url,
);
const PRINT = process.env.EFOREST_E6_T03_PRINT === "1";

function artifact(name: string): string {
  return readFileSync(new URL(name, EVIDENCE_DIR), "utf8");
}

/** Freeze switch: with EFOREST_E6_T03_PRINT=1 the artifact is emitted for capture; otherwise it must match the committed bytes. */
function expectFrozen(name: string, text: string): void {
  if (PRINT) {
    console.log(`E6_T03_ARTIFACT_BEGIN ${name}`);
    console.log(text.trimEnd());
    console.log(`E6_T03_ARTIFACT_END ${name}`);
    return;
  }
  expect(text, name).toBe(artifact(name));
}

interface DispatchResult {
  readonly status: number;
  readonly body: string;
  readonly offset?: Offset;
}

interface LogSnapshot {
  readonly streamId: string;
  readonly headOffset: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly dumpSha256: string;
}

const encoder = new TextEncoder();

/**
 * The authorization oracle of this suite: `human-*` subjects are validated owner web
 * sessions (basis `repo-owner`, which the real decision grants only to
 * `principal.session === true`); every other subject is a grant-backed bearer token
 * (basis `grant:write`). The gateway derives the project actor role from that basis.
 */
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

function cleanEvent(record: Event): Event & { readonly offset?: Offset } {
  const payload = record.payload as Record<string, unknown>;
  const offset = (record as Event & { readonly offset?: Offset }).offset;
  return {
    type: record.type,
    payload: Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    ts: record.ts,
    ...(offset === undefined ? {} : { offset }),
  };
}

function actorOf(action: Event): string {
  const payload = action.payload as { readonly by?: { readonly actor?: string } };
  return payload.by?.actor ?? AGENT;
}

function projectStream(repo: string): string {
  return `project:${ORG}/${repo}`;
}
function issueStream(repo: string, id: string): string {
  return `issue:${ORG}/${repo}/${id}`;
}
function evidenceStream(repo: string, id: string): string {
  return `evidence:${ORG}/${repo}/issue/${id}`;
}
function catalogStream(repo: string): string {
  return `repo-issues:${ORG}/${repo}`;
}

type SeededStatus = "opened" | "in-progress" | "implemented" | "refuted" | "verified";

interface SeededTask {
  readonly id: string;
  readonly stream: string;
  readonly evidence: string;
  readonly branch: { readonly stream: string; readonly head: Offset };
  readonly claimOffset?: Offset;
  readonly verdictOffset?: Offset;
}

describe("project state machine on the real dispatch door", () => {
  let official: ReturnType<typeof createDurableStreamTestServer>;
  let officialUrl: string;
  let streams: OfficialStreamAdapter;
  let gateway: PlatformGateway;
  let server: Server;
  let baseUrl: string;
  const labeledRepos = new Set<string>();

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

  async function dispatchAs(
    sub: string,
    streamId: string,
    action: Event,
    url = baseUrl,
  ): Promise<DispatchResult> {
    const response = await fetch(`${url}/api/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sub}`,
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: JSON.stringify({ streamId, event: action }),
    });
    const body = await response.text();
    let offset: Offset | undefined;
    try {
      const decoded = JSON.parse(body) as { readonly offset?: unknown };
      if (typeof decoded.offset === "string") offset = decoded.offset as Offset;
    } catch {
      // raw body stays the oracle
    }
    return { status: response.status, body, ...(offset === undefined ? {} : { offset }) };
  }

  async function accepted(result: Promise<DispatchResult>): Promise<Offset> {
    const response = await result;
    expect(response.status, response.body).toBe(202);
    expect(response.offset).toBeDefined();
    return response.offset!;
  }

  async function records(streamId: string): Promise<readonly Event[]> {
    try {
      return (await streams.read(streamId)) as readonly Event[];
    } catch {
      return [];
    }
  }

  async function snapshot(streamId: string): Promise<LogSnapshot> {
    const found = await records(streamId);
    const dump =
      found.length === 0 ? "" : `${found.map((record) => canonicalJson(record)).join("\n")}\n`;
    return {
      streamId,
      headOffset:
        (found.at(-1) as (Event & { readonly offset?: Offset }) | undefined)?.offset ??
        OFFSET_BEFORE_FIRST,
      dumpSha256: sha256Hex(encoder.encode(dump)),
    };
  }

  async function cleanDump(streamId: string): Promise<string> {
    const found = await records(streamId);
    return found.length === 0
      ? ""
      : `${found.map((record) => canonicalJson(cleanEvent(record))).join("\n")}\n`;
  }

  /** The offset a dispatcher must cite: `state.head` for a project stream (fences do not move it). */
  async function head(streamId: string): Promise<number> {
    const found = await records(streamId);
    if (!streamId.startsWith("project:")) return found.length - 1;
    const state = replayProjectLog(streamId, found);
    return state.head === OFFSET_BEFORE_FIRST ? -1 : Number(state.head.split("_")[1]);
  }

  async function getProject(repo: string, sub = AGENT, url = baseUrl) {
    const response = await fetch(`${url}/api/repos/${ORG}/${repo}/project`, {
      headers: { authorization: `Bearer ${sub}` },
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: JSON.parse(text) as {
        readonly streamId: string;
        readonly offset: string;
        readonly digest: string;
        readonly state: ProjectState;
        readonly projection: string;
      },
    };
  }

  async function ensureLabels(repo: string): Promise<void> {
    if (labeledRepos.has(repo)) return;
    labeledRepos.add(repo);
    for (const [index, label] of ["task", "capstone"].entries()) {
      await accepted(
        dispatchAs(HUMAN, `repo-labels:${ORG}/${repo}`, {
          type: "label.created",
          payload: { v: 1, labelId: label, name: label, color: "green" },
          ts: 10 + index,
        }),
      );
    }
  }

  /** Drive one task through the E6-T01 door to the requested status. */
  async function seedTask(
    repo: string,
    id: string,
    target: SeededStatus,
    labels: readonly string[] = [],
  ): Promise<SeededTask> {
    await ensureLabels(repo);
    const stream = issueStream(repo, id);
    const evidence = evidenceStream(repo, id);
    const branch = { stream: `fs:${ORG}/${repo}:b-${id}:meta`, head: offsetForOrdinal(3) };
    const builder = { actor: AGENT, role: "builder" as const, run: `agent-run:${ORG}/${id}-run-1` };
    const critic = { actor: CRITIC, role: "critic" as const, run: `agent-run:${ORG}/${id}-run-2` };
    await accepted(
      dispatchAs(AGENT, stream, {
        type: "issue.opened",
        payload: { v: 1, title: `Task ${id}`, body: "seeded" },
        ts: 100,
      }),
    );
    for (const [index, label] of labels.entries()) {
      await accepted(
        dispatchAs(AGENT, stream, {
          type: "issue.labeled",
          payload: { v: 1, label },
          ts: 101 + index,
        }),
      );
    }
    await accepted(
      dispatchAs(AGENT, evidence, {
        type: "evidence.linked",
        payload: {
          v: 1,
          attachmentId: "log-1",
          kind: "replay-recording",
          url: "https://app.replay.io/recording/log-1",
        },
        ts: 110,
      }),
    );
    let task: SeededTask = { id, stream, evidence, branch };
    if (target === "opened") return task;
    await accepted(
      dispatchAs(AGENT, stream, { type: "task.started", payload: { v: 1, by: builder }, ts: 120 }),
    );
    if (target === "in-progress") return task;
    const claimOffset = await accepted(
      dispatchAs(AGENT, stream, {
        type: "task.claimed",
        payload: {
          v: 1,
          by: builder,
          branch,
          evidence: { stream: evidence, attachmentIds: ["log-1"] },
          summary: `claim for ${id}`,
        },
        ts: 121,
      }),
    );
    task = { ...task, claimOffset };
    if (target === "implemented") return task;
    const verdict = { stream, offset: claimOffset };
    const verdictOffset = await accepted(
      dispatchAs(
        CRITIC,
        stream,
        target === "verified"
          ? {
              type: "task.verified",
              payload: {
                v: 1,
                by: critic,
                claim: verdict,
                branch,
                evidence: { stream: evidence, attachmentIds: ["log-1"] },
                summary: `verified ${id}`,
              },
              ts: 122,
            }
          : {
              type: "task.refuted",
              payload: {
                v: 1,
                by: critic,
                claim: verdict,
                branch,
                evidence: { stream: evidence, attachmentIds: ["log-1"] },
                findings: [
                  {
                    fingerprint: "digest-diverges",
                    summary: "replayed digest differs from the claim",
                    citation: { stream: evidence, attachmentId: "log-1" },
                  },
                ],
              },
              ts: 122,
            },
      ),
    );
    return { ...task, verdictOffset };
  }

  async function realProof(repo: string): Promise<ProjectQueueProof> {
    const catalog = await records(catalogStream(repo));
    const issues = catalog
      .map((record) => (record.payload as { readonly issueStreamId: string }).issueStreamId)
      .sort();
    const tasks: ProjectQueueProof["tasks"][number][] = [];
    for (const stream of issues) {
      const raw = (await records(stream)).map((record, index) => ({
        ...cleanEvent(record),
        offset: offsetForOrdinal(index),
      }));
      const { replayTaskLog } = await import("@eforest/tasks");
      const state = replayTaskLog(stream, raw);
      const ever = (label: string) =>
        raw.some(
          (record) =>
            record.type === "issue.labeled" &&
            (record.payload as { readonly label?: string }).label === label,
        );
      const isTask =
        state.attempts.length > 0 ||
        raw.some((record) => record.type.startsWith("task.")) ||
        ever("task") ||
        ever("capstone");
      if (!isTask) continue;
      tasks.push({ id: state.taskId, status: state.status, capstone: ever("capstone") });
    }
    return {
      queue: { stream: catalogStream(repo), offset: offsetForOrdinal(catalog.length - 1) },
      project: { offset: await projectTail(repo) },
      tasks,
    };
  }

  /** The project stream's fence-inclusive durable tail (what a completion proof must cite). */
  async function projectTail(repo: string): Promise<Offset | typeof OFFSET_BEFORE_FIRST> {
    const found = await records(projectStream(repo));
    return found.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(found.length - 1);
  }

  it("drives the frozen lifecycle end to end and dumps the committed project log", async () => {
    await seedTask(LIFECYCLE_REPO, "loom-t1", "verified", ["task"]);
    await seedTask(LIFECYCLE_REPO, "loom-cap", "verified", ["capstone"]);
    // Before the lifecycle the tail is the last seeded fence (5); the frozen proof cites
    // the tail at completion time (11).
    expect(await realProof(LIFECYCLE_REPO)).toEqual({
      ...LIFECYCLE_PROOF,
      project: { offset: offsetForOrdinal(LIFECYCLE_FENCES - 1) },
    });
    const fresh = await getProject(LIFECYCLE_REPO);
    expect(fresh.status).toBe(200);
    expect(fresh.body.state.status).toBe("building");
    expect(fresh.body.offset).toBe(OFFSET_BEFORE_FIRST);
    // The two seeded tasks left six fences (started/claimed/verified each) at offsets 0-5.
    const fences = (await records(LIFECYCLE_STREAM)).length;
    expect(fences).toBe(LIFECYCLE_FENCES);
    for (const [index, action] of LIFECYCLE_EVENTS.entries()) {
      const offset = await accepted(dispatchAs(actorOf(action), LIFECYCLE_STREAM, action));
      expect(offset).toBe(offsetForOrdinal(LIFECYCLE_FENCES + index));
    }
    const dump = await cleanDump(LIFECYCLE_STREAM);
    expectFrozen("e6-t03-project.jsonl", dump);
    const raw = await records(LIFECYCLE_STREAM);
    const state = replayProjectLog(LIFECYCLE_STREAM, raw);
    const shared = replayWithReducer(projectReducerDefinition, raw, LIFECYCLE_STREAM);
    expect(shared.digest).toBe(stateDigest(state));
    expectFrozen("e6-t03-project.state.json", `${canonicalJson(state)}\n`);
    expectFrozen("e6-t03-project.digest", `${stateDigest(state)}\n`);
    expect(state.status).toBe("complete");
    expect(state.transitions).toBe(5);
    expect(state.launches).toBe(2);
    expect(state.fences).toBe(LIFECYCLE_FENCES);
    expect(state.completion).toEqual({
      queue: LIFECYCLE_PROOF.queue,
      tasks: 2,
      capstone: "loom-cap",
    });
    expect(state.updatedAt).toBe(2006);
    expect(state.actor).toBe(AGENT);
    expect(state.actorRole).toBe("agent");
    const projection = projectProjectionBytes(state);
    expectFrozen("e6-t03-project.json", projection);
    const view = await getProject(LIFECYCLE_REPO);
    expect(view.body.digest).toBe(stateDigest(state));
    expect(canonicalJson(view.body.state)).toBe(canonicalJson(state));
    expect(view.body.projection).toBe(projection);
    expect(view.body.offset).toBe(offsetForOrdinal(LIFECYCLE_FENCES + 6));
  });

  it("holds every state x role x action tuple to the frozen matrix", async () => {
    const transcript: string[] = [];
    const seeded = new Map<string, Map<string, SeededTask>>();
    let fresh = 0;

    async function setupRepo(repo: string, state: ProjectStatus, shared: boolean): Promise<void> {
      await ensureLabels(repo);
      const tasks = new Map<string, SeededTask>();
      seeded.set(repo, tasks);
      if (state === "building" && !shared) {
        // A fresh building repo whose only loop task is a verified capstone: the true
        // queue proof of the accepted `to:complete+proof` rows.
        tasks.set("cap", await seedTask(repo, "cap", "verified", ["capstone"]));
      }
      if (state === "complete") {
        tasks.set("cap", await seedTask(repo, "cap", "verified", ["capstone"]));
        await accepted(
          dispatchAs(
            AGENT,
            projectStream(repo),
            transition(AGENT, "agent", "complete", -1, "all verified", 300, await realProof(repo)),
          ),
        );
      } else if (state === "paused") {
        await accepted(
          dispatchAs(
            HUMAN,
            projectStream(repo),
            transition(HUMAN, "human", "paused", -1, "halted", 300),
          ),
        );
      } else if (state === "invalid_loop") {
        await accepted(
          dispatchAs(
            AGENT,
            projectStream(repo),
            transition(AGENT, "agent", "invalid_loop", -1, "death-spiral", 300),
          ),
        );
      }
      // A plain issue every state can attempt a loop event on (not a loop task, so it
      // never disturbs a completion proof).
      tasks.set("t-open", await seedTask(repo, "t-open", "opened"));
      if (state === "building" && shared) {
        tasks.set("t-open-h", await seedTask(repo, "t-open-h", "opened"));
        tasks.set("t-prog", await seedTask(repo, "t-prog", "in-progress"));
        tasks.set("t-impl", await seedTask(repo, "t-impl", "implemented"));
        tasks.set("t-impl2", await seedTask(repo, "t-impl2", "implemented"));
        tasks.set("t-ref", await seedTask(repo, "t-ref", "refuted"));
      }
    }

    function taskEvent(row: MatrixRow, task: SeededTask): Event {
      const builderActor = row.role === "human" ? HUMAN : AGENT;
      const builder = {
        actor: builderActor,
        role: "builder" as const,
        run: `agent-run:${ORG}/${task.id}-run-9`,
      };
      const critic = {
        actor: CRITIC,
        role: "critic" as const,
        run: `agent-run:${ORG}/${task.id}-run-9`,
      };
      const claim = { stream: task.stream, offset: task.claimOffset ?? offsetForOrdinal(2) };
      const evidence = { stream: task.evidence, attachmentIds: ["log-1"] };
      switch (row.action) {
        case "task.started":
          return { type: "task.started", payload: { v: 1, by: builder }, ts: 400 };
        case "task.claimed":
          return {
            type: "task.claimed",
            payload: { v: 1, by: builder, branch: task.branch, evidence, summary: "matrix claim" },
            ts: 401,
          };
        case "task.refuted":
          return {
            type: "task.refuted",
            payload: {
              v: 1,
              by: critic,
              claim,
              branch: task.branch,
              evidence,
              findings: [
                {
                  fingerprint: "matrix-finding",
                  summary: "matrix refutation",
                  citation: { stream: task.evidence, attachmentId: "log-1" },
                },
              ],
            },
            ts: 402,
          };
        case "task.rework-started":
          return {
            type: "task.rework-started",
            payload: {
              v: 1,
              by: builder,
              refutation: {
                stream: task.stream,
                offset: task.verdictOffset ?? offsetForOrdinal(3),
              },
            },
            ts: 403,
          };
        case "task.verified":
          return {
            type: "task.verified",
            payload: {
              v: 1,
              by: critic,
              claim,
              branch: task.branch,
              evidence,
              summary: "matrix verdict",
            },
            ts: 404,
          };
        default:
          throw new Error(`not a task action: ${row.action}`);
      }
    }

    function taskFor(row: MatrixRow, repo: string): SeededTask {
      const tasks = seeded.get(repo)!;
      if (row.state !== "building") return tasks.get("t-open")!;
      const key: Record<MatrixAction, string> = {
        "task.started": row.role === "human" ? "t-open-h" : "t-open",
        "task.claimed": "t-prog",
        "task.refuted": "t-impl",
        "task.rework-started": "t-ref",
        "task.verified": "t-impl2",
        launch: "",
        "to:building": "",
        "to:paused": "",
        "to:invalid_loop": "",
        "to:complete": "",
        "to:complete+proof": "",
      };
      return tasks.get(key[row.action])!;
    }

    const dummyProof = (repo: string): ProjectQueueProof => ({
      queue: { stream: catalogStream(repo), offset: offsetForOrdinal(0) },
      project: { offset: OFFSET_BEFORE_FIRST },
      tasks: [{ id: "cap", status: "verified", capstone: true }],
    });

    for (const state of ["building", "paused", "invalid_loop", "complete"] as const) {
      const slug = state.replace("_", "-");
      const shared = `m-${slug}`;
      await setupRepo(shared, state, true);
      for (const row of MATRIX.filter((candidate) => candidate.state === state)) {
        let repo = shared;
        if (row.expect === "accepted" && row.action.startsWith("to:")) {
          fresh += 1;
          repo = `m-${slug}-${fresh}`;
          await setupRepo(repo, state, false);
        }
        const stream = projectStream(repo);
        const sub =
          row.role === "human"
            ? HUMAN
            : row.action === "task.refuted" || row.action === "task.verified"
              ? CRITIC
              : AGENT;
        const expected = await head(stream);
        const isTaskAction = row.action.startsWith("task.");
        const task = isTaskAction ? taskFor(row, repo) : undefined;
        const targetStream = task === undefined ? stream : task.stream;
        const event: Event =
          task !== undefined
            ? taskEvent(row, task)
            : row.action === "launch"
              ? launch(sub, row.role, expected, `${repo}-run-${row.role}`, 500)
              : row.action === "to:complete+proof"
                ? transition(
                    sub,
                    row.role,
                    "complete",
                    expected,
                    `matrix ${row.role} -> complete with proof`,
                    501,
                    state === "building" ? await realProof(repo) : dummyProof(repo),
                  )
                : transition(
                    sub,
                    row.role,
                    row.action.slice("to:".length) as ProjectStatus,
                    expected,
                    `matrix ${row.role} -> ${row.action.slice("to:".length)}`,
                    502,
                  );
        const before = { project: await snapshot(stream), target: await snapshot(targetStream) };
        const response = await dispatchAs(sub, targetStream, event);
        const after = { project: await snapshot(stream), target: await snapshot(targetStream) };
        const name = `${row.state}/${row.role}/${row.action}`;
        if (row.expect === "accepted") {
          expect(response.status, `${name}: ${response.body}`).toBe(202);
          // A project event advances the project head; an accepted task loop event
          // advances the task stream AND leaves one `project.fenced` record behind.
          expect(after.project.headOffset, name).not.toBe(before.project.headOffset);
          expect(after.target.headOffset).toBe(response.offset);
          if (isTaskAction) {
            const fence = (await records(stream)).at(-1) as Event;
            expect(fence.type).toBe("project.fenced");
            const target = (
              fence.payload as {
                target: { stream: string; offset: string; type: string; writer: { sub: string } };
              }
            ).target;
            expect(target.stream).toBe(targetStream);
            expect(target.offset).toBe(response.offset);
            expect(target.type).toBe(row.action);
            expect(target.writer.sub).toBe(sub);
          }
        } else {
          expect(response.status, `${name}: ${response.body}`).toBe(409);
          const body = JSON.parse(response.body) as {
            readonly error: {
              readonly class: string;
              readonly reason: string;
              readonly project: unknown;
            };
          };
          expect(body.error.class).toBe("validator-rejected");
          expect(body.error.reason, name).toBe(row.expect);
          expect(body.error.project).toEqual({
            stream,
            offset: before.project.headOffset,
            status: row.state,
          });
          expect(after, name).toEqual(before);
        }
        transcript.push(
          `E6_T03_MATRIX ${canonicalJson({
            name,
            repo,
            streamId: targetStream,
            requestBody: JSON.stringify({ streamId: targetStream, event }),
            status: response.status,
            responseBody: response.body,
            before,
            after,
          })}`,
        );
      }
    }

    // Binding, shape, and family refusals on the shared building repo.
    const repo = "m-building";
    const stream = projectStream(repo);
    const expected = await head(stream);
    const extra: readonly {
      readonly name: string;
      readonly sub: string;
      readonly streamId: string;
      readonly event: Event;
      readonly status: number;
      readonly reason?: string;
    }[] = [
      {
        name: "project-event-on-issue-stream",
        sub: HUMAN,
        streamId: seeded.get(repo)!.get("t-open")!.stream,
        event: transition(HUMAN, "human", "paused", expected, "wrong stream", 600),
        status: 404,
      },
      {
        name: "issue-event-on-project-stream",
        sub: AGENT,
        streamId: stream,
        event: { type: "issue.opened", payload: { v: 1, title: "x", body: "y" }, ts: 601 },
        status: 404,
      },
      {
        name: "launch-unknown-field",
        sub: AGENT,
        streamId: stream,
        event: {
          type: "loop.launch.requested",
          payload: { ...(launch(AGENT, "agent", expected, "x", 602).payload as object), extra: 1 },
          ts: 602,
        },
        status: 422,
      },
      {
        name: "transition-empty-reason",
        sub: HUMAN,
        streamId: stream,
        event: transition(HUMAN, "human", "paused", expected, "", 603),
        status: 422,
      },
      {
        name: "transition-unknown-state",
        sub: HUMAN,
        streamId: stream,
        event: transition(HUMAN, "human", "done" as ProjectStatus, expected, "bogus", 604),
        status: 422,
      },
      {
        name: "transition-whitespace-reason",
        sub: HUMAN,
        streamId: stream,
        event: transition(HUMAN, "human", "paused", expected, "   \t", 612),
        status: 422,
      },
      {
        name: "launch-loose-expected-offset",
        sub: AGENT,
        streamId: stream,
        event: {
          type: "loop.launch.requested",
          payload: {
            v: 1,
            by: { actor: AGENT, role: "agent" },
            expectedOffset: "3",
            run: `agent-run:${ORG}/loose`,
          },
          ts: 613,
        },
        status: 422,
      },
      {
        name: "launch-foreign-org-run",
        sub: AGENT,
        streamId: stream,
        event: {
          type: "loop.launch.requested",
          payload: {
            v: 1,
            by: { actor: AGENT, role: "agent" },
            expectedOffset: expected < 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(expected),
            run: "agent-run:otherorg/z",
          },
          ts: 614,
        },
        status: 409,
        reason: "project/foreign-run",
      },
      {
        name: "actor-mismatch",
        sub: HUMAN,
        streamId: stream,
        event: transition("human-other", "human", "paused", expected, "forged actor", 605),
        status: 409,
        reason: "project/actor-mismatch",
      },
      {
        name: "agent-claims-human-role",
        sub: AGENT,
        streamId: stream,
        event: transition(AGENT, "human", "paused", expected, "forged role", 606),
        status: 409,
        reason: "project/role-mismatch",
      },
      {
        name: "human-claims-agent-role",
        sub: HUMAN,
        streamId: stream,
        event: transition(HUMAN, "agent", "paused", expected, "forged role", 607),
        status: 409,
        reason: "project/role-mismatch",
      },
      {
        name: "stale-offset-launch",
        sub: AGENT,
        streamId: stream,
        event: launch(AGENT, "agent", expected + 7, "stale", 608),
        status: 409,
        reason: "project/stale-offset",
      },
      {
        name: "task-validator-refusal-builder-mismatch",
        sub: AGENT,
        streamId: seeded.get(repo)!.get("t-open-h")!.stream,
        event: {
          type: "task.claimed",
          payload: {
            v: 1,
            by: { actor: AGENT, role: "builder", run: `agent-run:${ORG}/t-open-h-run-9` },
            branch: seeded.get(repo)!.get("t-open-h")!.branch,
            evidence: {
              stream: seeded.get(repo)!.get("t-open-h")!.evidence,
              attachmentIds: ["log-1"],
            },
            summary: "claim by an agent on a task the human started",
          },
          ts: 615,
        },
        status: 409,
        reason: "task/builder-mismatch",
      },
      {
        name: "task-validator-refusal-builder-verifies",
        sub: AGENT,
        streamId: seeded.get(repo)!.get("t-open-h")!.stream,
        event: {
          type: "task.verified",
          payload: {
            v: 1,
            by: { actor: AGENT, role: "builder", run: `agent-run:${ORG}/t-open-run-9` },
            claim: { stream: seeded.get(repo)!.get("t-open")!.stream, offset: offsetForOrdinal(2) },
            branch: seeded.get(repo)!.get("t-open")!.branch,
            evidence: {
              stream: seeded.get(repo)!.get("t-open")!.evidence,
              attachmentIds: ["log-1"],
            },
            summary: "builder verifies",
          },
          ts: 616,
        },
        status: 409,
        reason: "task/wrong-role",
      },
      {
        name: "stale-offset-pause",
        sub: HUMAN,
        streamId: stream,
        event: transition(HUMAN, "human", "paused", expected - 1, "stale pause", 609),
        status: 409,
        reason: "project/stale-offset",
      },
      {
        name: "pause-with-proof",
        sub: HUMAN,
        streamId: stream,
        event: transition(
          HUMAN,
          "human",
          "paused",
          expected,
          "proof on a pause",
          610,
          dummyProof(repo),
        ),
        status: 409,
        reason: "project/invalid-transition",
      },
      {
        name: "complete-empty-proof",
        sub: AGENT,
        streamId: stream,
        event: transition(AGENT, "agent", "complete", expected, "empty proof", 611, {
          queue: { stream: catalogStream(repo), offset: offsetForOrdinal(0) },
          project: { offset: await projectTail(repo) },
          tasks: [],
        }),
        status: 409,
        reason: "project/false-proof",
      },
    ];
    for (const scenario of extra) {
      const before = { target: await snapshot(scenario.streamId), project: await snapshot(stream) };
      const response = await dispatchAs(scenario.sub, scenario.streamId, scenario.event);
      const after = { target: await snapshot(scenario.streamId), project: await snapshot(stream) };
      expect(response.status, `${scenario.name}: ${response.body}`).toBe(scenario.status);
      if (scenario.reason !== undefined) {
        expect((JSON.parse(response.body) as { error: { reason: string } }).error.reason).toBe(
          scenario.reason,
        );
      }
      expect(after, scenario.name).toEqual(before);
      transcript.push(
        `E6_T03_REFUSAL ${canonicalJson({
          name: scenario.name,
          streamId: scenario.streamId,
          requestBody: JSON.stringify({ streamId: scenario.streamId, event: scenario.event }),
          status: response.status,
          responseBody: response.body,
          before,
          after,
        })}`,
      );
    }
    const malformed = await fetch(`${baseUrl}/api/repos/Maple/${repo}/project`, {
      headers: { authorization: `Bearer ${AGENT}` },
    });
    expect(malformed.status).toBe(404);
    const text = `${transcript.join("\n")}\n`;
    expectFrozen("e6-t03-matrix.txt", text);
  }, 600_000);

  it("refuses every forged completion proof and accepts only the true one", async () => {
    const repo = "forge";
    const stream = projectStream(repo);
    const transcript: string[] = [];
    await seedTask(repo, "f-t1", "verified", ["task"]);
    await seedTask(repo, "f-cap", "verified", ["capstone"]);
    const truth = await realProof(repo);
    expect(truth.tasks.map((task) => task.id)).toEqual(["f-cap", "f-t1"]);
    const cap = truth.tasks[0]!;
    const t1 = truth.tasks[1]!;

    async function attempt(
      name: string,
      partial: Omit<ProjectQueueProof, "project"> & {
        readonly project?: ProjectQueueProof["project"];
      },
      expectReason: string | undefined,
      sub = AGENT,
      role: ProjectActorRole = "agent",
    ): Promise<void> {
      const proof: ProjectQueueProof = {
        queue: partial.queue,
        project: partial.project ?? { offset: await projectTail(repo) },
        tasks: partial.tasks,
      };
      const expected = await head(stream);
      const event = transition(sub, role, "complete", expected, `forge: ${name}`, 700, proof);
      const before = await snapshot(stream);
      const response = await dispatchAs(sub, stream, event);
      const after = await snapshot(stream);
      if (expectReason === undefined) {
        expect(response.status, `${name}: ${response.body}`).toBe(202);
        expect(after.headOffset).toBe(response.offset);
      } else {
        expect(response.status, `${name}: ${response.body}`).toBe(409);
        expect(
          (JSON.parse(response.body) as { error: { reason: string } }).error.reason,
          name,
        ).toBe(expectReason);
        expect(after, name).toEqual(before);
      }
      transcript.push(
        `E6_T03_PROOF ${canonicalJson({
          name,
          streamId: stream,
          requestBody: JSON.stringify({ streamId: stream, event }),
          status: response.status,
          responseBody: response.body,
          before,
          after,
        })}`,
      );
    }

    const queue = truth.queue;
    await attempt("missing-capstone", { queue, tasks: [t1] }, "project/false-proof");
    await attempt(
      "stale-project-tail",
      { queue, project: { offset: OFFSET_BEFORE_FIRST }, tasks: [cap, t1] },
      "project/stale-proof",
    );
    await attempt(
      "capstone-flag-stripped",
      { queue, tasks: [{ ...cap, capstone: false }, t1] },
      "project/false-proof",
    );
    await attempt(
      "two-capstones",
      { queue, tasks: [cap, { ...t1, capstone: true }] },
      "project/false-proof",
    );
    await attempt("duplicate-task-id", { queue, tasks: [cap, t1, t1] }, "project/false-proof");
    await attempt(
      "stale-queue-head",
      { queue: { stream: queue.stream, offset: offsetForOrdinal(0) }, tasks: [cap, t1] },
      "project/stale-proof",
    );
    await attempt(
      "future-queue-head",
      { queue: { stream: queue.stream, offset: offsetForOrdinal(5) }, tasks: [cap, t1] },
      "project/stale-proof",
    );
    await attempt(
      "foreign-queue-stream",
      { queue: { stream: catalogStream("loom"), offset: queue.offset }, tasks: [cap, t1] },
      "project/false-proof",
    );
    await attempt(
      "invented-task",
      { queue, tasks: [cap, t1, { id: "f-ghost", status: "verified", capstone: false }] },
      "project/false-proof",
    );
    // A pending task that "looks optional": labeled `task`, never started.
    await seedTask(repo, "f-pend", "opened", ["task"]);
    const withPending = await realProof(repo);
    expect(withPending.tasks.find((task) => task.id === "f-pend")?.status).toBe("pending");
    await attempt(
      "omits-pending-task",
      { queue: withPending.queue, tasks: [cap, t1] },
      "project/false-proof",
    );
    await attempt("stale-after-new-task", { queue, tasks: [cap, t1] }, "project/stale-proof");
    await attempt("reports-pending-honestly", withPending, "project/false-proof");
    await attempt(
      "tampers-pending-to-verified",
      {
        queue: withPending.queue,
        tasks: withPending.tasks.map((task) =>
          task.id === "f-pend" ? { ...task, status: "verified" as const } : task,
        ),
      },
      "project/false-proof",
    );
    // The proving agent retracts the `task` label: membership is history, not labels.
    await accepted(
      dispatchAs(AGENT, issueStream(repo, "f-pend"), {
        type: "issue.unlabeled",
        payload: { v: 1, label: "task" },
        ts: 130,
      }),
    );
    const afterUnlabel = await realProof(repo);
    expect(afterUnlabel.tasks.map((task) => task.id)).toContain("f-pend");
    await attempt(
      "unlabel-then-omit-pending",
      { queue: afterUnlabel.queue, tasks: [cap, t1] },
      "project/false-proof",
    );
    // A plain issue (never started, never labeled) is not a task: citing it is a false
    // proof, and omitting it never blocks completion.
    await seedTask(repo, "f-plain", "opened");
    const withPlain = await realProof(repo);
    expect(withPlain.tasks.map((task) => task.id)).not.toContain("f-plain");
    await attempt(
      "cites-plain-issue",
      {
        queue: withPlain.queue,
        tasks: [...withPlain.tasks, { id: "f-plain", status: "pending", capstone: false }],
      },
      "project/false-proof",
    );
    // Drive it to implemented (started, never labeled): still not verified, still a false proof.
    await seedTask(repo, "f-late", "implemented");
    const withLate = await realProof(repo);
    await attempt(
      "tampers-implemented-to-verified",
      {
        queue: withLate.queue,
        tasks: withLate.tasks.map((task) => ({ ...task, status: "verified" as const })),
      },
      "project/false-proof",
    );
    // Verify the stragglers through the real door, then the true proof is accepted.
    for (const id of ["f-pend", "f-late"]) {
      const taskStream = issueStream(repo, id);
      const raw = (await records(taskStream)).map((record, index) => ({
        ...cleanEvent(record),
        offset: offsetForOrdinal(index),
      }));
      const { replayTaskLog } = await import("@eforest/tasks");
      const state = replayTaskLog(taskStream, raw);
      const builder = {
        actor: AGENT,
        role: "builder" as const,
        run: `agent-run:${ORG}/${id}-run-1`,
      };
      const branch = { stream: `fs:${ORG}/${repo}:b-${id}:meta`, head: offsetForOrdinal(3) };
      const evidence = { stream: evidenceStream(repo, id), attachmentIds: ["log-1"] };
      let claimOffset = state.currentClaim?.offset;
      if (state.status === "pending") {
        await accepted(
          dispatchAs(AGENT, taskStream, {
            type: "task.started",
            payload: { v: 1, by: builder },
            ts: 120,
          }),
        );
      }
      if (claimOffset === undefined) {
        claimOffset = await accepted(
          dispatchAs(AGENT, taskStream, {
            type: "task.claimed",
            payload: { v: 1, by: builder, branch, evidence, summary: `claim ${id}` },
            ts: 121,
          }),
        );
      }
      await accepted(
        dispatchAs(CRITIC, taskStream, {
          type: "task.verified",
          payload: {
            v: 1,
            by: { actor: CRITIC, role: "critic", run: `agent-run:${ORG}/${id}-run-2` },
            claim: { stream: taskStream, offset: claimOffset },
            branch,
            evidence,
            summary: `verified ${id}`,
          },
          ts: 122,
        }),
      );
    }
    const finalProof = await realProof(repo);
    expect(finalProof.tasks.every((task) => task.status === "verified")).toBe(true);
    expect(finalProof.tasks.map((task) => task.id).sort()).toEqual([
      "f-cap",
      "f-late",
      "f-pend",
      "f-t1",
    ]);
    await attempt("true-proof-agent", finalProof, undefined);
    const view = await getProject(repo);
    expect(view.body.state.status).toBe("complete");
    expect(view.body.state.completion).toEqual({
      queue: finalProof.queue,
      tasks: 4,
      capstone: "f-cap",
    });
    // An agent cannot leave `complete`; a human replans; the same true proof completes again.
    const agentResume = await dispatchAs(
      AGENT,
      stream,
      transition(AGENT, "agent", "building", await head(stream), "self-resume", 701),
    );
    expect(agentResume.status).toBe(409);
    expect((JSON.parse(agentResume.body) as { error: { reason: string } }).error.reason).toBe(
      "project/unauthorized-resume",
    );
    await accepted(
      dispatchAs(
        HUMAN,
        stream,
        transition(HUMAN, "human", "building", await head(stream), "epic 7 planned", 702),
      ),
    );
    await attempt(
      "true-proof-human",
      { queue: finalProof.queue, tasks: finalProof.tasks },
      undefined,
      HUMAN,
      "human",
    );
    const text = `${transcript.join("\n")}\n`;
    expectFrozen("e6-t03-proofs.txt", text);
  }, 600_000);

  it("lets exactly one of a racing human pause and agent launch win at the same offset", async () => {
    const repo = "race";
    const stream = projectStream(repo);
    const outcomes: { readonly winner: string; readonly loser: string }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const expected = await head(stream);
      const [pause, run] = await Promise.all([
        dispatchAs(
          HUMAN,
          stream,
          transition(HUMAN, "human", "paused", expected, `race ${round}`, 800),
        ),
        dispatchAs(AGENT, stream, launch(AGENT, "agent", expected, `race-${round}`, 801)),
      ]);
      const statuses = [pause.status, run.status].sort();
      expect(statuses, `${pause.body} / ${run.body}`).toEqual([202, 409]);
      const loser = pause.status === 409 ? pause : run;
      const loserBody = JSON.parse(loser.body) as { error: { reason: string } };
      expect(["project/stale-offset", "project/paused"]).toContain(loserBody.error.reason);
      expect(await head(stream)).toBe(expected + 1);
      const state = replayProjectLog(stream, await records(stream));
      if (pause.status === 202) {
        expect(state.status).toBe("paused");
        // A launch after the accepted pause offset is refused by the pause itself.
        const late = await dispatchAs(
          AGENT,
          stream,
          launch(AGENT, "agent", expected + 1, `late-${round}`, 802),
        );
        expect(late.status).toBe(409);
        expect((JSON.parse(late.body) as { error: { reason: string } }).error.reason).toBe(
          "project/paused",
        );
        outcomes.push({ winner: "pause", loser: loserBody.error.reason });
        await accepted(
          dispatchAs(
            HUMAN,
            stream,
            transition(HUMAN, "human", "building", expected + 1, "resume", 803),
          ),
        );
      } else {
        expect(state.status).toBe("building");
        expect(state.launches).toBeGreaterThan(0);
        outcomes.push({ winner: "launch", loser: loserBody.error.reason });
      }
    }
    console.log(`E6_T03_RACE ${canonicalJson(outcomes)}`);
  });

  it("never completes over a fenced task whose record has not landed, across two gateways", async () => {
    const repo = "xlag";
    const stream = projectStream(repo);
    await ensureLabels(repo);
    await seedTask(repo, "cap", "verified", ["capstone"]);
    // Gateway C appends to task streams slowly: its fence lands, its task record lags.
    const inner = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const lagging = new Proxy(inner, {
      get(target, prop: keyof OfficialStreamAdapter) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        if (prop === "append") {
          return async (id: string, ...rest: unknown[]) => {
            if (id.startsWith("issue:")) await new Promise((resolve) => setTimeout(resolve, 200));
            return (value as (...args: unknown[]) => Promise<unknown>).call(target, id, ...rest);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const gatewayC = new PlatformGateway({
      verifier,
      streams: lagging,
      decideAuthorization: decideByCredential,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
    });
    const serverC = createPlatformServer((request) => gatewayC.handle(request));
    const urlC = await listenPlatformServer(serverC);
    const outcomes: string[] = [];
    try {
      for (let round = 0; round < 6; round += 1) {
        const id = `bug-${round}`;
        const task = await seedTask(repo, id, "opened");
        const proof = await realProof(repo); // computed before the start: lists only verified tasks
        const builder = {
          actor: AGENT,
          role: "builder" as const,
          run: `agent-run:${ORG}/${id}-run-1`,
        };
        const started: Event = {
          type: "task.started",
          payload: { v: 1, by: builder },
          ts: 1100 + round,
        };
        const startC = dispatchAs(AGENT, task.stream, started, urlC);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const complete = await dispatchAs(
          AGENT,
          stream,
          transition(
            AGENT,
            "agent",
            "complete",
            await head(stream),
            `xlag ${round}`,
            1200 + round,
            proof,
          ),
        );
        const start = await startC;
        console.log(
          `E6_T03_XLAG_ROUND ${round} complete=${complete.status} ${complete.body} start=${start.status} ${start.body} tail=${await projectTail(repo)} cited=${proof.project.offset}`,
        );
        const state = replayProjectLog(stream, await records(stream));
        const taskRaw = (await records(task.stream)).map((record, index) => ({
          ...cleanEvent(record),
          offset: offsetForOrdinal(index),
        }));
        const { replayTaskLog } = await import("@eforest/tasks");
        const taskState = replayTaskLog(task.stream, taskRaw);
        // The invariant: never `complete` while a task is in progress.
        expect(
          !(state.status === "complete" && taskState.status !== "verified"),
          `${id}: complete over an in-progress task`,
        ).toBe(true);
        if (complete.status === 202) {
          expect(start.status, start.body).toBe(409);
          expect((JSON.parse(start.body) as { error: { reason: string } }).error.reason).toBe(
            "project/complete",
          );
          outcomes.push("complete-then-start-refused");
          await accepted(
            dispatchAs(
              HUMAN,
              stream,
              transition(HUMAN, "human", "building", await head(stream), "replan", 1300 + round),
            ),
          );
        } else {
          expect(start.status, start.body).toBe(202);
          expect((JSON.parse(complete.body) as { error: { reason: string } }).error.reason).toBe(
            "project/stale-proof",
          );
          outcomes.push("start-fenced-complete-stale");
          // Bring the started task to `verified` so the next round's proof is honest.
          const evidence = { stream: task.evidence, attachmentIds: ["log-1"] };
          const claimOffset = await accepted(
            dispatchAs(AGENT, task.stream, {
              type: "task.claimed",
              payload: { v: 1, by: builder, branch: task.branch, evidence, summary: `claim ${id}` },
              ts: 1400 + round,
            }),
          );
          await accepted(
            dispatchAs(CRITIC, task.stream, {
              type: "task.verified",
              payload: {
                v: 1,
                by: { actor: CRITIC, role: "critic", run: `agent-run:${ORG}/${id}-run-2` },
                claim: { stream: task.stream, offset: claimOffset },
                branch: task.branch,
                evidence,
                summary: `verified ${id}`,
              },
              ts: 1500 + round,
            }),
          );
        }
      }
    } finally {
      gatewayC.terminate();
      await closeServer(serverC);
    }
    console.log(`E6_T03_XGATEWAY_LAG ${canonicalJson(outcomes)}`);
    expect(
      outcomes.filter((outcome) => outcome === "start-fenced-complete-stale").length,
    ).toBeGreaterThan(0);
  }, 600_000);

  it("never appends a task loop event after an accepted pause across two gateway processes", async () => {
    const repo = "xrace";
    const stream = projectStream(repo);
    await ensureLabels(repo);
    // Gateway B reads the project stream slowly, so it validates `building` while A's
    // pause lands: the fence must lose and B must refuse.
    const inner = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const slow = new Proxy(inner, {
      get(target, prop: keyof OfficialStreamAdapter) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        if (prop === "read") {
          return async (id: string, ...rest: unknown[]) => {
            const result = await (value as (...args: unknown[]) => Promise<unknown>).call(
              target,
              id,
              ...rest,
            );
            if (id === stream) await new Promise((resolve) => setTimeout(resolve, 120));
            return result;
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const gatewayB = new PlatformGateway({
      verifier,
      streams: slow,
      decideAuthorization: decideByCredential,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
    });
    const serverB = createPlatformServer((request) => gatewayB.handle(request));
    const urlB = await listenPlatformServer(serverB);
    const outcomes: string[] = [];
    try {
      for (let round = 0; round < 8; round += 1) {
        const id = `r${round}`;
        const task = await seedTask(repo, id, "opened");
        const expected = await head(stream);
        const builder = {
          actor: AGENT,
          role: "builder" as const,
          run: `agent-run:${ORG}/${id}-run-1`,
        };
        const started: Event = {
          type: "task.started",
          payload: { v: 1, by: builder },
          ts: 1000 + round,
        };
        const [pause, claim] = await Promise.all([
          dispatchAs(
            HUMAN,
            stream,
            transition(HUMAN, "human", "paused", expected, `xrace ${round}`, 900),
          ),
          dispatchAs(AGENT, task.stream, started, urlB),
        ]);
        expect(pause.status, pause.body).toBe(202);
        const project = await records(stream);
        const pauseIndex = project.findIndex(
          (record) =>
            record.type === "project.transitioned" &&
            (record as Event & { offset: string }).offset === pause.offset,
        );
        expect(pauseIndex).toBeGreaterThanOrEqual(0);
        const fences = project
          .map((record, index) => ({ record, index }))
          .filter(
            ({ record }) =>
              record.type === "project.fenced" &&
              (record.payload as { target: { stream: string } }).target.stream === task.stream,
          );
        const taskRecords = await records(task.stream);
        const appended = taskRecords.some((record) => record.type === "task.started");
        if (appended) {
          // Admitted only if its fence linearizes BEFORE the accepted pause.
          expect(claim.status).toBe(202);
          expect(fences.length).toBe(1);
          expect(fences[0]!.index).toBeLessThan(pauseIndex);
          outcomes.push("claim-before-pause");
        } else {
          expect(claim.status, claim.body).toBe(409);
          expect((JSON.parse(claim.body) as { error: { reason: string } }).error.reason).toBe(
            "project/paused",
          );
          expect(fences.filter(({ index }) => index > pauseIndex).length).toBe(0);
          outcomes.push("pause-then-refused");
        }
        await accepted(
          dispatchAs(
            HUMAN,
            stream,
            transition(HUMAN, "human", "building", await head(stream), "resume", 901),
          ),
        );
      }
    } finally {
      gatewayB.terminate();
      await closeServer(serverB);
    }
    console.log(`E6_T03_XGATEWAY_RACE ${canonicalJson(outcomes)}`);
    expect(outcomes.filter((outcome) => outcome === "pause-then-refused").length).toBeGreaterThan(
      0,
    );
  }, 600_000);

  it("treats project.json as a projection: edits and deletes never reach the guard", async () => {
    const dir = WORK_DIR;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = new URL("project.json", dir);
    const raw = await records(LIFECYCLE_STREAM);
    const state = replayProjectLog(LIFECYCLE_STREAM, raw);
    const truth = projectProjectionBytes(state);
    writeFileSync(file, truth);
    // Tamper: flip the projected status to building and the reason to something else.
    const tampered = truth.replace('"status":"complete"', '"status":"building"');
    expect(tampered).not.toBe(truth);
    writeFileSync(file, tampered);
    const refusedWhileTampered = await dispatchAs(
      AGENT,
      LIFECYCLE_STREAM,
      launch(AGENT, "agent", await head(LIFECYCLE_STREAM), "tampered", 900),
    );
    expect(refusedWhileTampered.status).toBe(409);
    expect(
      (JSON.parse(refusedWhileTampered.body) as { error: { reason: string } }).error.reason,
    ).toBe("project/complete");
    // Replay overwrites the edit byte-for-byte; a deleted file comes back identical.
    writeFileSync(file, projectProjectionBytes(replayProjectLog(LIFECYCLE_STREAM, raw)));
    expect(readFileSync(file, "utf8")).toBe(truth);
    rmSync(file);
    writeFileSync(file, projectProjectionBytes(replayProjectLog(LIFECYCLE_STREAM, raw)));
    expectFrozen("e6-t03-project.json", readFileSync(file, "utf8"));
    // Cold restart: a fresh gateway on the same streams reaches the same state and refusal.
    const second = newGateway();
    const secondServer = createPlatformServer((request) => second.handle(request));
    const secondUrl = await listenPlatformServer(secondServer);
    try {
      const warm = await getProject(LIFECYCLE_REPO);
      const cold = await getProject(LIFECYCLE_REPO, AGENT, secondUrl);
      expect(cold.text).toBe(warm.text);
      expect(cold.body.projection).toBe(truth);
      const coldRefusal = await dispatchAs(
        AGENT,
        LIFECYCLE_STREAM,
        launch(AGENT, "agent", await head(LIFECYCLE_STREAM), "cold", 901),
        secondUrl,
      );
      expect(coldRefusal.status).toBe(409);
      expect(JSON.parse(coldRefusal.body)).toEqual(JSON.parse(refusedWhileTampered.body));
    } finally {
      second.terminate();
      await closeServer(secondServer);
    }
  });

  it("covers every frozen refusal reason and keeps the pure guard closed", () => {
    const matrix = artifact("e6-t03-matrix.txt") + artifact("e6-t03-proofs.txt");
    // `project/fence-contention` needs eight lost compare-and-append races in a row; it
    // is not producible deterministically and is covered by the pure fence path instead.
    for (const reason of PROJECT_REFUSAL_REASONS.filter((r) => r !== "project/fence-contention")) {
      expect(matrix.includes(`\\"reason\\":\\"${reason}\\"`), reason).toBe(true);
    }
    expect(guardLoopAction("building", "loop.launch.requested")).toBeUndefined();
    expect(guardLoopAction("paused", "loop.launch.requested")).toBe("project/paused");
    expect(guardLoopAction("complete", "task.claimed")).toBe("project/complete");
    expect(guardLoopAction("invalid_loop", "loop.launch.requested")).toBe("project/invalid-loop");
    expect(guardLoopAction("invalid_loop", "task.verified")).toBe("project/invalid-loop");
  });
});
