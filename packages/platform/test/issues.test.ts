import { describe, expect, it } from "vitest";
import type { Event } from "@eforest/protocol";
import {
  ISSUE_STATES,
  WORKFLOW_TRANSITIONS,
  issueInitialState,
  issueReducer,
  validateIssueEvent,
  IssueRefusalError,
  IssueSchemaError,
  PlatformGateway,
  type AuthorizationVerifier,
  type StreamAdapter,
} from "../src/index.js";
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
    const openedResponse = await post("issue.opened", { v: 1, title: "Bug", body: "Details" });
    expect(openedResponse.status).toBe(202);
    const refused = await post("issue.opened", { v: 1, title: "Again", body: "Nope" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { class: "validator-rejected", reason: "issue/already-opened" },
    });
    expect(streams.records).toHaveLength(1);

    const malformedOptional = await post("issue.closed", { reason: 42, v: 1 });
    expect(malformedOptional.status).toBe(422);
    const unknown = await post("issue.unknown", { v: 1 });
    expect(unknown.status).toBe(404);
    const comment = await post("issue.commented", { body: "hello", commentId: "c1", v: 1 });
    expect(comment.status).toBe(202);
    expect((await post("issue.commented", { body: "again", commentId: "c1", v: 1 })).status).toBe(
      409,
    );
    expect((await post("issue.labeled", { label: "bug", v: 1 })).status).toBe(202);
    expect((await post("issue.labeled", { label: "bug", v: 1 })).status).toBe(409);
    expect((await post("issue.unlabeled", { label: "missing", v: 1 })).status).toBe(409);
    expect((await post("issue.state-changed", { to: "open", v: 1 })).status).toBe(409);
    expect((await post("issue.state-changed", { to: "closed", v: 1 })).status).toBe(409);
    expect((await post("issue.closed", { reason: "fixed", v: 1 })).status).toBe(202);
    expect((await post("issue.reopened", { v: 1 })).status).toBe(202);
    expect((await post("issue.reopened", { v: 1 })).status).toBe(409);
    expect(streams.records).toHaveLength(5);
  });
});
