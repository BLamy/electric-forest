import { canonicalJson, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { describe, expect, it } from "vitest";
import {
  issueInitialStateFor,
  issueReducer,
  isIssueEnvelopeSourceValid,
  IssueRefusalError,
  IssueSchemaError,
  parseJsonWithIssueEnvelopeSource,
  validateIssueEvent,
} from "../src/index.js";

const PR_STREAM = "pr:maple/reading-room/42";
const MERGED_OFFSET = offsetForOrdinal(4);

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

function openedState() {
  return issueReducer(
    issueInitialStateFor("7"),
    event("issue.opened", { v: 1, title: "Link me", body: "Cross-stream" }),
  );
}

describe("E5-T07 issue-side link extension", () => {
  it("admits exact v2 source tokens without weakening numeric spelling", () => {
    const source = JSON.stringify({
      streamId: "issue:maple/reading-room/7",
      event: event("issue.linked", {
        v: 2,
        by: { entity: "pr", stream: PR_STREAM },
        atOffset: offsetForOrdinal(0),
      }),
    });
    expect(
      isIssueEnvelopeSourceValid(
        parseJsonWithIssueEnvelopeSource(source, Buffer.byteLength(source)).issueSource,
      ),
    ).toBe(true);
    expect(
      isIssueEnvelopeSourceValid(
        parseJsonWithIssueEnvelopeSource(
          source.replace('"v":2', '"v":2.0'),
          Buffer.byteLength(source),
        ).issueSource,
      ),
    ).toBe(false);
  });

  it("keeps v1 state byte-identical until a linking event lands", () => {
    const state = openedState();
    expect(canonicalJson(state)).toBe(
      '{"body":"Cross-stream","comments":[],"issueId":"7","labels":[],"state":"open","title":"Link me","v":1}',
    );
    expect(state).not.toHaveProperty("linkedBy");
    expect(state).not.toHaveProperty("closedBy");
  });

  it("folds a backlink without changing workflow state", () => {
    const state = openedState();
    const linked = event("issue.linked", {
      v: 2,
      by: { entity: "pr", stream: PR_STREAM },
      atOffset: offsetForOrdinal(0),
    });

    expect(() => validateIssueEvent(linked, state, [event("issue.opened", {})])).not.toThrow();
    expect(issueReducer(state, linked)).toMatchObject({
      state: "open",
      linkedBy: [{ prStream: PR_STREAM, atOffset: offsetForOrdinal(0) }],
    });
  });

  it("records merge provenance and refuses an exact duplicate close", () => {
    const inProgress = issueReducer(
      openedState(),
      event("issue.state-changed", { v: 1, to: "in-progress" }),
    );
    const close = event("issue.state-changed", {
      v: 2,
      to: "done",
      via: { prStream: PR_STREAM, prMergedOffset: MERGED_OFFSET },
    });
    validateIssueEvent(close, inProgress, [event("issue.opened", {})]);
    const done = issueReducer(inProgress, close);
    expect(done).toMatchObject({
      state: "done",
      closedBy: [{ prStream: PR_STREAM, prMergedOffset: MERGED_OFFSET }],
    });

    expect(() => validateIssueEvent(close, done, [event("issue.opened", {}), close])).toThrow(
      new IssueRefusalError("link/duplicate-close"),
    );
    expect(issueReducer(done, close)).toEqual(done);
  });

  it("keeps v2 exact and leaves closed-to-done illegal", () => {
    const state = openedState();
    const extra = event("issue.linked", {
      v: 2,
      by: { entity: "pr", stream: PR_STREAM },
      atOffset: offsetForOrdinal(0),
      extra: true,
    });
    expect(() => validateIssueEvent(extra, state, [event("issue.opened", {})])).toThrow(
      IssueSchemaError,
    );

    const closed = issueReducer(state, event("issue.closed", { v: 1 }));
    const close = event("issue.state-changed", {
      v: 2,
      to: "done",
      via: { prStream: PR_STREAM, prMergedOffset: MERGED_OFFSET },
    });
    expect(() => validateIssueEvent(close, closed, [event("issue.opened", {})])).toThrow(
      new IssueRefusalError("issue/illegal-transition"),
    );
  });
});
