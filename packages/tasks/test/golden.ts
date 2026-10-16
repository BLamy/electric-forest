import type { Event, Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { taskEvidenceStreamId, taskStreamId } from "../src/index.js";

export const GOLDEN_ORG = "maple";
export const GOLDEN_REPO = "reading-room";
export const GOLDEN_TASK_ID = "E6-T01-golden";
export const GOLDEN_STREAM = taskStreamId(GOLDEN_ORG, GOLDEN_REPO, GOLDEN_TASK_ID);
export const GOLDEN_EVIDENCE_STREAM = taskEvidenceStreamId(GOLDEN_STREAM)!;
export const GOLDEN_ATTACHMENTS = ["log-a1", "log-a2", "replay-a2"] as const;
export const GOLDEN_LABEL = "bug";

export const BUILDER = "builder-ash";
export const CRITIC = "critic-fern";
export const OUTSIDER = "builder-birch";

export function run(n: number): string {
  return `agent-run:${GOLDEN_ORG}/${GOLDEN_TASK_ID}-run-${n}`;
}

export function branch(attempt: number, head: number) {
  return {
    stream: `fs:${GOLDEN_ORG}/${GOLDEN_REPO}:e6-t01-golden-a${attempt}:meta`,
    head: offsetForOrdinal(head),
  };
}

export const by = (actor: string, role: "builder" | "critic", runNumber: number) => ({
  actor,
  role,
  run: run(runNumber),
});

export const claimRef = (offset: number) => ({
  stream: GOLDEN_STREAM,
  offset: offsetForOrdinal(offset),
});

/**
 * The frozen valid lifecycle: pending -> in-progress -> implemented -> refuted ->
 * in-progress -> implemented -> verified, with issue chatter interleaved. Offsets 0..9.
 */
export const GOLDEN_EVENTS: readonly Event[] = [
  { type: "issue.opened", payload: { v: 1, title: "Task event model", body: "E6-T01" }, ts: 1000 },
  { type: "issue.labeled", payload: { v: 1, label: GOLDEN_LABEL }, ts: 1001 },
  {
    type: "issue.commented",
    payload: { v: 1, commentId: "c-1", body: "threat model frozen" },
    ts: 1002,
  },
  { type: "task.started", payload: { v: 1, by: by(BUILDER, "builder", 1) }, ts: 1003 },
  {
    type: "task.claimed",
    payload: {
      v: 1,
      by: by(BUILDER, "builder", 1),
      branch: branch(1, 3),
      evidence: { stream: GOLDEN_EVIDENCE_STREAM, attachmentIds: ["log-a1"] },
      summary: "attempt 1: reducer and validators land",
    },
    ts: 1004,
  },
  {
    type: "task.refuted",
    payload: {
      v: 1,
      by: by(CRITIC, "critic", 2),
      claim: claimRef(4),
      branch: branch(1, 3),
      evidence: { stream: GOLDEN_EVIDENCE_STREAM, attachmentIds: ["log-a1"] },
      findings: [
        {
          fingerprint: "digest-diverges-at-offset-2",
          summary: "replayed digest differs from the claimed digest at offset 2",
          citation: { stream: GOLDEN_EVIDENCE_STREAM, attachmentId: "log-a1" },
        },
        {
          fingerprint: "uncovered-rework-hunk",
          summary: "rework path never executed in the recorded run",
          citation: { stream: branch(1, 3).stream, offset: branch(1, 3).head },
        },
      ],
    },
    ts: 1005,
  },
  {
    type: "task.rework-started",
    payload: { v: 1, by: by(BUILDER, "builder", 3), refutation: claimRef(5) },
    ts: 1006,
  },
  { type: "issue.commented", payload: { v: 1, commentId: "c-2", body: "reworked" }, ts: 1007 },
  {
    type: "task.claimed",
    payload: {
      v: 1,
      by: by(BUILDER, "builder", 3),
      branch: branch(2, 7),
      evidence: { stream: GOLDEN_EVIDENCE_STREAM, attachmentIds: ["log-a2", "replay-a2"] },
      summary: "attempt 2: refusal transcripts and sensitivity proof added",
    },
    ts: 1008,
  },
  {
    type: "task.verified",
    payload: {
      v: 1,
      by: by(CRITIC, "critic", 4),
      claim: claimRef(8),
      branch: branch(2, 7),
      evidence: { stream: GOLDEN_EVIDENCE_STREAM, attachmentIds: ["log-a2"] },
      summary: "every attack survived; fixtures promoted",
    },
    ts: 1009,
  },
];

export const GOLDEN_OFFSET_EVENTS: readonly (Event & { readonly offset: Offset })[] =
  GOLDEN_EVENTS.map((record, index) => ({ ...record, offset: offsetForOrdinal(index) }));

export interface RefusalScenario {
  readonly name: string;
  /** Replay this many golden events first (a prefix of the frozen valid log). */
  readonly prefix: number;
  readonly streamId: string;
  /** Actor the door authenticated for this dispatch. */
  readonly actor: string;
  /** Refused only at the dispatch door (identity binding, attachment lookup); the pure reducer cannot see it. */
  readonly dispatchOnly?: true;
  readonly event: Event;
  readonly expect:
    | { readonly class: "validator-rejected"; readonly reason: string }
    | { readonly class: "schema-violation" }
    | { readonly class: "unknown-action-type" };
}

const FOREIGN_STREAM = taskStreamId(GOLDEN_ORG, GOLDEN_REPO, "E6-T01-other");
const verified = GOLDEN_EVENTS[9]!;
const claimed = GOLDEN_EVENTS[4]!;
const refuted = GOLDEN_EVENTS[5]!;
const reworked = GOLDEN_EVENTS[6]!;
const started = GOLDEN_EVENTS[3]!;
const withPayload = (base: Event, patch: Record<string, unknown>, ts: number): Event => ({
  type: base.type,
  payload: { ...(base.payload as Record<string, unknown>), ...patch },
  ts,
});

/** Every refusal the dispatch door must issue before append; each leaves head and digest untouched. */
export const REFUSAL_SCENARIOS: readonly RefusalScenario[] = [
  {
    name: "builder-verifies",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: OUTSIDER,
    event: withPayload(
      verified,
      { by: by(OUTSIDER, "builder", 9), claim: claimRef(4), branch: branch(1, 3) },
      2000,
    ),
    expect: { class: "validator-rejected", reason: "task/wrong-role" },
  },
  {
    name: "verify-before-claim",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(verified, { claim: claimRef(3), branch: branch(1, 3) }, 2001),
    expect: { class: "validator-rejected", reason: "task/no-claim" },
  },
  {
    name: "verify-stale-claim",
    prefix: 9,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(verified, { claim: claimRef(4), branch: branch(1, 3) }, 2002),
    expect: { class: "validator-rejected", reason: "task/stale-claim" },
  },
  {
    name: "verify-stale-branch-head",
    prefix: 9,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(verified, { branch: branch(2, 6) }, 2003),
    expect: { class: "validator-rejected", reason: "task/stale-claim" },
  },
  {
    name: "verify-after-terminal",
    prefix: 10,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(verified, {}, 2004),
    expect: { class: "validator-rejected", reason: "task/terminal" },
  },
  {
    name: "refute-after-terminal",
    prefix: 10,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(refuted, { claim: claimRef(8), branch: branch(2, 7) }, 2005),
    expect: { class: "validator-rejected", reason: "task/terminal" },
  },
  {
    name: "self-verdict",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(refuted, { by: by(BUILDER, "critic", 9) }, 2006),
    expect: { class: "validator-rejected", reason: "task/self-verdict" },
  },
  {
    name: "foreign-claim",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(
      refuted,
      { claim: { stream: FOREIGN_STREAM, offset: offsetForOrdinal(4) } },
      2007,
    ),
    expect: { class: "validator-rejected", reason: "task/foreign-claim" },
  },
  {
    name: "critic-claims",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(claimed, { by: by(CRITIC, "critic", 9) }, 2008),
    expect: { class: "validator-rejected", reason: "task/wrong-role" },
  },
  {
    name: "claim-before-start",
    prefix: 3,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(claimed, {}, 2009),
    expect: { class: "validator-rejected", reason: "task/illegal-transition" },
  },
  {
    name: "duplicate-claim",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(claimed, {}, 2010),
    expect: { class: "validator-rejected", reason: "task/illegal-transition" },
  },
  {
    name: "duplicate-start",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(started, {}, 2011),
    expect: { class: "validator-rejected", reason: "task/illegal-transition" },
  },
  {
    name: "start-before-open",
    prefix: 0,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(started, {}, 2012),
    expect: { class: "validator-rejected", reason: "task/not-opened" },
  },
  {
    name: "builder-mismatch",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: OUTSIDER,
    event: withPayload(claimed, { by: by(OUTSIDER, "builder", 9) }, 2013),
    expect: { class: "validator-rejected", reason: "task/builder-mismatch" },
  },
  {
    name: "foreign-branch",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(
      claimed,
      { branch: { stream: "fs:maple/other-repo:main:meta", head: offsetForOrdinal(1) } },
      2014,
    ),
    expect: { class: "validator-rejected", reason: "task/foreign-branch" },
  },
  {
    name: "foreign-evidence",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(
      claimed,
      { evidence: { stream: taskEvidenceStreamId(FOREIGN_STREAM)!, attachmentIds: ["log-a1"] } },
      2015,
    ),
    expect: { class: "validator-rejected", reason: "task/foreign-evidence" },
  },
  {
    name: "unknown-attachment",
    prefix: 4,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    dispatchOnly: true,
    event: withPayload(
      claimed,
      { evidence: { stream: GOLDEN_EVIDENCE_STREAM, attachmentIds: ["log-missing"] } },
      2016,
    ),
    expect: { class: "validator-rejected", reason: "task/unknown-attachment" },
  },
  {
    name: "stale-refutation",
    prefix: 6,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(reworked, { refutation: claimRef(4) }, 2017),
    expect: { class: "validator-rejected", reason: "task/stale-refutation" },
  },
  {
    name: "foreign-refutation",
    prefix: 6,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(
      reworked,
      { refutation: { stream: FOREIGN_STREAM, offset: offsetForOrdinal(5) } },
      2024,
    ),
    expect: { class: "validator-rejected", reason: "task/foreign-refutation" },
  },
  {
    name: "rework-before-refutation",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(reworked, { refutation: claimRef(4) }, 2018),
    expect: { class: "validator-rejected", reason: "task/illegal-transition" },
  },
  {
    name: "actor-mismatch",
    prefix: 3,
    streamId: GOLDEN_STREAM,
    actor: OUTSIDER,
    dispatchOnly: true,
    event: withPayload(started, {}, 2019),
    expect: { class: "validator-rejected", reason: "task/actor-mismatch" },
  },
  {
    name: "unknown-version",
    prefix: 3,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(started, { v: 2 }, 2020),
    expect: { class: "schema-violation" },
  },
  {
    name: "empty-findings",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: withPayload(refuted, { findings: [] }, 2021),
    expect: { class: "schema-violation" },
  },
  {
    name: "unknown-field",
    prefix: 3,
    streamId: GOLDEN_STREAM,
    actor: BUILDER,
    event: withPayload(started, { note: "extra" }, 2022),
    expect: { class: "schema-violation" },
  },
  {
    name: "unknown-type",
    prefix: 5,
    streamId: GOLDEN_STREAM,
    actor: CRITIC,
    event: { type: "task.blessed", payload: { v: 1, by: by(CRITIC, "critic", 9) }, ts: 2023 },
    expect: { class: "unknown-action-type" },
  },
];
