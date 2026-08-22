import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, stateDigest, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  ISSUE_STATES,
  ISSUE_MAX_DISPATCH_BYTES,
  ISSUE_STRING_MAX_CODE_UNITS,
  WORKFLOW_TRANSITIONS,
  createPlatformServer,
  isLegal,
  isIssueString,
  issueInitialState,
  issueReducer,
  listenPlatformServer,
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
const PROPERTY_CASES = 1_000;
const PROPERTY_STEPS = 24;
const SCHEMA_VIOLATION_BODY = '{"error":{"class":"schema-violation"}}';

interface IssueStringGarbageCase {
  readonly name: string;
  readonly type: IssueActionType;
  readonly payload: Record<string, unknown>;
  readonly field: "title" | "body" | "commentId" | "label" | "to" | "reason";
  readonly invalid: "nul" | "astral";
}

const ISSUE_STRING_GARBAGE_CASES: readonly IssueStringGarbageCase[] = [
  {
    name: "opened-title-nul",
    type: "issue.opened",
    payload: { body: "b", title: "before\u0000after", v: 1 },
    field: "title",
    invalid: "nul",
  },
  {
    name: "opened-title-astral",
    type: "issue.opened",
    payload: { body: "b", title: "title-🧪", v: 1 },
    field: "title",
    invalid: "astral",
  },
  {
    name: "opened-body-nul",
    type: "issue.opened",
    payload: { body: "\u0000body", title: "t", v: 1 },
    field: "body",
    invalid: "nul",
  },
  {
    name: "opened-body-astral",
    type: "issue.opened",
    payload: { body: "body-🜁-tail", title: "t", v: 1 },
    field: "body",
    invalid: "astral",
  },
  {
    name: "commented-comment-id-nul",
    type: "issue.commented",
    payload: { body: "b", commentId: "comment\u0000id", v: 1 },
    field: "commentId",
    invalid: "nul",
  },
  {
    name: "commented-comment-id-astral",
    type: "issue.commented",
    payload: { body: "b", commentId: "🧪-comment", v: 1 },
    field: "commentId",
    invalid: "astral",
  },
  {
    name: "commented-body-nul",
    type: "issue.commented",
    payload: { body: "comment-body\u0000", commentId: "c-nul", v: 1 },
    field: "body",
    invalid: "nul",
  },
  {
    name: "commented-body-astral",
    type: "issue.commented",
    payload: { body: "comment-🜁-body", commentId: "c-astral", v: 1 },
    field: "body",
    invalid: "astral",
  },
  {
    name: "labeled-label-nul",
    type: "issue.labeled",
    payload: { label: "bug\u0000label", v: 1 },
    field: "label",
    invalid: "nul",
  },
  {
    name: "labeled-label-astral",
    type: "issue.labeled",
    payload: { label: "label-🧪", v: 1 },
    field: "label",
    invalid: "astral",
  },
  {
    name: "unlabeled-label-nul",
    type: "issue.unlabeled",
    payload: { label: "\u0000unlabel", v: 1 },
    field: "label",
    invalid: "nul",
  },
  {
    name: "unlabeled-label-astral",
    type: "issue.unlabeled",
    payload: { label: "unlabel-🜁", v: 1 },
    field: "label",
    invalid: "astral",
  },
  {
    name: "state-changed-to-nul",
    type: "issue.state-changed",
    payload: { to: "open\u0000", v: 1 },
    field: "to",
    invalid: "nul",
  },
  {
    name: "state-changed-to-astral",
    type: "issue.state-changed",
    payload: { to: "🧪", v: 1 },
    field: "to",
    invalid: "astral",
  },
  {
    name: "closed-reason-nul",
    type: "issue.closed",
    payload: { reason: "reason\u0000tail", v: 1 },
    field: "reason",
    invalid: "nul",
  },
  {
    name: "closed-reason-astral",
    type: "issue.closed",
    payload: { reason: "🜁-reason", v: 1 },
    field: "reason",
    invalid: "astral",
  },
];

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
  steps = PROPERTY_STEPS,
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

function issueDumpDigest(records: readonly Event[], streamId?: string): string {
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
    const args = [
      "packages/cli/dist/src/bin.js",
      "replay",
      dump,
      "--digest",
      "--reducer",
      "packages/platform/issues-reducer.mjs",
    ];
    if (streamId !== undefined) args.push("--stream-id", streamId);
    return execFileSync(process.execPath, args, { encoding: "utf8" }).trim();
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
    const post = (streamId: string, current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
    const dispatch = (streamId: string, type: string, payload: Record<string, unknown>, ts = 1) =>
      post(streamId, event(type, payload, ts));
    try {
      await streams.create(issueStream);
      expect(
        (await dispatch(issueStream, "issue.opened", { body: "Durable", title: "Real", v: 1 }))
          .status,
      ).toBe(202);
      expect((await dispatch(issueStream, "issue.labeled", { label: "bug", v: 1 }, 2)).status).toBe(
        202,
      );

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

      const goldenStream = "issue:maple/reading-room/golden-online";
      const goldenEvents = [
        event("issue.opened", { body: "Details", title: "Bug", v: 1 }, 1),
        event("issue.labeled", { label: "bug", v: 1 }, 2),
        event("issue.commented", { body: "seen", commentId: "c1", v: 1 }, 3),
        event("issue.state-changed", { to: "in-progress", v: 1 }, 4),
        event("issue.state-changed", { to: "done", v: 1 }, 5),
        event("issue.reopened", { v: 1 }, 6),
        event("issue.closed", { reason: "fixed", v: 1 }, 7),
      ];
      await streams.create(goldenStream);
      for (const current of goldenEvents)
        expect((await post(goldenStream, current)).status).toBe(202);
      const goldenBootstrap = await streams.applicationBootstrap(goldenStream);
      const goldenStreamProjection = replayWithReducer(
        definition!,
        goldenBootstrap.events.map((current) => current as Event),
        goldenStream,
      );
      expect(goldenStreamProjection.state).toMatchObject({ issueId: "golden-online" });
      const offlineGoldenDigest = issueDumpDigest(goldenEvents, goldenStream);
      const expectedGoldenDigest =
        "e3f61f6f10794dd008fc2629f4e6a342b3ed40ff9cec79c971ca879a7182f105";
      expect(goldenStreamProjection.digest).toBe(expectedGoldenDigest);
      expect(offlineGoldenDigest).toBe(expectedGoldenDigest);
      expect(goldenBootstrap.checkpoint.offset).toBe(offsetForOrdinal(goldenEvents.length - 1));
      expect(goldenStreamProjection.state).toMatchObject({
        issueId: "golden-online",
        title: "Bug",
        body: "Details",
        state: "closed",
        labels: ["bug"],
        comments: [{ body: "seen", commentId: "c1", ts: 3 }],
      });

      await streams.create(otherStream);
      const wrongType = await dispatch(otherStream, "issue.opened", {
        body: "wrong",
        title: "wrong",
        v: 1,
      });
      expect(wrongType.status).toBe(404);
      expect(await wrongType.json()).toMatchObject({ error: { class: "unknown-action-type" } });
      expect(await streams.read(otherStream)).toEqual([]);
      console.info(
        `E5_T01_REAL_STREAM_INTEGRATION_OK records=2 golden-records=7 checkpoint=${bootstrap.checkpoint.offset} digest=${projection.digest} online-offline-digest=${goldenStreamProjection.digest} cross-type=404 untouched=0`,
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

  it("refuses every NUL and astral issue string-field shape before validation or replay", () => {
    expect(ISSUE_MAX_DISPATCH_BYTES).toBe(10_485_760);
    expect(ISSUE_STRING_MAX_CODE_UNITS).toBe(10_485_760);
    expect(isIssueString("")).toBe(true);
    expect(isIssueString("line one\nline two\tend")).toBe(true);
    expect(isIssueString("left\u0000right")).toBe(false);
    expect(isIssueString("astral-🜁")).toBe(false);

    const openedEvent = event("issue.opened", { body: "b", title: "t", v: 1 });
    const openedState = issueReducer(issueInitialState, openedEvent);
    for (const attack of ISSUE_STRING_GARBAGE_CASES) {
      const current = event(attack.type, attack.payload);
      const state = attack.type === "issue.opened" ? issueInitialState : openedState;
      const records = attack.type === "issue.opened" ? [] : [openedEvent];
      expect(() => validateIssueEvent(current, state, records), attack.name).toThrow(
        IssueSchemaError,
      );
      expect(issueReducer(state, current), attack.name).toBe(state);
    }
  });

  it("validates issue mutations through the HTTP dispatch door", async () => {
    const streams = new IssueAdapter();
    const refusalTranscript: string[] = [];
    const gateway = new PlatformGateway({
      verifier: issueVerifier,
      streams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const requestBody = (type: string, payload: Record<string, unknown>) => ({
      streamId: "issue:maple/reading-room/i-1",
      event: event(type, payload),
    });
    const post = (type: string, payload: Record<string, unknown>) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify(requestBody(type, payload)),
        }),
      );
    const recordRefusal = async (
      caseName: string,
      records: readonly Event[],
      requestBodyText: string,
      response: Response,
      before: ReturnType<typeof issueSnapshot>,
    ) => {
      const responseBody = await response.text();
      const after = issueSnapshot(records);
      refusalTranscript.push(
        `E5_T01_REFUSAL ${canonicalJson({
          after,
          before,
          case: caseName,
          requestBody: requestBodyText,
          responseBody,
          status: response.status,
        })}`,
      );
      return { after, responseBody };
    };
    const refuse = async (
      caseName: string,
      type: string,
      payload: Record<string, unknown>,
      status: number,
      expectedBody: Record<string, unknown>,
    ) => {
      const before = issueSnapshot(streams.records);
      const response = await post(type, payload);
      expect(response.status).toBe(status);
      const { after, responseBody } = await recordRefusal(
        caseName,
        streams.records,
        JSON.stringify(requestBody(type, payload)),
        response,
        before,
      );
      expect(JSON.parse(responseBody)).toEqual(expectedBody);
      expect(after).toEqual(before);
      return responseBody;
    };
    const openedResponse = await post("issue.opened", { v: 1, title: "Bug", body: "Details" });
    expect(openedResponse.status).toBe(202);
    await refuse("duplicate-open", "issue.opened", { v: 1, title: "Again", body: "Nope" }, 409, {
      error: { class: "validator-rejected", reason: "issue/already-opened" },
    });
    expect(streams.records).toHaveLength(1);

    await refuse("closed-reason-schema", "issue.closed", { reason: 42, v: 1 }, 422, {
      error: { class: "schema-violation" },
    });
    await refuse("unknown-action", "issue.unknown", { v: 1 }, 404, {
      error: { class: "unknown-action-type" },
    });
    await refuse("prototype-to-string-action", "toString", { v: 1 }, 404, {
      error: { class: "unknown-action-type" },
    });
    await refuse("prototype-constructor-action", "constructor", { v: 1 }, 404, {
      error: { class: "unknown-action-type" },
    });
    const comment = await post("issue.commented", { body: "hello", commentId: "c1", v: 1 });
    expect(comment.status).toBe(202);
    await refuse(
      "duplicate-comment",
      "issue.commented",
      { body: "again", commentId: "c1", v: 1 },
      409,
      { error: { class: "validator-rejected", reason: "issue/duplicate-comment" } },
    );
    expect((await post("issue.labeled", { label: "bug", v: 1 })).status).toBe(202);
    await refuse("duplicate-label", "issue.labeled", { label: "bug", v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/duplicate-label" },
    });
    await refuse("missing-label", "issue.unlabeled", { label: "missing", v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/missing-label" },
    });
    await refuse("self-transition", "issue.state-changed", { to: "open", v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/illegal-transition" },
    });
    await refuse("state-changed-to-closed", "issue.state-changed", { to: "closed", v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/illegal-transition" },
    });
    expect((await post("issue.closed", { reason: "fixed", v: 1 })).status).toBe(202);
    expect((await post("issue.reopened", { v: 1 })).status).toBe(202);
    await refuse("duplicate-reopen", "issue.reopened", { v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/illegal-transition" },
    });
    expect((await post("issue.state-changed", { to: "done", v: 1 })).status).toBe(202);
    await refuse("closed-from-done", "issue.closed", { reason: "late", v: 1 }, 409, {
      error: { class: "validator-rejected", reason: "issue/illegal-transition" },
    });
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
        body: '{"streamId":"issue:maple/reading-room/i-grantless","event":{"type":"issue.opened","payload":{"v":1.0,"title":"t","body":"b"},"ts":1}}',
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
    const malformedResult = await recordRefusal(
      "malformed-body",
      streams.records,
      "{",
      malformedBody,
      malformedBefore,
    );
    expect(JSON.parse(malformedResult.responseBody)).toEqual({
      error: { code: "invalid_request", reason: "malformed_json" },
    });
    expect(malformedResult.after).toEqual(malformedBefore);

    const preStreams = new IssueAdapter();
    const preGateway = new PlatformGateway({
      verifier: issueVerifier,
      streams: preStreams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const preOpenRequest = {
      streamId: "issue:maple/reading-room/i-pre",
      event: event("issue.commented", { body: "too soon", commentId: "c", v: 1 }),
    };
    const preOpenBefore = issueSnapshot(preStreams.records);
    const preOpen = await preGateway.handle(
      new Request("https://platform.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify(preOpenRequest),
      }),
    );
    expect(preOpen.status).toBe(409);
    const preOpenResult = await recordRefusal(
      "pre-open-comment",
      preStreams.records,
      JSON.stringify(preOpenRequest),
      preOpen,
      preOpenBefore,
    );
    expect(JSON.parse(preOpenResult.responseBody)).toEqual({
      error: { class: "validator-rejected", reason: "issue/not-opened" },
    });
    expect(preOpenResult.after).toEqual(preOpenBefore);
    for (const line of refusalTranscript) console.info(line);
  });

  it("refuses the exact source, size, and string attacks over live HTTP without append", async () => {
    const streams = new IssueAdapter();
    const gateway = new PlatformGateway({
      verifier: issueVerifier,
      streams,
      decideAuthorization: allowIssue,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const server = createPlatformServer((request) => gateway.handle(request));
    const baseUrl = await listenPlatformServer(server);
    const rawIssue = (
      issueId: string,
      type: IssueActionType,
      payload: Record<string, unknown>,
      ts = 1,
    ) =>
      JSON.stringify({
        streamId: `issue:maple/reading-room/${issueId}`,
        event: event(type, payload, ts),
      });
    const exactVersionBody =
      '{"streamId":"issue:maple/reading-room/v-float","event":{"type":"issue.opened","payload":{"v":1.0,"title":"t","body":"b"},"ts":1}}';
    const tenMibBody = "x".repeat(10_485_760);
    const exactLargeBody = rawIssue("body-10mib", "issue.opened", {
      v: 1,
      title: "t",
      body: tenMibBody,
    });
    const exactUnicodeBody = rawIssue("unicode-combined", "issue.opened", {
      v: 1,
      title: "🧪\u0000title",
      body: "left\u0000right-🜁",
    });
    expect(tenMibBody).toHaveLength(10_485_760);
    expect(Buffer.byteLength(exactLargeBody)).toBeGreaterThan(ISSUE_MAX_DISPATCH_BYTES);
    expect(JSON.parse(exactUnicodeBody).event.payload).toEqual({
      v: 1,
      title: "🧪\u0000title",
      body: "left\u0000right-🜁",
    });

    const attacks = [
      {
        name: "exact-version-1.0",
        rawBody: exactVersionBody,
        field: "v",
        invalid: "lexical-1.0",
        payloadCodeUnits: "1.0".length,
      },
      {
        name: "exact-body-10mib",
        rawBody: exactLargeBody,
        field: "body",
        invalid: "request-over-10mib",
        payloadCodeUnits: tenMibBody.length,
      },
      {
        name: "exact-opened-nul-astral",
        rawBody: exactUnicodeBody,
        field: "title+body",
        invalid: "nul+astral",
        payloadCodeUnits: "🧪\u0000title".length + "left\u0000right-🜁".length,
      },
      ...ISSUE_STRING_GARBAGE_CASES.map((attack, index) => ({
        name: attack.name,
        rawBody: rawIssue(`string-${String(index)}`, attack.type, attack.payload),
        field: attack.field,
        invalid: attack.invalid,
        payloadCodeUnits: (attack.payload[attack.field] as string).length,
      })),
    ] as const;
    const transcript: string[] = [];
    try {
      for (const attack of attacks) {
        const before = issueSnapshot(streams.records);
        const response = await fetch(`${baseUrl}/api/dispatch`, {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: attack.rawBody,
        });
        const responseBody = await response.text();
        const after = issueSnapshot(streams.records);
        expect(response.status, attack.name).toBe(422);
        expect(responseBody, attack.name).toBe(SCHEMA_VIOLATION_BODY);
        expect(after, attack.name).toEqual(before);
        transcript.push(
          `E5_T01_BOUNDARY ${canonicalJson({
            after,
            before,
            case: attack.name,
            field: attack.field,
            invalid: attack.invalid,
            payloadCodeUnits: attack.payloadCodeUnits,
            requestBodyBytes: Buffer.byteLength(attack.rawBody),
            requestBodyCodeUnits: attack.rawBody.length,
            requestBodySha256: createHash("sha256").update(attack.rawBody).digest("hex"),
            responseBody,
            status: response.status,
          })}`,
        );
      }

      const sourceAwareValid =
        '{"v":1.0,"decoy":{"v":1.0},"streamId":"issue:maple/reading-room/source-aware","event":{"type":"issue.opened","payload":{"v" \n : \t 1,"title":"literal \\"v\\":1.0","body":"line\\nbody"},"ts":1}}';
      const accepted = await fetch(`${baseUrl}/api/dispatch`, {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: sourceAwareValid,
      });
      expect(accepted.status).toBe(202);
      expect(streams.records).toHaveLength(1);

      const precedenceAttacks = [
        {
          name: "unknown-before-schema",
          layer: "unknown-action-type",
          rawBody:
            '{"streamId":"issue:maple/reading-room/source-aware","event":{"type":"issue.unknown","payload":{"v":1.0,"title":"\\u0000"},"ts":2}}',
          status: 404,
          responseBody: '{"error":{"class":"unknown-action-type"}}',
        },
        {
          name: "schema-before-validator",
          layer: "schema-violation",
          rawBody: rawIssue("source-aware", "issue.opened", {
            v: 1,
            title: "duplicate\u0000title",
            body: "b",
          }),
          status: 422,
          responseBody: SCHEMA_VIOLATION_BODY,
        },
        {
          name: "validator-after-schema",
          layer: "validator-rejected",
          rawBody: rawIssue("source-aware", "issue.opened", {
            v: 1,
            title: "duplicate",
            body: "b",
          }),
          status: 409,
          responseBody: '{"error":{"class":"validator-rejected","reason":"issue/already-opened"}}',
        },
      ] as const;
      for (const attack of precedenceAttacks) {
        const before = issueSnapshot(streams.records);
        const response = await fetch(`${baseUrl}/api/dispatch`, {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: attack.rawBody,
        });
        const responseBody = await response.text();
        const after = issueSnapshot(streams.records);
        expect(response.status, attack.name).toBe(attack.status);
        expect(responseBody, attack.name).toBe(attack.responseBody);
        expect(after, attack.name).toEqual(before);
        transcript.push(
          `E5_T01_PRECEDENCE ${canonicalJson({
            after,
            before,
            case: attack.name,
            layer: attack.layer,
            requestBodyBytes: Buffer.byteLength(attack.rawBody),
            requestBodyCodeUnits: attack.rawBody.length,
            requestBodySha256: createHash("sha256").update(attack.rawBody).digest("hex"),
            responseBody,
            status: response.status,
          })}`,
        );
      }
      for (const line of transcript) console.info(line);
    } finally {
      gateway.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
        body: '{"streamId":"issue:maple/reading-room/i-unauthorized","event":{"type":"issue.opened","payload":{"v":1.0,"title":"t","body":"b"},"ts":1}}',
      }),
    );
    expect(response.status).toBe(401);
    expect(streams.records).toHaveLength(0);
  });

  it("property (a): 1000 seeded randomized sequences match an independent oracle", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < PROPERTY_CASES; seed += 1) {
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
    console.info(
      `E5_T01_PROPERTY property=(a) seeds=${PROPERTY_CASES} steps=${PROPERTY_STEPS} seed-range=0..${PROPERTY_CASES - 1}`,
    );
  });

  it("property (b): 1000 generated accepted sequences preserve canonical invariants", () => {
    for (let seed = 0; seed < PROPERTY_CASES; seed += 1) {
      const state = generatedIssueRun(seed).accepted.reduce(issueReducer, issueInitialState);
      expect(["open", "in-progress", "done", "closed", "wont-do"]).toContain(state.state);
      expect([...state.labels].sort()).toEqual(state.labels);
      expect(new Set(state.labels).size).toBe(state.labels.length);
    }
    console.info(
      `E5_T01_PROPERTY property=(b) seeds=${PROPERTY_CASES} steps=${PROPERTY_STEPS} seed-range=0..${PROPERTY_CASES - 1}`,
    );
  });

  it("property (c): 1000 generated accepted replays have identical digests", () => {
    for (let seed = 0; seed < PROPERTY_CASES; seed += 1) {
      const events = generatedIssueRun(seed).accepted;
      const first = events.reduce(issueReducer, issueInitialState);
      const second = events.reduce(issueReducer, issueInitialState);
      expect(stateDigest(first)).toBe(stateDigest(second));
    }
    console.info(
      `E5_T01_PROPERTY property=(c) seeds=${PROPERTY_CASES} steps=${PROPERTY_STEPS} seed-range=0..${PROPERTY_CASES - 1}`,
    );
  });

  it("property (d): 1000 generated refused interleavings are log-neutral", () => {
    for (let seed = 0; seed < PROPERTY_CASES; seed += 1) {
      const run = generatedIssueRun(seed);
      const withoutRefusal = run.accepted.reduce(issueReducer, issueInitialState);
      const withRefusal = run.trace.reduce(issueReducer, issueInitialState);
      expect(stateDigest(withRefusal)).toBe(stateDigest(withoutRefusal));
    }
    console.info(
      `E5_T01_PROPERTY property=(d) seeds=${PROPERTY_CASES} steps=${PROPERTY_STEPS} seed-range=0..${PROPERTY_CASES - 1}`,
    );
  });
});
