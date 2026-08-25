import { stateDigest, type Event } from "@eforest/protocol";
import { isIssueString } from "./issueReducer.js";

export const LABEL_EVENT_VERSION = 1 as const;
export type LabelEventType = "label.created" | "label.renamed" | "label.recolored";

export interface RepoLabel {
  readonly name: string;
  readonly color: string;
}

export interface LabelState {
  readonly v: typeof LABEL_EVENT_VERSION;
  readonly labels: Readonly<Record<string, RepoLabel>>;
}

export class LabelSchemaError extends TypeError {
  constructor(readonly reason = "label/schema-violation") {
    super(reason);
    this.name = "LabelSchemaError";
  }
}

export class LabelUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "LabelUnknownActionError";
  }
}

export class LabelRefusalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "LabelRefusalError";
  }
}

export const labelInitialState: LabelState = Object.freeze({ v: 1, labels: Object.freeze({}) });

export function repoLabelsStreamId(org: string, repo: string): string {
  return `repo-labels:${org}/${repo}`;
}

export function isRepoLabelsStreamId(streamId: string): boolean {
  return /^repo-labels:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*$/.test(streamId);
}

export function repoIdentityFromLabelStream(
  streamId: string,
): { readonly org: string; readonly repo: string } | undefined {
  const match = /^repo-labels:([^/]+)\/([^/]+)$/.exec(streamId);
  return match === null ? undefined : { org: match[1]!, repo: match[2]! };
}

export function isLabelActionType(value: string): value is LabelEventType {
  return value === "label.created" || value === "label.renamed" || value === "label.recolored";
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function labelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]+$/.test(value);
}

export function isLabelEvent(value: Event): value is Event & { readonly type: LabelEventType } {
  if (!isLabelActionType(value.type)) return false;
  const payload = value.payload;
  const fields =
    value.type === "label.created"
      ? ["v", "labelId", "name", "color"]
      : value.type === "label.renamed"
        ? ["v", "labelId", "name"]
        : ["v", "labelId", "color"];
  if (!exactObject(payload, fields) || payload.v !== LABEL_EVENT_VERSION) return false;
  if (!labelId(payload.labelId)) return false;
  if (value.type !== "label.recolored" && (!isIssueString(payload.name) || payload.name === ""))
    return false;
  if (value.type !== "label.renamed" && (!isIssueString(payload.color) || payload.color === ""))
    return false;
  return true;
}

export function validateLabelEvent(state: LabelState, event: Event): void {
  if (!isLabelEvent(event)) throw new LabelSchemaError();
  const payload = event.payload as Record<string, string>;
  const existing = state.labels[payload.labelId!];
  if (event.type === "label.created") {
    if (existing !== undefined) throw new LabelRefusalError("label/duplicate-id");
    if (Object.values(state.labels).some((label) => label.name === payload.name))
      throw new LabelRefusalError("label/duplicate-name");
    return;
  }
  if (existing === undefined) throw new LabelRefusalError("label/unknown-id");
  if (
    event.type === "label.renamed" &&
    Object.entries(state.labels).some(
      ([id, label]) => id !== payload.labelId && label.name === payload.name,
    )
  )
    throw new LabelRefusalError("label/duplicate-name");
}

export function labelReducer(state: LabelState, event: Event): LabelState {
  validateLabelEvent(state, event);
  const payload = event.payload as Record<string, string>;
  if (event.type === "label.created") {
    return {
      v: 1,
      labels: {
        ...state.labels,
        [payload.labelId!]: { name: payload.name!, color: payload.color! },
      },
    };
  }
  const existing = state.labels[payload.labelId!]!;
  return {
    v: 1,
    labels: {
      ...state.labels,
      [payload.labelId!]:
        event.type === "label.renamed"
          ? { ...existing, name: payload.name! }
          : { ...existing, color: payload.color! },
    },
  };
}

export function reduceLabelApplicationEvent(state: unknown, event: Event): LabelState {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : event.payload;
  return labelReducer(state as LabelState, { ...event, payload });
}

export const labelReducerDefinition = Object.freeze({
  id: "repo-labels",
  version: LABEL_EVENT_VERSION,
  initialState: labelInitialState,
  reduce: reduceLabelApplicationEvent,
  digest: stateDigest,
  matchesStream: isRepoLabelsStreamId,
});
