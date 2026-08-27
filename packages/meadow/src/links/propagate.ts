import type { Event, Offset } from "@eforest/protocol";
import { sameEntityRef, uniqueEntityRefs, type EntityRef } from "./refs.js";
import type { MeadowPrState, PrLink } from "../pr/reducer.js";
import type {
  PrLinkClosedEvent,
  PrLinkNoopEvent,
  PrLinkNoopProvenance,
  PrLinkNoopReason,
} from "../pr/events.js";

export type LinkIssueWorkflowState = "open" | "in-progress" | "done" | "closed" | "wont-do";

export interface IssueLinkBacklink {
  readonly prStream: string;
  readonly atOffset: Offset;
}

export interface IssueCloseRecord {
  readonly prStream: string;
  readonly prMergedOffset: Offset;
  /** Derived by the injected reader from the closing event's record offset. */
  readonly issueOffset: Offset;
}

export interface PresentIssueLinkSnapshot {
  readonly kind: "present";
  readonly headOffset: Offset;
  readonly state: LinkIssueWorkflowState;
  readonly linkedBy?: readonly IssueLinkBacklink[];
  readonly closedBy?: readonly IssueCloseRecord[];
}

export interface AbsentIssueLinkSnapshot {
  readonly kind: "absent";
}

export type IssueLinkSnapshot = PresentIssueLinkSnapshot | AbsentIssueLinkSnapshot;
export type IssueLinkSnapshots = Readonly<Record<string, IssueLinkSnapshot | undefined>>;

export type LinkPropagationTrigger =
  | {
      readonly kind: "opened";
      readonly prStreamId: string;
      readonly openedOffset: Offset;
      readonly ts: number;
    }
  | {
      readonly kind: "merged";
      readonly prStreamId: string;
      readonly prMergedOffset: Offset;
      readonly ts: number;
    }
  | {
      readonly kind: "closed";
      readonly prStreamId: string;
      readonly closedOffset: Offset;
      readonly ts: number;
    };

export interface IssueLinkedEvent extends Event {
  readonly type: "issue.linked";
  readonly payload: {
    readonly v: 2;
    readonly by: { readonly entity: "pr"; readonly stream: string };
    readonly atOffset: Offset;
  };
}

export interface IssueClosedByPrEvent extends Event {
  readonly type: "issue.state-changed";
  readonly payload: {
    readonly v: 2;
    readonly to: "done";
    readonly via: { readonly prStream: string; readonly prMergedOffset: Offset };
  };
}

export type PropagationStep =
  | {
      readonly kind: "append-issue-link";
      readonly ref: EntityRef;
      readonly issueStreamId: string;
      readonly expectedHead: Offset;
      readonly event: IssueLinkedEvent;
    }
  | {
      readonly kind: "append-issue-close";
      readonly ref: EntityRef;
      readonly prStreamId: string;
      readonly issueStreamId: string;
      readonly expectedHead: Offset;
      readonly event: IssueClosedByPrEvent;
    }
  | {
      readonly kind: "append-pr-link-closed";
      readonly prStreamId: string;
      readonly event: PrLinkClosedEvent;
    }
  | {
      readonly kind: "append-pr-link-noop";
      readonly prStreamId: string;
      readonly event: PrLinkNoopEvent;
    };

function sameProvenance(left: PrLinkNoopProvenance | undefined, right: PrLinkNoopProvenance) {
  if (right.trigger === "opened") {
    return left?.trigger === "opened" && left.openedOffset === right.openedOffset;
  }
  return left?.trigger === "merged" && left.prMergedOffset === right.prMergedOffset;
}

function linkFor(state: MeadowPrState, ref: EntityRef): PrLink | undefined {
  return state.links?.find((link) => sameEntityRef(link.ref, ref));
}

function hasNoop(state: MeadowPrState, ref: EntityRef, provenance: PrLinkNoopProvenance): boolean {
  const link = linkFor(state, ref);
  return link?.state === "noop" && sameProvenance(link.provenance, provenance);
}

function issueFor(issueStates: IssueLinkSnapshots, ref: EntityRef): IssueLinkSnapshot {
  return Object.hasOwn(issueStates, ref.stream)
    ? (issueStates[ref.stream] ?? { kind: "absent" })
    : { kind: "absent" };
}

function noopStep(
  trigger: Extract<LinkPropagationTrigger, { readonly kind: "opened" }>,
  ref: EntityRef,
  reason: "dangling-reference",
): PropagationStep;
function noopStep(
  trigger: Extract<LinkPropagationTrigger, { readonly kind: "merged" }>,
  ref: EntityRef,
  reason: PrLinkNoopReason,
): PropagationStep;
function noopStep(
  trigger: Extract<LinkPropagationTrigger, { readonly kind: "opened" | "merged" }>,
  ref: EntityRef,
  reason: PrLinkNoopReason,
): PropagationStep {
  if (trigger.kind === "opened") {
    return {
      kind: "append-pr-link-noop",
      prStreamId: trigger.prStreamId,
      event: {
        type: "pr.link-noop",
        payload: {
          v: 1,
          ref,
          reason: "dangling-reference",
          provenance: { trigger: "opened", openedOffset: trigger.openedOffset },
        },
        ts: trigger.ts,
      },
    };
  }
  return {
    kind: "append-pr-link-noop",
    prStreamId: trigger.prStreamId,
    event: {
      type: "pr.link-noop",
      payload: {
        v: 1,
        ref,
        reason,
        provenance: { trigger: "merged", prMergedOffset: trigger.prMergedOffset },
      },
      ts: trigger.ts,
    },
  };
}

function mayTransitionToDone(state: LinkIssueWorkflowState): boolean {
  return state === "open" || state === "in-progress" || state === "wont-do";
}

function planOpened(
  trigger: Extract<LinkPropagationTrigger, { readonly kind: "opened" }>,
  prState: MeadowPrState,
  issueStates: IssueLinkSnapshots,
): readonly PropagationStep[] {
  const steps: PropagationStep[] = [];
  for (const ref of uniqueEntityRefs(prState.closes ?? [])) {
    const provenance = { trigger: "opened", openedOffset: trigger.openedOffset } as const;
    if (hasNoop(prState, ref, provenance)) continue;
    const issue = issueFor(issueStates, ref);
    if (issue.kind === "absent") {
      steps.push(noopStep(trigger, ref, "dangling-reference"));
      continue;
    }
    if (
      issue.linkedBy?.some(
        (link) => link.prStream === trigger.prStreamId && link.atOffset === trigger.openedOffset,
      ) === true
    ) {
      continue;
    }
    steps.push({
      kind: "append-issue-link",
      ref,
      issueStreamId: ref.stream,
      expectedHead: issue.headOffset,
      event: {
        type: "issue.linked",
        payload: {
          v: 2,
          by: { entity: "pr", stream: trigger.prStreamId },
          atOffset: trigger.openedOffset,
        },
        ts: trigger.ts,
      },
    });
  }
  return steps;
}

function planMerged(
  trigger: Extract<LinkPropagationTrigger, { readonly kind: "merged" }>,
  prState: MeadowPrState,
  issueStates: IssueLinkSnapshots,
): readonly PropagationStep[] {
  const steps: PropagationStep[] = [];
  for (const ref of uniqueEntityRefs(prState.closes ?? [])) {
    const provenance = { trigger: "merged", prMergedOffset: trigger.prMergedOffset } as const;
    const current = linkFor(prState, ref);
    if (current?.state === "closed") continue;
    if (hasNoop(prState, ref, provenance)) continue;
    const issue = issueFor(issueStates, ref);
    if (issue.kind === "absent") {
      steps.push(noopStep(trigger, ref, "dangling-reference"));
      continue;
    }

    const existingClose = issue.closedBy?.find(
      (close) =>
        close.prStream === trigger.prStreamId && close.prMergedOffset === trigger.prMergedOffset,
    );
    if (existingClose !== undefined) {
      steps.push({
        kind: "append-pr-link-closed",
        prStreamId: trigger.prStreamId,
        event: {
          type: "pr.link-closed",
          payload: { v: 1, ref, issueOffset: existingClose.issueOffset },
          ts: trigger.ts,
        },
      });
      continue;
    }
    if (issue.state === "done") {
      steps.push(noopStep(trigger, ref, "already-done"));
      continue;
    }
    if (!mayTransitionToDone(issue.state)) {
      steps.push(noopStep(trigger, ref, "illegal-transition"));
      continue;
    }
    steps.push({
      kind: "append-issue-close",
      ref,
      prStreamId: trigger.prStreamId,
      issueStreamId: ref.stream,
      expectedHead: issue.headOffset,
      event: {
        type: "issue.state-changed",
        payload: {
          v: 2,
          to: "done",
          via: {
            prStream: trigger.prStreamId,
            prMergedOffset: trigger.prMergedOffset,
          },
        },
        ts: trigger.ts,
      },
    });
  }
  return steps;
}

/** Pure, stable, first-ref-wins planner. It performs no reads or appends. */
export function planLinkPropagation(
  trigger: LinkPropagationTrigger,
  prState: MeadowPrState,
  issueStates: IssueLinkSnapshots,
): readonly PropagationStep[] {
  if (trigger.kind === "closed" || prState.closes === undefined || prState.closes.length === 0) {
    return [];
  }
  if (trigger.kind === "opened" && prState.openedAtOffset !== trigger.openedOffset) return [];
  if (
    trigger.kind === "merged" &&
    (prState.status !== "merged" || prState.resolvedAtOffset !== trigger.prMergedOffset)
  ) {
    return [];
  }
  return trigger.kind === "opened"
    ? planOpened(trigger, prState, issueStates)
    : planMerged(trigger, prState, issueStates);
}

export interface LinkDriverPrSnapshot {
  readonly state: MeadowPrState;
  readonly headOffset: Offset;
}

export interface LinkDispatchReceipt {
  readonly offset: Offset;
}

export interface LinkPropagationDriverContext {
  readonly readPr: (prStreamId: string) => Promise<LinkDriverPrSnapshot>;
  readonly readIssue: (issueStreamId: string) => Promise<IssueLinkSnapshot>;
  readonly dispatchFenced: (
    streamId: string,
    event: Event,
    expectedHead: Offset,
  ) => Promise<LinkDispatchReceipt>;
  readonly isFenceRefusal: (error: unknown) => boolean;
  readonly replan?: typeof planLinkPropagation;
  readonly onReplan?: (attempt: number, error: unknown) => void | Promise<void>;
  readonly maxReplans?: number;
}

export interface LinkPropagationDriverReceipt {
  readonly attempts: number;
  readonly appended: number;
  readonly offsets: readonly Offset[];
}

async function readIssueStates(
  context: LinkPropagationDriverContext,
  prState: MeadowPrState,
): Promise<IssueLinkSnapshots> {
  const entries = await Promise.all(
    uniqueEntityRefs(prState.closes ?? []).map(
      async (ref) => [ref.stream, await context.readIssue(ref.stream)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function executeSteps(
  context: LinkPropagationDriverContext,
  prHead: Offset,
  steps: readonly PropagationStep[],
  offsets: Offset[],
): Promise<Offset> {
  let currentPrHead = prHead;
  for (const step of steps) {
    if (step.kind === "append-issue-link") {
      const receipt = await context.dispatchFenced(
        step.issueStreamId,
        step.event,
        step.expectedHead,
      );
      offsets.push(receipt.offset);
      continue;
    }
    if (step.kind === "append-issue-close") {
      const issue = await context.dispatchFenced(step.issueStreamId, step.event, step.expectedHead);
      offsets.push(issue.offset);
      const backlink: PrLinkClosedEvent = {
        type: "pr.link-closed",
        payload: { v: 1, ref: step.ref, issueOffset: issue.offset },
        ts: step.event.ts,
      };
      const pr = await context.dispatchFenced(step.prStreamId, backlink, currentPrHead);
      currentPrHead = pr.offset;
      offsets.push(pr.offset);
      continue;
    }
    const pr = await context.dispatchFenced(step.prStreamId, step.event, currentPrHead);
    currentPrHead = pr.offset;
    offsets.push(pr.offset);
  }
  return currentPrHead;
}

/**
 * Read-plan-fenced-dispatch loop. A fence refusal discards the stale plan and rereads
 * every entity, which makes partial application converge through reduced provenance.
 */
export async function driveLinkPropagation(
  trigger: LinkPropagationTrigger,
  context: LinkPropagationDriverContext,
): Promise<LinkPropagationDriverReceipt> {
  const limit = context.maxReplans ?? 8;
  const offsets: Offset[] = [];
  for (let attempt = 1; attempt <= limit + 1; attempt += 1) {
    const pr = await context.readPr(trigger.prStreamId);
    const issues = await readIssueStates(context, pr.state);
    const steps = (context.replan ?? planLinkPropagation)(trigger, pr.state, issues);
    if (steps.length === 0) return { attempts: attempt, appended: offsets.length, offsets };
    try {
      await executeSteps(context, pr.headOffset, steps, offsets);
      return { attempts: attempt, appended: offsets.length, offsets };
    } catch (error) {
      if (!context.isFenceRefusal(error) || attempt > limit) throw error;
      await context.onReplan?.(attempt, error);
    }
  }
  throw new Error("link propagation replan budget exhausted");
}
