import type { Server } from "node:http";
import {
  OFFSET_BEFORE_FIRST,
  canonicalJson,
  sha256Hex,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { requireReducer, replayWithReducer } from "@eforest/reducers";
import { createDurableStreamTestServer } from "@eforest/server";
import { TASKS_REDUCER_ID, replayTaskLog } from "@eforest/tasks";
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
import { artifact } from "../../tasks/test/fixture.js";
import {
  BUILDER,
  GOLDEN_ATTACHMENTS,
  GOLDEN_EVENTS,
  GOLDEN_EVIDENCE_STREAM,
  GOLDEN_LABEL,
  GOLDEN_ORG,
  GOLDEN_REPO,
  GOLDEN_STREAM,
  GOLDEN_TASK_ID,
  REFUSAL_SCENARIOS,
  type RefusalScenario,
} from "../../tasks/test/golden.js";

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

function allowRepository(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

/** `Bearer <sub>` authenticates as `<sub>`: builders and critics are distinct principals. */
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
  return payload.by?.actor ?? BUILDER;
}

function rewrite<T>(value: T, from: readonly [string, string][]): T {
  let text = JSON.stringify(value);
  for (const [search, replacement] of from) text = text.split(search).join(replacement);
  return JSON.parse(text) as T;
}

describe("task events on the real dispatch door", () => {
  let official: ReturnType<typeof createDurableStreamTestServer>;
  let streams: OfficialStreamAdapter;
  let gateway: PlatformGateway;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const officialUrl = await official.start();
    streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
    gateway = new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl: officialUrl }),
      decideAuthorization: allowRepository,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 100_000, windowMs: 3_600_000 }),
    });
    server = createPlatformServer((request) => gateway.handle(request));
    baseUrl = await listenPlatformServer(server);
    await expectAccepted(
      dispatchAs("maintainer", `repo-labels:${GOLDEN_ORG}/${GOLDEN_REPO}`, {
        type: "label.created",
        payload: { v: 1, labelId: GOLDEN_LABEL, name: "Bug", color: "red" },
        ts: 1,
      }),
    );
  });

  afterAll(async () => {
    gateway.terminate();
    await closeServer(server);
    await official.stop();
  });

  async function dispatchAs(sub: string, streamId: string, action: Event): Promise<DispatchResult> {
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
    let offset: Offset | undefined;
    try {
      const decoded = JSON.parse(body) as { readonly offset?: unknown };
      if (typeof decoded.offset === "string") offset = decoded.offset as Offset;
    } catch {
      // raw body stays the oracle
    }
    return { status: response.status, body, ...(offset === undefined ? {} : { offset }) };
  }

  async function expectAccepted(result: Promise<DispatchResult>): Promise<DispatchResult> {
    const response = await result;
    expect(response.status, response.body).toBe(202);
    return response;
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

  async function seedEvidence(taskStream: string, evidenceStream: string): Promise<void> {
    await expectAccepted(dispatchAs(BUILDER, taskStream, GOLDEN_EVENTS[0]!));
    GOLDEN_ATTACHMENTS.forEach(async () => undefined);
    for (const [index, attachmentId] of GOLDEN_ATTACHMENTS.entries()) {
      await expectAccepted(
        dispatchAs(BUILDER, evidenceStream, {
          type: "evidence.linked",
          payload: {
            v: 1,
            attachmentId,
            kind: "replay-recording",
            url: `https://app.replay.io/recording/${attachmentId}`,
          },
          ts: 100 + index,
        }),
      );
    }
  }

  it("drives the frozen lifecycle end to end and dumps the committed task log", async () => {
    await seedEvidence(GOLDEN_STREAM, GOLDEN_EVIDENCE_STREAM);
    for (const [index, action] of GOLDEN_EVENTS.slice(1).entries()) {
      const response = await expectAccepted(dispatchAs(actorOf(action), GOLDEN_STREAM, action));
      expect(response.offset).toBe(offsetForOrdinal(index + 1));
    }
    const dump = await cleanDump(GOLDEN_STREAM);
    expect(dump).toBe(artifact("e6-t01-task.jsonl"));
    const raw = await records(GOLDEN_STREAM);
    const definition = requireReducer(TASKS_REDUCER_ID, GOLDEN_STREAM);
    const shared = replayWithReducer(definition, raw, GOLDEN_STREAM);
    expect(shared.digest).toBe(artifact("e6-t01-task.digest").trim());
    expect(stateDigest(replayTaskLog(GOLDEN_STREAM, raw))).toBe(shared.digest);
    const issue = replayWithReducer(requireReducer("issue", GOLDEN_STREAM), raw, GOLDEN_STREAM);
    expect(canonicalJson((shared.state as { readonly issue: unknown }).issue)).toBe(
      canonicalJson(issue.state),
    );
    const board = await fetch(`${baseUrl}/api/repos/${GOLDEN_ORG}/${GOLDEN_REPO}/issues/board`, {
      headers: { authorization: `Bearer ${BUILDER}` },
    });
    if (board.status === 200) {
      expect(await board.text()).toContain(GOLDEN_TASK_ID);
    }
  });

  it("refuses every frozen scenario before append with byte-identical head and dump", async () => {
    const transcript: string[] = [];
    for (const scenario of REFUSAL_SCENARIOS) {
      const taskId = `E6-T01-refusal-${scenario.name}`;
      const streamId = `issue:${GOLDEN_ORG}/${GOLDEN_REPO}/${taskId}`;
      const evidenceStream = `evidence:${GOLDEN_ORG}/${GOLDEN_REPO}/issue/${taskId}`;
      const map: readonly [string, string][] = [
        [GOLDEN_EVIDENCE_STREAM, evidenceStream],
        [GOLDEN_STREAM, streamId],
      ];
      const localScenario = rewrite<RefusalScenario>(scenario, map);
      const prefix = GOLDEN_EVENTS.slice(0, scenario.prefix).map((action) => rewrite(action, map));
      if (scenario.prefix > 0) {
        await seedEvidence(streamId, evidenceStream);
        for (const action of prefix.slice(1)) {
          await expectAccepted(dispatchAs(actorOf(action), streamId, action));
        }
      }
      const before = await snapshot(streamId);
      const response = await dispatchAs(localScenario.actor, streamId, localScenario.event);
      const after = await snapshot(streamId);
      const expected =
        scenario.expect.class === "validator-rejected"
          ? {
              status: 409,
              body: { error: { class: "validator-rejected", reason: scenario.expect.reason } },
            }
          : scenario.expect.class === "schema-violation"
            ? { status: 422, body: { error: { class: "schema-violation" } } }
            : { status: 404, body: { error: { class: "unknown-action-type" } } };
      expect(response.status, `${scenario.name}: ${response.body}`).toBe(expected.status);
      expect(JSON.parse(response.body)).toEqual(expected.body);
      expect(after, scenario.name).toEqual(before);
      transcript.push(
        `E6_T01_REFUSAL ${canonicalJson({
          name: scenario.name,
          streamId,
          requestBody: JSON.stringify({ streamId, event: localScenario.event }),
          status: response.status,
          responseBody: response.body,
          before,
          after,
        })}`,
      );
    }
    const text = `${transcript.join("\n")}\n`;
    if (process.env.EFOREST_E6_T01_PRINT === "1") {
      console.log("E6_T01_ARTIFACT_BEGIN e6-t01-refusals.txt");
      console.log(text.trimEnd());
      console.log("E6_T01_ARTIFACT_END e6-t01-refusals.txt");
    }
    expect(text).toBe(artifact("e6-t01-refusals.txt"));
  });
});
