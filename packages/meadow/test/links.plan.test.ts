import { readFileSync } from "node:fs";
import { canonicalJson, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { prInitialStateForStream, prReducer } from "@eforest/pr";
import { describe, expect, it, vi } from "vitest";
import {
  EntityRefError,
  PrLinkRefusalError,
  driveLinkPropagation,
  isEntityRef,
  isMeadowPrOpenedEvent,
  isPrLinkClosedEvent,
  isPrLinkNoopEvent,
  meadowPrInitialStateForStream,
  meadowPrReducer,
  parseEntityRef,
  planLinkPropagation,
  validateMeadowPrPostTerminal,
  validatePrLinkEvent,
  type EntityRef,
  type IssueLinkSnapshot,
  type IssueLinkSnapshots,
  type LinkPropagationDriverContext,
  type LinkPropagationTrigger,
  type MeadowPrState,
  type PrLinkClosedEvent,
  type PrLinkNoopEvent,
} from "../src/index.js";

const PR_STREAM = "pr:maple/reading-room/42";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const ISSUE_A: EntityRef = { entity: "issue", stream: "issue:maple/reading-room/7" };
const ISSUE_B: EntityRef = { entity: "issue", stream: "issue:maple/reading-room/8" };
const OPENED_OFFSET = offsetForOrdinal(2);
const MERGED_OFFSET = offsetForOrdinal(5);
const RESULT_DIGEST = "a".repeat(64);

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

function persisted(
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
): Event & { readonly offset: Offset } {
  return { ...event(type, payload, ordinal), offset: offsetForOrdinal(ordinal) };
}

function openedEvent(closes?: readonly EntityRef[]): Event {
  return event("pr.opened", {
    v: 1,
    sourceBranch: SOURCE_STREAM,
    targetBranch: TARGET_STREAM,
    forkOffset: offsetForOrdinal(1),
    title: "Link issues",
    body: "Body",
    author: "alice",
    ...(closes === undefined ? {} : { closes }),
  });
}

function openState(closes?: readonly EntityRef[]): MeadowPrState {
  return meadowPrReducer(meadowPrInitialStateForStream(PR_STREAM), {
    ...openedEvent(closes),
    offset: OPENED_OFFSET,
  });
}

function mergedState(closes: readonly EntityRef[] = [ISSUE_A]): {
  readonly state: MeadowPrState;
  readonly records: readonly Event[];
} {
  const opened = { ...openedEvent(closes), offset: OPENED_OFFSET };
  const approved = persisted(4, "pr.approved", { v: 1, reviewer: "reviewer" });
  const merged = persisted(5, "pr.merged", {
    v: 1,
    targetMergeOffset: offsetForOrdinal(20),
    kind: "fast-forward",
    resultTreeDigest: RESULT_DIGEST,
  });
  const state = [opened, approved, merged].reduce(
    meadowPrReducer,
    meadowPrInitialStateForStream(PR_STREAM),
  );
  return { state, records: [opened, approved, merged] };
}

function present(
  state: "open" | "in-progress" | "done" | "closed" | "wont-do" = "open",
  patch: Partial<Extract<IssueLinkSnapshot, { readonly kind: "present" }>> = {},
): Extract<IssueLinkSnapshot, { readonly kind: "present" }> {
  return { kind: "present", headOffset: offsetForOrdinal(10), state, ...patch };
}

const OPEN_TRIGGER: LinkPropagationTrigger = {
  kind: "opened",
  prStreamId: PR_STREAM,
  openedOffset: OPENED_OFFSET,
  ts: 10,
};

const MERGE_TRIGGER: LinkPropagationTrigger = {
  kind: "merged",
  prStreamId: PR_STREAM,
  prMergedOffset: MERGED_OFFSET,
  ts: 20,
};

describe("EntityRef and PR envelope schemas", () => {
  it("accepts only the exact frozen issue reference object", () => {
    expect(parseEntityRef(ISSUE_A)).toEqual(ISSUE_A);
    expect(isEntityRef(ISSUE_A)).toBe(true);
    for (const invalid of [
      { entity: "wiki", stream: ISSUE_A.stream },
      { entity: "issue", stream: 7 },
      { entity: "issue", stream: "" },
      { entity: "issue", stream: ISSUE_A.stream, extra: true },
      [ISSUE_A],
      null,
    ]) {
      expect(isEntityRef(invalid)).toBe(false);
      expect(() => parseEntityRef(invalid)).toThrow(EntityRefError);
    }
  });

  it("accepts optional closes exactly and preserves the legacy absent-field digest", () => {
    expect(isMeadowPrOpenedEvent(openedEvent())).toBe(true);
    expect(isMeadowPrOpenedEvent(openedEvent([ISSUE_A]))).toBe(true);
    expect(
      isMeadowPrOpenedEvent(
        event("pr.opened", { ...(openedEvent([ISSUE_A]).payload as object), extra: true }),
      ),
    ).toBe(false);
    expect(
      isMeadowPrOpenedEvent(
        event("pr.opened", {
          ...(openedEvent().payload as object),
          closes: [{ entity: "wiki", stream: "opaque" }],
        }),
      ),
    ).toBe(false);

    const legacy = { ...openedEvent(), offset: OPENED_OFFSET };
    const base = prReducer(prInitialStateForStream(PR_STREAM), legacy);
    const meadow = meadowPrReducer(meadowPrInitialStateForStream(PR_STREAM), legacy);
    expect(meadow).toEqual(base);
    expect(meadow).not.toHaveProperty("closes");
    expect(meadow).not.toHaveProperty("links");
    expect(stateDigest(meadow)).toBe(stateDigest(base));
  });

  it("preserves recorded closes order while canonical links collapse duplicate refs", () => {
    const state = openState([ISSUE_A, ISSUE_A, ISSUE_B]);
    expect(state.closes).toEqual([ISSUE_A, ISSUE_A, ISSUE_B]);
    expect(state.links).toEqual([
      { ref: ISSUE_A, state: "linked" },
      { ref: ISSUE_B, state: "linked" },
    ]);
  });

  it("freezes exact link schemas with discriminated noop provenance", () => {
    const closed = event("pr.link-closed", {
      v: 1,
      ref: ISSUE_A,
      issueOffset: offsetForOrdinal(30),
    });
    const openNoop = event("pr.link-noop", {
      v: 1,
      ref: ISSUE_A,
      reason: "dangling-reference",
      provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
    });
    const mergeNoop = event("pr.link-noop", {
      v: 1,
      ref: ISSUE_A,
      reason: "already-done",
      provenance: { trigger: "merged", prMergedOffset: MERGED_OFFSET },
    });
    expect(isPrLinkClosedEvent(closed)).toBe(true);
    expect(isPrLinkNoopEvent(openNoop)).toBe(true);
    expect(isPrLinkNoopEvent(mergeNoop)).toBe(true);
    expect(
      isPrLinkNoopEvent(event("pr.link-noop", { v: 1, ref: ISSUE_A, reason: "already-done" })),
    ).toBe(false);
    expect(
      isPrLinkNoopEvent(
        event("pr.link-noop", {
          ...(mergeNoop.payload as object),
          provenance: { trigger: "merged", openedOffset: MERGED_OFFSET },
        }),
      ),
    ).toBe(false);
    expect(
      isPrLinkNoopEvent(
        event("pr.link-noop", {
          v: 1,
          ref: ISSUE_A,
          reason: "already-done",
          provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
        }),
      ),
    ).toBe(false);
  });
});

describe("PR link reducer and post-terminal validation", () => {
  it("folds stamped noops and close backlinks without lifecycle effects", () => {
    const openNoop = {
      ...event("pr.link-noop", {
        v: 1,
        ref: ISSUE_A,
        reason: "dangling-reference",
        provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
        actor: "alice",
        writer: "session",
      }),
      offset: offsetForOrdinal(3),
    };
    const dangling = meadowPrReducer(openState([ISSUE_A]), openNoop);
    expect(dangling.status).toBe("open");
    expect(dangling.links).toEqual([
      {
        ref: ISSUE_A,
        state: "noop",
        reason: "dangling-reference",
        provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
      },
    ]);

    const merged = mergedState().state;
    const linked = meadowPrReducer(merged, {
      ...event("pr.link-closed", {
        v: 1,
        ref: ISSUE_A,
        issueOffset: offsetForOrdinal(30),
        actor: "alice",
        writer: "session",
      }),
      offset: offsetForOrdinal(6),
    });
    expect(linked.status).toBe("merged");
    expect(linked.links).toEqual([
      { ref: ISSUE_A, state: "closed", issueOffset: offsetForOrdinal(30) },
    ]);
  });

  it("validates own-merge provenance and the issue-side close citation", async () => {
    const { state, records } = mergedState();
    const context = {
      streamId: PR_STREAM,
      state,
      records,
      resolveIssueClose: vi.fn(async () => ({
        prStream: PR_STREAM,
        prMergedOffset: MERGED_OFFSET,
      })),
    };
    const noop: PrLinkNoopEvent = {
      type: "pr.link-noop",
      payload: {
        v: 1,
        ref: ISSUE_A,
        reason: "already-done",
        provenance: { trigger: "merged", prMergedOffset: MERGED_OFFSET },
      },
      ts: 1,
    };
    const closed: PrLinkClosedEvent = {
      type: "pr.link-closed",
      payload: { v: 1, ref: ISSUE_A, issueOffset: offsetForOrdinal(30) },
      ts: 1,
    };
    await expect(validatePrLinkEvent(noop, context)).resolves.toBeUndefined();
    await expect(validatePrLinkEvent(closed, context)).resolves.toBeUndefined();

    await expect(
      validatePrLinkEvent(
        {
          ...noop,
          payload: {
            ...noop.payload,
            provenance: { trigger: "merged", prMergedOffset: offsetForOrdinal(4) },
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ reason: "pr/link-provenance-mismatch" });

    await expect(
      validateMeadowPrPostTerminal(event("pr.approved", { v: 1, reviewer: "other" }), context),
    ).rejects.toEqual(new PrLinkRefusalError("pr/terminal"));
  });

  it("refuses every link after a non-merged close", async () => {
    const closedState = { ...openState([ISSUE_A]), status: "closed" as const };
    const context = {
      streamId: PR_STREAM,
      state: closedState,
      records: [],
      resolveIssueClose: async () => undefined,
    };
    await expect(
      validatePrLinkEvent(
        event("pr.link-noop", {
          v: 1,
          ref: ISSUE_A,
          reason: "dangling-reference",
          provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
        }),
        context,
      ),
    ).rejects.toMatchObject({ reason: "pr/terminal" });
  });
});

describe("planLinkPropagation", () => {
  it("is pure, byte-deterministic, links on open, and collapses duplicate refs", () => {
    const state = openState([ISSUE_A, ISSUE_A, ISSUE_B]);
    const issues: IssueLinkSnapshots = {
      [ISSUE_A.stream]: present(),
      [ISSUE_B.stream]: present("in-progress"),
    };
    const first = planLinkPropagation(OPEN_TRIGGER, state, issues);
    const second = planLinkPropagation(OPEN_TRIGGER, state, issues);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.map(({ kind }) => kind)).toEqual(["append-issue-link", "append-issue-link"]);
    expect(first.map((step) => step.ref)).toEqual([ISSUE_A, ISSUE_B]);
  });

  it("records open-time dangling provenance and deduplicates its rerun", () => {
    const state = openState([ISSUE_A]);
    const plan = planLinkPropagation(OPEN_TRIGGER, state, {});
    expect(plan).toMatchObject([
      {
        kind: "append-pr-link-noop",
        event: {
          type: "pr.link-noop",
          payload: {
            reason: "dangling-reference",
            provenance: { trigger: "opened", openedOffset: OPENED_OFFSET },
          },
        },
      },
    ]);
    const reduced = meadowPrReducer(state, {
      ...plan[0]!.event,
      offset: offsetForOrdinal(3),
    });
    expect(planLinkPropagation(OPEN_TRIGGER, reduced, {})).toEqual([]);
    expect(
      planLinkPropagation(OPEN_TRIGGER, reduced, {
        [ISSUE_A.stream]: present("open"),
      }),
    ).toEqual([]);
  });

  it("plans a landed close and emits exact merge provenance", () => {
    const state = mergedState().state;
    const plan = planLinkPropagation(MERGE_TRIGGER, state, {
      [ISSUE_A.stream]: present("in-progress"),
    });
    expect(plan).toMatchObject([
      {
        kind: "append-issue-close",
        prStreamId: PR_STREAM,
        issueStreamId: ISSUE_A.stream,
        expectedHead: offsetForOrdinal(10),
        event: {
          type: "issue.state-changed",
          payload: {
            v: 2,
            to: "done",
            via: { prStream: PR_STREAM, prMergedOffset: MERGED_OFFSET },
          },
        },
      },
    ]);
  });

  it.each([
    ["done", "already-done"],
    ["closed", "illegal-transition"],
  ] as const)("records and deduplicates the %s merge no-op", (issueState, reason) => {
    const state = mergedState().state;
    const issues = { [ISSUE_A.stream]: present(issueState) };
    const plan = planLinkPropagation(MERGE_TRIGGER, state, issues);
    expect(plan).toMatchObject([
      {
        kind: "append-pr-link-noop",
        event: {
          payload: {
            reason,
            provenance: { trigger: "merged", prMergedOffset: MERGED_OFFSET },
          },
        },
      },
    ]);
    const reduced = meadowPrReducer(state, {
      ...plan[0]!.event,
      offset: offsetForOrdinal(6),
    });
    expect(planLinkPropagation(MERGE_TRIGGER, reduced, issues)).toEqual([]);
  });

  it("records and deduplicates a merge-time dangling no-op", () => {
    const state = mergedState().state;
    const plan = planLinkPropagation(MERGE_TRIGGER, state, {});
    expect(plan[0]).toMatchObject({
      kind: "append-pr-link-noop",
      event: {
        payload: {
          reason: "dangling-reference",
          provenance: { trigger: "merged", prMergedOffset: MERGED_OFFSET },
        },
      },
    });
    const reduced = meadowPrReducer(state, {
      ...plan[0]!.event,
      offset: offsetForOrdinal(6),
    });
    expect(planLinkPropagation(MERGE_TRIGGER, reduced, {})).toEqual([]);
    expect(
      planLinkPropagation(MERGE_TRIGGER, reduced, {
        [ISSUE_A.stream]: present("open"),
      }),
    ).toEqual([]);
  });

  it("deduplicates a merge no-op by provenance even if a stale caller changes its reason", async () => {
    const state = mergedState().state;
    const first = planLinkPropagation(MERGE_TRIGGER, state, {
      [ISSUE_A.stream]: present("done"),
    });
    const reduced = meadowPrReducer(state, {
      ...first[0]!.event,
      offset: offsetForOrdinal(6),
    });
    const conflictingReason: PrLinkNoopEvent = {
      type: "pr.link-noop",
      payload: {
        v: 1,
        ref: ISSUE_A,
        reason: "illegal-transition",
        provenance: { trigger: "merged", prMergedOffset: MERGED_OFFSET },
      },
      ts: 30,
    };
    const { records } = mergedState();
    await expect(
      validatePrLinkEvent(conflictingReason, {
        streamId: PR_STREAM,
        state: reduced,
        records,
        resolveIssueClose: async () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "pr/link-duplicate" });
    expect(meadowPrReducer(reduced, { ...conflictingReason, offset: offsetForOrdinal(7) })).toBe(
      reduced,
    );
  });

  it("ignores trigger offsets that do not belong to the reduced PR", () => {
    expect(
      planLinkPropagation(
        { ...OPEN_TRIGGER, openedOffset: offsetForOrdinal(1) },
        openState([ISSUE_A]),
        { [ISSUE_A.stream]: present() },
      ),
    ).toEqual([]);
    expect(
      planLinkPropagation(
        { ...MERGE_TRIGGER, prMergedOffset: offsetForOrdinal(4) },
        mergedState().state,
        { [ISSUE_A.stream]: present() },
      ),
    ).toEqual([]);
  });

  it("collapses duplicate close refs and handles duplicate-via plus crash recovery", () => {
    const state = mergedState([ISSUE_A, ISSUE_A]).state;
    const close = {
      prStream: PR_STREAM,
      prMergedOffset: MERGED_OFFSET,
      issueOffset: offsetForOrdinal(30),
    };
    const issues = {
      [ISSUE_A.stream]: present("done", { closedBy: [close] }),
    };
    const recovery = planLinkPropagation(MERGE_TRIGGER, state, issues);
    expect(recovery).toMatchObject([
      {
        kind: "append-pr-link-closed",
        event: { payload: { ref: ISSUE_A, issueOffset: offsetForOrdinal(30) } },
      },
    ]);
    const complete = meadowPrReducer(state, {
      ...recovery[0]!.event,
      offset: offsetForOrdinal(6),
    });
    expect(planLinkPropagation(MERGE_TRIGGER, complete, issues)).toEqual([]);
    expect(
      planLinkPropagation(MERGE_TRIGGER, complete, {
        [ISSUE_A.stream]: present("done"),
      }),
    ).toEqual([]);
  });

  it("does nothing for closed triggers and empty or absent closes", () => {
    expect(
      planLinkPropagation(
        { kind: "closed", prStreamId: PR_STREAM, closedOffset: offsetForOrdinal(4), ts: 1 },
        openState([ISSUE_A]),
        { [ISSUE_A.stream]: present() },
      ),
    ).toEqual([]);
    expect(planLinkPropagation(OPEN_TRIGGER, openState(), {})).toEqual([]);
    expect(planLinkPropagation(OPEN_TRIGGER, openState([]), {})).toEqual([]);
  });
});

describe("driveLinkPropagation", () => {
  it("re-reads and re-plans after a fence race, then appends close and backlink once", async () => {
    let pr = mergedState().state;
    let prHead = MERGED_OFFSET;
    let issue: IssueLinkSnapshot = present("open");
    let raced = false;
    const onReplan = vi.fn();
    const context: LinkPropagationDriverContext = {
      readPr: async () => ({ state: pr, headOffset: prHead }),
      readIssue: async () => issue,
      dispatchFenced: async (streamId, action, expectedHead) => {
        if (streamId === ISSUE_A.stream) {
          const current = issue as Extract<IssueLinkSnapshot, { readonly kind: "present" }>;
          if (!raced) {
            raced = true;
            issue = { ...current, headOffset: offsetForOrdinal(11) };
            throw new Error("fence");
          }
          expect(expectedHead).toBe(offsetForOrdinal(11));
          const issueOffset = offsetForOrdinal(12);
          issue = {
            ...current,
            state: "done",
            headOffset: issueOffset,
            closedBy: [{ prStream: PR_STREAM, prMergedOffset: MERGED_OFFSET, issueOffset }],
          };
          return { offset: issueOffset };
        }
        expect(streamId).toBe(PR_STREAM);
        expect(expectedHead).toBe(prHead);
        prHead = offsetForOrdinal(6);
        pr = meadowPrReducer(pr, { ...action, offset: prHead });
        return { offset: prHead };
      },
      isFenceRefusal: (error) => error instanceof Error && error.message === "fence",
      onReplan,
    };

    const receipt = await driveLinkPropagation(MERGE_TRIGGER, context);

    expect(receipt).toEqual({
      attempts: 2,
      appended: 2,
      offsets: [offsetForOrdinal(12), offsetForOrdinal(6)],
    });
    expect(onReplan).toHaveBeenCalledOnce();
    expect(pr.links).toEqual([
      { ref: ISSUE_A, state: "closed", issueOffset: offsetForOrdinal(12) },
    ]);
  });
});

function frozenBlock(source: string, name: string): string {
  const start = `<!-- frozen:E5-T07:${name} -->`;
  const end = `<!-- /frozen:E5-T07:${name} -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing frozen block ${name}`);
  return source.slice(startIndex, endIndex + end.length);
}

describe("frozen E5-T07 documentation", () => {
  it("reproduces all three task blocks byte-for-byte", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const task = readFileSync(
      new URL(
        "../../../.eforest/tasks/epic-5-the-meadow/E5-T07-cross-entity-linking/readme.md",
        import.meta.url,
      ),
      "utf8",
    );
    for (const name of ["entity-ref", "propagation-rules", "post-terminal-links"]) {
      expect(frozenBlock(readme, name)).toBe(frozenBlock(task, name));
    }
  });
});
