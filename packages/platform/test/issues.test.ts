import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, stateDigest, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  ISSUE_STATES,
  WORKFLOW_TRANSITIONS,
  isLegal,
  issueInitialState,
  issueReducer,
  validateIssueEvent,
  IssueRefusalError,
  IssueSchemaError,
  UnauthorizedError,
  OfficialStreamAdapter,
  PlatformGateway,
  type IssueActionType,
  type IssueStateName,
  type AuthorizationVerifier,
  type StreamAdapter,
} from "../src/index.js";
import { reducerForStream, replayWithReducer } from "@eforest/reducers";
import type { AuthzInput } from "../src/authz/decide.js";

const event = (type: string, payload: Record<string, unknown>, ts = 1): Event => ({
  type,
  payload,
  ts,
});

const GENERATED_ACTIONS = [
  "issue.opened",
  "issue.commented",
  "issue.labeled",
  "issue.unlabeled",
  "issue.state-changed",
  "issue.closed",
  "issue.reopened",
] as const satisfies readonly IssueActionType[];
const GENERATED_STATES = ["open", "in-progress", "done", "closed", "wont-do"] as const;

const INDEPENDENT_WORKFLOW = {
  open: {
    "issue.opened": false,
    "issue.commented": "open",
    "issue.labeled": "open",
    "issue.unlabeled": "open",
    "issue.state-changed": ["in-progress", "done", "wont-do"],
    "issue.closed": "closed",
    "issue.reopened": false,
  },
  "in-progress": {
    "issue.opened": false,
    "issue.commented": "in-progress",
    "issue.labeled": "in-progress",
    "issue.unlabeled": "in-progress",
    "issue.state-changed": ["open", "done", "wont-do"],
    "issue.closed": "closed",
    "issue.reopened": false,
  },
  done: {
    "issue.opened": false,
    "issue.commented": "done",
    "issue.labeled": "done",
    "issue.unlabeled": "done",
    "issue.state-changed": ["open", "in-progress", "wont-do"],
    "issue.closed": false,
    "issue.reopened": "open",
  },
  closed: {
    "issue.opened": false,
    "issue.commented": "closed",
    "issue.labeled": "closed",
    "issue.unlabeled": "closed",
    "issue.state-changed": false,
    "issue.closed": false,
    "issue.reopened": "open",
  },
  "wont-do": {
    "issue.opened": false,
    "issue.commented": "wont-do",
    "issue.labeled": "wont-do",
    "issue.unlabeled": "wont-do",
    "issue.state-changed": ["open", "in-progress", "done"],
    "issue.closed": false,
    "issue.reopened": "open",
  },
} as const satisfies Readonly<
  Record<
    IssueStateName,
    Readonly<Record<IssueActionType, false | IssueStateName | readonly IssueStateName[]>>
  >
>;

interface OracleState {
  state: IssueStateName;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ commentId: string; body: string; ts: number }>;
}

function oracleInitialState(): OracleState {
  return { state: "open", title: "", body: "", labels: [], comments: [] };
}

function independentlyLegal(oracle: OracleState, opened: boolean, current: Event): boolean {
  const action = current.type as IssueActionType;
  const payload = current.payload as Record<string, unknown>;
  if (!opened) return action === "issue.opened";
  if (action === "issue.opened") return false;
  const cell = INDEPENDENT_WORKFLOW[oracle.state][action];
  if (cell === false) return false;
  if (action === "issue.state-changed")
    return Array.isArray(cell) && cell.includes(payload.to as IssueStateName);
  if (action === "issue.commented")
    return !oracle.comments.some((comment) => comment.commentId === payload.commentId);
  if (action === "issue.labeled") return !oracle.labels.includes(payload.label as string);
  if (action === "issue.unlabeled") return oracle.labels.includes(payload.label as string);
  return true;
}

function oracleReduce(oracle: OracleState, current: Event): OracleState {
  const payload = current.payload as Record<string, unknown>;
  if (current.type === "issue.opened")
    return { ...oracle, title: payload.title as string, body: payload.body as string };
  if (current.type === "issue.commented")
    return {
      ...oracle,
      comments: [
        ...oracle.comments,
        { commentId: payload.commentId as string, body: payload.body as string, ts: current.ts },
      ],
    };
  if (current.type === "issue.labeled")
    return { ...oracle, labels: [...oracle.labels, payload.label as string].sort() };
  if (current.type === "issue.unlabeled")
    return { ...oracle, labels: oracle.labels.filter((label) => label !== payload.label) };
  if (current.type === "issue.state-changed")
    return { ...oracle, state: payload.to as IssueStateName };
  if (current.type === "issue.closed") return { ...oracle, state: "closed" };
  if (current.type === "issue.reopened") return { ...oracle, state: "open" };
  return oracle;
}

function generatedEvent(random: number, seed: number, step: number): Event {
  const type = GENERATED_ACTIONS[random % GENERATED_ACTIONS.length]!;
  const token = (prefix: string) =>
    random % 5 === 0 ? "" : `${prefix}-${seed}-${step}-${random % 17}`;
  if (type === "issue.opened")
    return event(type, { body: token("body"), title: token("title"), v: 1 }, step + 1);
  if (type === "issue.commented")
    return event(type, { body: token("comment"), commentId: token("comment-id"), v: 1 }, step + 1);
  if (type === "issue.labeled" || type === "issue.unlabeled")
    return event(type, { label: token("label"), v: 1 }, step + 1);
  if (type === "issue.state-changed")
    return event(type, { to: GENERATED_STATES[random % GENERATED_STATES.length], v: 1 }, step + 1);
  if (type === "issue.closed")
    return event(type, random % 2 === 0 ? { v: 1 } : { reason: token("reason"), v: 1 }, step + 1);
  return event(type, { v: 1 }, step + 1);
}

function generatedIssueRun(
  seed: number,
  steps = 24,
): {
  readonly trace: readonly Event[];
  readonly accepted: readonly Event[];
} {
  let random = (seed + 1) >>> 0;
  let opened = false;
  let oracle = oracleInitialState();
  const trace: Event[] = [];
  const accepted: Event[] = [];
  for (let step = 0; step < steps; step += 1) {
    random = (random * 1664525 + 1013904223) >>> 0;
    const current = generatedEvent(random, seed, step);
    trace.push(current);
    if (independentlyLegal(oracle, opened, current)) {
      accepted.push(current);
      oracle = oracleReduce(oracle, current);
      opened = true;
    }
  }
  return { trace, accepted };
}

class IssueAdapter implements StreamAdapter {
  readonly records: Event[] = [];
  async create(): Promise<void> {}
  async read(): Promise<readonly unknown[]> {
    return [...this.records];
  }
  async append(_streamId: string, value: Event): Promise<void> {
    this.records.push(value);
  }
  follow(): AsyncIterable<unknown> {
    return (async function* () {})();
  }
}

function issueSnapshot(records: readonly Event[]): {
  readonly head: number;
  readonly digest: string;
} {
  const clean = records.map((record) => ({
    ...record,
    payload: Object.fromEntries(
      Object.entries(record.payload as Record<string, unknown>).filter(
        ([key]) => key !== "actor" && key !== "writer",
      ),
    ),
  }));
  const digest = issueDumpDigest(clean);
  return {
    head: records.length - 1,
    digest,
  };
}

function issueDumpDigest(records: readonly Event[]): string {
  if (records.length === 0) return stateDigest(issueInitialState);
  const directory = mkdtempSync(join(tmpdir(), "eforest-issue-"));
  const dump = join(directory, "issue.jsonl");
  const lines = records.map((record, index) =>
    canonicalJson({
      offset: offsetForOrdinal(index),
      payload: record.payload,
      ts: record.ts,
      type: record.type,
    }),
  );
  writeFileSync(dump, `${lines.join("\n")}\n`);
  try {
    return execFileSync(
      process.execPath,
      [
        "packages/cli/dist/src/bin.js",
        "replay",
        dump,
        "--digest",
        "--reducer",
        "packages/platform/issues-reducer.mjs",
      ],
      { encoding: "utf8" },
    ).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const issueVerifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "alice" }),
};

function allowIssue(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

describe("issue event model", () => {
  it("exports an exhaustive, singular workflow matrix", () => {
    expect(Object.keys(WORKFLOW_TRANSITIONS)).toHaveLength(5);
    for (const state of ISSUE_STATES)
      expect(Object.keys(WORKFLOW_TRANSITIONS[state])).toHaveLength(7);
  });

  it("cross-checks all 35 matrix cells and the registered projection reducer", () => {
    for (const state of ISSUE_STATES) {
      for (const action of Object.keys(WORKFLOW_TRANSITIONS[state]) as Array<
        keyof (typeof WORKFLOW_TRANSITIONS)[typeof state]
      >) {
        const cell = WORKFLOW_TRANSITIONS[state][action];
        if (action === "issue.state-changed") {
          const destinations = Array.isArray(cell) ? cell : [];
          for (const destination of ["open", "in-progress", "done", "closed", "wont-do"] as const) {
            expect(isLegal(state, action, destination)).toBe(destinations.includes(destination));
          }
        } else {
          expect(isLegal(state, action)).toBe(cell !== false);
        }
      }
    }
    const definition = reducerForStream("issue:maple/reading-room/i-1");
    expect(definition?.id).toBe("issue");
    const projection = replayWithReducer(
      definition!,
      [event("issue.opened", { body: "b", title: "t", v: 1 })],
      "issue:maple/reading-room/i-1",
    );
    expect(projection.state).toMatchObject({
      issueId: "i-1",
      state: "open",
      title: "t",
      body: "b",
    });
  });

  it("dispatches through a real Durable Stream and bootstraps the registered issue projection", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const issueStream = "issue:maple/reading-room/real-stream";
    const otherStream = "fs:maple/reading-room:main:meta";
    const gateway = new PlatformGateway({
      verifier: issueVerifier,
      streams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const post = (streamId: string, type: string, payload: Record<string, unknown>) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: event(type, payload) }),
        }),
      );
    try {
      await streams.create(issueStream);
      expect(
        (await post(issueStream, "issue.opened", { body: "Durable", title: "Real", v: 1 })).status,
      ).toBe(202);
      expect((await post(issueStream, "issue.labeled", { label: "bug", v: 1 })).status).toBe(202);

      const bootstrap = await streams.applicationBootstrap(issueStream);
      const definition = reducerForStream(issueStream);
      expect(definition?.id).toBe("issue");
      const durableRecords = await streams.read(issueStream);
      expect(durableRecords).toHaveLength(2);
      expect(
        durableRecords.every((record) => {
          if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
          const payload = (record as { readonly payload?: unknown }).payload;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload))
            return false;
          const stamped = payload as Record<string, unknown>;
          return stamped.actor === "alice" && stamped.writer !== undefined;
        }),
      ).toBe(true);
      const projection = replayWithReducer(
        definition!,
        bootstrap.events.map((event) => event as Event),
        issueStream,
      );
      expect(projection.state).toMatchObject({
        issueId: "real-stream",
        title: "Real",
        body: "Durable",
        state: "open",
        labels: ["bug"],
        comments: [],
      });
      expect(bootstrap.checkpoint.offset).toBe(offsetForOrdinal(1));

      await streams.create(otherStream);
      const wrongType = await post(otherStream, "issue.opened", {
        body: "wrong",
        title: "wrong",
        v: 1,
      });
      expect(wrongType.status).toBe(404);
      expect(await wrongType.json()).toMatchObject({ error: { class: "unknown-action-type" } });
      expect(await streams.read(otherStream)).toEqual([]);
      console.info(
        `E5_T01_REAL_STREAM_INTEGRATION_OK records=2 checkpoint=${bootstrap.checkpoint.offset} digest=${projection.digest} cross-type=404 untouched=0`,
      );
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("exercises every state-change destination through the HTTP dispatch door", async () => {
    const prefixes = {
      open: [event("issue.opened", { body: "b", title: "t", v: 1 })],
      "in-progress": [
        event("issue.opened", { body: "b", title: "t", v: 1 }),
        event("issue.state-changed", { to: "in-progress", v: 1 }),
      ],
      done: [
        event("issue.opened", { body: "b", title: "t", v: 1 }),
        event("issue.state-changed", { to: "in-progress", v: 1 }),
        event("issue.state-changed", { to: "done", v: 1 }),
      ],
      closed: [
        event("issue.opened", { body: "b", title: "t", v: 1 }),
        event("issue.closed", { v: 1 }),
      ],
      "wont-do": [
        event("issue.opened", { body: "b", title: "t", v: 1 }),
        event("issue.state-changed", { to: "wont-do", v: 1 }),
      ],
    } as const;
    for (const state of ISSUE_STATES) {
      for (const destination of ISSUE_STATES) {
        const streams = new IssueAdapter();
        streams.records.push(...prefixes[state]);
        const gateway = new PlatformGateway({
          verifier: issueVerifier,
          streams,
          decideAuthorization: allowIssue,
          namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
        });
        const response = await gateway.handle(
          new Request("https://platform.test/api/dispatch", {
            method: "POST",
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            body: JSON.stringify({
              streamId: `issue:maple/reading-room/matrix-${state}-${destination}`,
              event: event("issue.state-changed", { to: destination, v: 1 }),
            }),
          }),
        );
        expect(response.status).toBe(
          isLegal(state, "issue.state-changed", destination) ? 202 : 409,
        );
      }
    }
    const actions = [
      "issue.opened",
      "issue.commented",
      "issue.labeled",
      "issue.unlabeled",
      "issue.closed",
      "issue.reopened",
    ] as const;
    for (const state of ISSUE_STATES) {
      for (const action of actions) {
        const streams = new IssueAdapter();
        streams.records.push(...prefixes[state]);
        if (action === "issue.unlabeled")
          streams.records.push(event("issue.labeled", { label: "matrix", v: 1 }));
        const gateway = new PlatformGateway({
          verifier: issueVerifier,
          streams,
          decideAuthorization: allowIssue,
          namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
        });
        const payload =
          action === "issue.opened"
            ? { body: "b", title: "t", v: 1 }
            : action === "issue.commented"
              ? { body: "matrix", commentId: "matrix", v: 1 }
              : action === "issue.labeled" || action === "issue.unlabeled"
                ? { label: action === "issue.unlabeled" ? "matrix" : "matrix-new", v: 1 }
                : action === "issue.closed"
                  ? { reason: "matrix", v: 1 }
                  : { v: 1 };
        const response = await gateway.handle(
          new Request("https://platform.test/api/dispatch", {
            method: "POST",
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            body: JSON.stringify({
              streamId: `issue:maple/reading-room/action-${state}-${action}`,
              event: event(action, payload),
            }),
          }),
        );
        expect(response.status).toBe(isLegal(state, action) ? 202 : 409);
      }
    }
  });

  it("validates and reduces a lifecycle deterministically", () => {
    let state = issueInitialState;
    const events = [
      event("issue.opened", { v: 1, title: "Bug", body: "Details" }),
      event("issue.labeled", { v: 1, label: "bug" }),
      event("issue.commented", { v: 1, commentId: "c1", body: "seen" }),
      event("issue.state-changed", { v: 1, to: "in-progress" }),
      event("issue.state-changed", { v: 1, to: "done" }),
      event("issue.reopened", { v: 1 }),
      event("issue.closed", { v: 1 }),
    ];
    for (const [index, current] of events.entries()) {
      validateIssueEvent(current, state, events.slice(0, index));
      state = issueReducer(state, current);
    }
    expect(state.state).toBe("closed");
    expect(state.labels).toEqual(["bug"]);
    expect(state.comments).toHaveLength(1);
    expect(issueReducer(issueInitialState, events[0]!)).toEqual(
      issueReducer(issueInitialState, events[0]!),
    );
  });

  it("refuses schema errors and illegal mutations before append", () => {
    expect(() =>
      validateIssueEvent(event("issue.opened", { v: 2, title: "x", body: "y" }), issueInitialState),
    ).toThrow(IssueSchemaError);
    const opened = event("issue.opened", { v: 1, title: "x", body: "y" });
    const state = issueReducer(issueInitialState, opened);
    expect(() =>
      validateIssueEvent(event("issue.opened", { v: 1, title: "x", body: "y" }), state, [opened]),
    ).toThrow(IssueRefusalError);
    expect(() =>
      validateIssueEvent(
        event("issue.labeled", { v: 1, label: "bug" }),
        { ...state, labels: ["bug"] },
        [opened],
      ),
    ).toThrow(IssueRefusalError);
  });

  it("treats a second empty opened event as an illegal replay no-op", () => {
    const opened = issueReducer(
      issueInitialState,
      event("issue.opened", { v: 1, title: "", body: "" }),
    );
    const replayed = issueReducer(
      opened,
      event("issue.opened", { v: 1, title: "replacement", body: "replacement" }),
    );
    expect(replayed).toBe(opened);
    expect(replayed.title).toBe("");
    expect(replayed.body).toBe("");
  });

  it("validates issue mutations through the HTTP dispatch door", async () => {
    const streams = new IssueAdapter();
    const gateway = new PlatformGateway({
      verifier: issueVerifier,
      streams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const post = (type: string, payload: Record<string, unknown>) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({
            streamId: "issue:maple/reading-room/i-1",
            event: event(type, payload),
          }),
        }),
      );
    const refuse = async (type: string, payload: Record<string, unknown>, status: number) => {
      const before = issueSnapshot(streams.records);
      const response = await post(type, payload);
      expect(response.status).toBe(status);
      const after = issueSnapshot(streams.records);
      expect(after).toEqual(before);
      return response;
    };
    const openedResponse = await post("issue.opened", { v: 1, title: "Bug", body: "Details" });
    expect(openedResponse.status).toBe(202);
    const refused = await refuse("issue.opened", { v: 1, title: "Again", body: "Nope" }, 409);
    expect(await refused.json()).toEqual({
      error: { class: "validator-rejected", reason: "issue/already-opened" },
    });
    expect(streams.records).toHaveLength(1);

    await refuse("issue.closed", { reason: 42, v: 1 }, 422);
    await refuse("issue.unknown", { v: 1 }, 404);
    const comment = await post("issue.commented", { body: "hello", commentId: "c1", v: 1 });
    expect(comment.status).toBe(202);
    await refuse("issue.commented", { body: "again", commentId: "c1", v: 1 }, 409);
    expect((await post("issue.labeled", { label: "bug", v: 1 })).status).toBe(202);
    await refuse("issue.labeled", { label: "bug", v: 1 }, 409);
    await refuse("issue.unlabeled", { label: "missing", v: 1 }, 409);
    await refuse("issue.state-changed", { to: "open", v: 1 }, 409);
    await refuse("issue.state-changed", { to: "closed", v: 1 }, 409);
    expect((await post("issue.closed", { reason: "fixed", v: 1 })).status).toBe(202);
    expect((await post("issue.reopened", { v: 1 })).status).toBe(202);
    await refuse("issue.reopened", { v: 1 }, 409);
    expect((await post("issue.state-changed", { to: "done", v: 1 })).status).toBe(202);
    await refuse("issue.closed", { reason: "late", v: 1 }, 409);
    expect(streams.records).toHaveLength(6);

    const deniedStreams = new IssueAdapter();
    const deniedGateway = new PlatformGateway({
      verifier: issueVerifier,
      streams: deniedStreams,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const denied = await deniedGateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "issue:maple/reading-room/i-2",
          event: event("issue.opened", { body: "b", title: "t", v: 1 }),
        }),
      }),
    );
    expect(denied.status).toBe(404);
    expect(deniedStreams.records).toHaveLength(0);

    const grantlessStreams = new IssueAdapter();
    const grantlessGateway = new PlatformGateway({
      verifier: issueVerifier,
      streams: grantlessStreams,
      namespaceViewReader: {
        viewFor: async () => ({
          orgs: {
            maple: {
              owner: "owner",
              projects: {},
              repos: {
                "reading-room": { owner: "owner", project: "reader", visibility: "public" },
              },
            },
          },
        }),
      },
    });
    const grantless = await grantlessGateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "issue:maple/reading-room/i-grantless",
          event: event("issue.opened", { body: "b", title: "t", v: 1 }),
        }),
      }),
    );
    expect(grantless.status).toBe(403);
    expect(await grantless.json()).toMatchObject({
      error: { code: "authz_refused", reason: "authz/write-grant-required" },
    });
    expect(grantlessStreams.records).toHaveLength(0);

    const malformedBefore = issueSnapshot(streams.records);
    const malformedBody = await gateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformedBody.status).toBe(400);
    expect(issueSnapshot(streams.records)).toEqual(malformedBefore);

    const preStreams = new IssueAdapter();
    const preGateway = new PlatformGateway({
      verifier: issueVerifier,
      streams: preStreams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const preOpen = await preGateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "issue:maple/reading-room/i-pre",
          event: event("issue.commented", { body: "too soon", commentId: "c", v: 1 }),
        }),
      }),
    );
    expect(preOpen.status).toBe(409);
    expect(preStreams.records).toHaveLength(0);
  });

  it("returns 401 for failed authentication before issue authorization or append", async () => {
    const streams = new IssueAdapter();
    const gateway = new PlatformGateway({
      verifier: {
        verifyAuthorization: async () => {
          throw new UnauthorizedError("missing_bearer_token");
        },
      },
      streams,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const response = await gateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "issue:maple/reading-room/i-unauthorized",
          event: event("issue.opened", { body: "b", title: "t", v: 1 }),
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(streams.records).toHaveLength(0);
  });

  it("property (a): 1000 seeded randomized sequences match an independent oracle", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 1_000; seed += 1) {
      const run = generatedIssueRun(seed);
      for (const current of run.trace) seen.add(current.type);
      let oracle = oracleInitialState();
      let opened = false;
      let state = issueInitialState;
      const accepted: Event[] = [];
      for (const current of run.trace) {
        const expected = independentlyLegal(oracle, opened, current);
        let actual = true;
        try {
          validateIssueEvent(current, state, accepted);
        } catch {
          actual = false;
        }
        expect(actual).toBe(expected);
        if (expected) {
          oracle = oracleReduce(oracle, current);
          opened = true;
        }
        if (actual) {
          accepted.push(current);
          state = issueReducer(state, current);
        }
      }
      expect(accepted).toEqual(run.accepted);
      expect(["open", "in-progress", "done", "closed", "wont-do"]).toContain(state.state);
    }
    expect([...seen].sort()).toEqual([...GENERATED_ACTIONS].sort());
  });

  it("property (b): 1000 generated accepted sequences preserve canonical invariants", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const state = generatedIssueRun(seed).accepted.reduce(issueReducer, issueInitialState);
      expect(["open", "in-progress", "done", "closed", "wont-do"]).toContain(state.state);
      expect([...state.labels].sort()).toEqual(state.labels);
      expect(new Set(state.labels).size).toBe(state.labels.length);
    }
  });

  it("property (c): 1000 generated accepted replays have identical digests", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const events = generatedIssueRun(seed).accepted;
      const first = events.reduce(issueReducer, issueInitialState);
      const second = events.reduce(issueReducer, issueInitialState);
      expect(stateDigest(first)).toBe(stateDigest(second));
    }
  });

  it("property (d): 1000 generated refused interleavings are log-neutral", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const run = generatedIssueRun(seed);
      const withoutRefusal = run.accepted.reduce(issueReducer, issueInitialState);
      const withRefusal = run.trace.reduce(issueReducer, issueInitialState);
      expect(stateDigest(withRefusal)).toBe(stateDigest(withoutRefusal));
    }
  });
});
