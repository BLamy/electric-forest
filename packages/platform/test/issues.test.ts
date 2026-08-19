import { describe, expect, it } from "vitest";
import { stateDigest, type Event } from "@eforest/protocol";
import {
  ISSUE_STATES,
  WORKFLOW_TRANSITIONS,
  isLegal,
  issueInitialState,
  issueReducer,
  validateIssueEvent,
  IssueRefusalError,
  IssueSchemaError,
  PlatformGateway,
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
  return {
    head: records.length - 1,
    digest: stateDigest(clean.reduce(issueReducer, issueInitialState)),
  };
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
    const projection = replayWithReducer(definition!, [
      event("issue.opened", { body: "b", title: "t", v: 1 }),
    ]);
    expect(projection.state).toMatchObject({ state: "open", title: "t", body: "b" });
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

  it("property (a): 1000 generated accepted prefixes match isLegal", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      let state = issueInitialState;
      const accepted: Event[] = [];
      let random = (seed + 1) >>> 0;
      for (let step = 0; step < 12; step += 1) {
        random = (random * 1664525 + 1013904223) >>> 0;
        const choice = random % 7;
        const candidates = [
          event("issue.opened", { body: `body-${seed}`, title: `title-${seed}`, v: 1 }, step + 1),
          event(
            "issue.commented",
            { body: "comment", commentId: `c-${seed}-${step}`, v: 1 },
            step + 1,
          ),
          event("issue.labeled", { label: `label-${random % 3}`, v: 1 }, step + 1),
          event("issue.unlabeled", { label: `label-${random % 3}`, v: 1 }, step + 1),
          event(
            "issue.state-changed",
            { to: ["open", "in-progress", "done", "closed", "wont-do"][random % 5], v: 1 },
            step + 1,
          ),
          event("issue.closed", { reason: "generated", v: 1 }, step + 1),
          event("issue.reopened", { v: 1 }, step + 1),
        ];
        const current = candidates[choice]!;
        const p = current.payload as Record<string, unknown>;
        let expected =
          accepted.length === 0 ? current.type === "issue.opened" : current.type !== "issue.opened";
        if (expected && current.type !== "issue.opened")
          expected = isLegal(state.state, current.type as never, p.to as never);
        if (expected && current.type === "issue.commented")
          expected = !state.comments.some((comment) => comment.commentId === p.commentId);
        if (expected && current.type === "issue.labeled")
          expected = !state.labels.includes(p.label as string);
        if (expected && current.type === "issue.unlabeled")
          expected = state.labels.includes(p.label as string);
        let actual = true;
        try {
          validateIssueEvent(current, state, accepted);
        } catch {
          actual = false;
        }
        expect(actual).toBe(expected);
        if (actual) {
          accepted.push(current);
          state = issueReducer(state, current);
        }
      }
      expect(["open", "in-progress", "done", "closed", "wont-do"]).toContain(state.state);
    }
  });

  it("property (b): 1000 reduced states preserve canonical invariants", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const state = issueReducer(
        issueReducer(issueInitialState, event("issue.opened", { body: "b", title: "t", v: 1 })),
        event("issue.labeled", { label: `label-${seed}`, v: 1 }),
      );
      expect(["open", "in-progress", "done", "closed", "wont-do"]).toContain(state.state);
      expect([...state.labels].sort()).toEqual(state.labels);
      expect(new Set(state.labels).size).toBe(state.labels.length);
    }
  });

  it("property (c): 1000 accepted replays have identical digests", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const events = [event("issue.opened", { body: "b", title: `t-${seed}`, v: 1 })];
      const first = events.reduce(issueReducer, issueInitialState);
      const second = events.reduce(issueReducer, issueInitialState);
      expect(stateDigest(first)).toBe(stateDigest(second));
    }
  });

  it("property (d): 1000 refused interleavings are log-neutral", () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const opened = event("issue.opened", { body: "b", title: "t", v: 1 });
      const accepted = event("issue.labeled", { label: `label-${seed}`, v: 1 });
      const refused = event("issue.labeled", { label: `label-${seed}`, v: 1 });
      const withoutRefusal = issueReducer(issueReducer(issueInitialState, opened), accepted);
      const withRefusal = issueReducer(
        issueReducer(issueReducer(issueInitialState, opened), accepted),
        refused,
      );
      expect(stateDigest(withRefusal)).toBe(stateDigest(withoutRefusal));
    }
  });
});
