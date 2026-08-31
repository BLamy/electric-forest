import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { isPathSafeId, parseEvidenceStreamId } from "@eforest/evidence";
import { isIssueActionType, isIssueStreamId, isIssueString, issueStreamId } from "@eforest/issues";
import { TASK_EVENT_FAMILY, TASK_EVENT_VERSION } from "./version.js";

export const TASK_ACTION_TYPES = [
  "task.started",
  "task.claimed",
  "task.refuted",
  "task.rework-started",
  "task.verified",
  "task.spec-revised",
] as const;
export type TaskActionType = (typeof TASK_ACTION_TYPES)[number];

export const TASK_ROLES = ["builder", "critic"] as const;
export type TaskRole = (typeof TASK_ROLES)[number];

export const TASK_MAX_ATTACHMENT_REFS = 64;
export const TASK_MAX_FINDINGS = 64;
export const TASK_ACTOR_MAX_CODE_UNITS = 256;
export const TASK_STREAM_REF_MAX_CODE_UNITS = 512;
/** A spec revision carries the whole canonical readme; anything larger is refused. */
export const TASK_SPEC_MAX_CODE_UNITS = 1024 * 1024;
/** The base of the first spec revision: no prior `task.spec-revised` record exists. */
export const TASK_SPEC_NO_BASE = OFFSET_BEFORE_FIRST;
/** `epic-<n>[-slug]/E<n>-T<nn>[a-z]?-<slug>`: a task folder path relative to `.eforest/tasks/`. */
export const TASK_FOLDER_PATH_PATTERN =
  /^epic-(0|[1-9][0-9]*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\/E(0|[1-9][0-9]*)-T[0-9]{2}[a-z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isTaskFolderPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const match = TASK_FOLDER_PATH_PATTERN.exec(value);
  return match !== null && match[1] === match[2];
}

/** `agent-run:<org>/<run-id>` — the stream an agent run writes its trace to (E6-T07). */
export const AGENT_RUN_STREAM_PATTERN = /^agent-run:[a-z0-9](?:-?[a-z0-9])*\/[A-Za-z0-9._~-]+$/;
/** A task-branch stream is a StreamFS meta stream: `fs:<org>/<repo>:<branch>:meta`. */
export const TASK_BRANCH_STREAM_PATTERN =
  /^fs:([a-z0-9](?:-?[a-z0-9])*)\/([a-z0-9](?:-?[a-z0-9])*):[a-z0-9][a-z0-9-]{0,63}:meta$/;
/** Stable finding fingerprints are slugs: 3–64 chars of `a-z 0-9 -`, no leading/trailing dash. */
export const TASK_FINGERPRINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface TaskActorRef {
  readonly actor: string;
  readonly role: TaskRole;
  readonly run: string;
}
export interface TaskBranchRef {
  readonly stream: string;
  readonly head: Offset;
}
export interface TaskEvidenceRef {
  readonly stream: string;
  readonly attachmentIds: readonly string[];
}
export interface TaskRecordRef {
  readonly stream: string;
  readonly offset: Offset;
}
export type TaskFindingCitation =
  | { readonly stream: string; readonly attachmentId: string }
  | { readonly stream: string; readonly offset: Offset };
export interface TaskFinding {
  readonly fingerprint: string;
  readonly summary: string;
  readonly citation: TaskFindingCitation;
}

export interface TaskStartedEvent extends Event {
  readonly type: "task.started";
  readonly payload: { readonly v: typeof TASK_EVENT_VERSION; readonly by: TaskActorRef };
}
export interface TaskClaimedEvent extends Event {
  readonly type: "task.claimed";
  readonly payload: {
    readonly v: typeof TASK_EVENT_VERSION;
    readonly by: TaskActorRef;
    readonly branch: TaskBranchRef;
    readonly evidence: TaskEvidenceRef;
    readonly summary: string;
  };
}
export interface TaskRefutedEvent extends Event {
  readonly type: "task.refuted";
  readonly payload: {
    readonly v: typeof TASK_EVENT_VERSION;
    readonly by: TaskActorRef;
    readonly claim: TaskRecordRef;
    readonly branch: TaskBranchRef;
    readonly evidence: TaskEvidenceRef;
    readonly findings: readonly TaskFinding[];
  };
}
export interface TaskReworkStartedEvent extends Event {
  readonly type: "task.rework-started";
  readonly payload: {
    readonly v: typeof TASK_EVENT_VERSION;
    readonly by: TaskActorRef;
    readonly refutation: TaskRecordRef;
  };
}
export interface TaskVerifiedEvent extends Event {
  readonly type: "task.verified";
  readonly payload: {
    readonly v: typeof TASK_EVENT_VERSION;
    readonly by: TaskActorRef;
    readonly claim: TaskRecordRef;
    readonly branch: TaskBranchRef;
    readonly evidence: TaskEvidenceRef;
    readonly summary: string;
  };
}
/**
 * E6-T05: one accepted text revision of the task readme. `readme` is the E6-T02 canonical
 * render (frontmatter in canonical order, sections verbatim) with the frontmatter `status`
 * set to the status the revision was made under — text, never authority. `base` fences
 * the revision: the offset of the `task.spec-revised` it was made from, or `-1` when none
 * exists yet. `sha256` is over the UTF-8 bytes of `readme`.
 */
export interface TaskSpecRevisedEvent extends Event {
  readonly type: "task.spec-revised";
  readonly payload: {
    readonly v: typeof TASK_EVENT_VERSION;
    readonly base: Offset | typeof TASK_SPEC_NO_BASE;
    /** `<epic dir>/<id>-<slug>` under `.eforest/tasks/`: the folder this readme lives in. */
    readonly folder: string;
    /** Provenance: the branch write this revision ingested (stream + fs offset). */
    readonly origin: TaskBranchRef;
    readonly readme: string;
    readonly sha256: string;
  };
}
export type TaskEvent =
  | TaskSpecRevisedEvent
  | TaskStartedEvent
  | TaskClaimedEvent
  | TaskRefutedEvent
  | TaskReworkStartedEvent
  | TaskVerifiedEvent;

export function isTaskActionType(value: string): value is TaskActionType {
  return (TASK_ACTION_TYPES as readonly string[]).includes(value);
}

/** Any event type the task stream accepts: the E5 issue family plus the loop family. */
export function isTaskStreamActionType(value: string): boolean {
  return isIssueActionType(value) || isTaskActionType(value);
}

export function isTaskEventFamily(value: string): boolean {
  return value.startsWith(TASK_EVENT_FAMILY);
}

/** A task is an issue with evidence: the task stream IS the issue stream. */
export function taskStreamId(org: string, repo: string, taskId: string): string {
  return issueStreamId(org, repo, taskId);
}

export function isTaskStreamId(streamId: string): boolean {
  return isIssueStreamId(streamId);
}

export interface TaskStreamIdentity {
  readonly org: string;
  readonly repo: string;
  readonly taskId: string;
}

export function parseTaskStreamId(streamId: string): TaskStreamIdentity | undefined {
  if (!isIssueStreamId(streamId)) return undefined;
  const match = /^issue:([^/]+)\/([^/]+)\/([^/]+)$/.exec(streamId);
  if (match === null) return undefined;
  return { org: match[1]!, repo: match[2]!, taskId: match[3]! };
}

/** The E5-T10 attachment list a task's evidence lives on — no second attachment schema. */
export function taskEvidenceStreamId(streamId: string): string | undefined {
  const identity = parseTaskStreamId(streamId);
  return identity === undefined
    ? undefined
    : `evidence:${identity.org}/${identity.repo}/issue/${identity.taskId}`;
}

function exactObject(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedText(value: unknown, max: number): value is string {
  return isIssueString(value) && value.length > 0 && value.length <= max;
}

function eventOffsetValue(value: unknown): value is Offset {
  return typeof value === "string" && value !== OFFSET_BEFORE_FIRST && isWellFormedOffset(value);
}

export function isAgentRunStreamId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TASK_STREAM_REF_MAX_CODE_UNITS &&
    AGENT_RUN_STREAM_PATTERN.test(value)
  );
}

export function isTaskBranchStreamId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TASK_STREAM_REF_MAX_CODE_UNITS &&
    TASK_BRANCH_STREAM_PATTERN.test(value)
  );
}

export function isTaskActorRef(value: unknown): value is TaskActorRef {
  return (
    exactObject(value, ["actor", "role", "run"]) &&
    boundedText(value.actor, TASK_ACTOR_MAX_CODE_UNITS) &&
    (TASK_ROLES as readonly unknown[]).includes(value.role) &&
    isAgentRunStreamId(value.run)
  );
}

export function isTaskBranchRef(value: unknown): value is TaskBranchRef {
  return (
    exactObject(value, ["stream", "head"]) &&
    isTaskBranchStreamId(value.stream) &&
    eventOffsetValue(value.head)
  );
}

export function isTaskEvidenceRef(value: unknown): value is TaskEvidenceRef {
  if (!exactObject(value, ["stream", "attachmentIds"])) return false;
  if (typeof value.stream !== "string" || parseEvidenceStreamId(value.stream) === undefined)
    return false;
  const ids = value.attachmentIds;
  return (
    Array.isArray(ids) &&
    ids.length <= TASK_MAX_ATTACHMENT_REFS &&
    ids.every((id) => isPathSafeId(id)) &&
    new Set(ids).size === ids.length
  );
}

export function isTaskRecordRef(value: unknown): value is TaskRecordRef {
  return (
    exactObject(value, ["stream", "offset"]) &&
    typeof value.stream === "string" &&
    isIssueStreamId(value.stream) &&
    eventOffsetValue(value.offset)
  );
}

export function isTaskFindingCitation(value: unknown): value is TaskFindingCitation {
  if (exactObject(value, ["stream", "attachmentId"])) {
    return (
      typeof value.stream === "string" &&
      parseEvidenceStreamId(value.stream) !== undefined &&
      isPathSafeId(value.attachmentId)
    );
  }
  if (exactObject(value, ["stream", "offset"])) {
    return (
      boundedText(value.stream, TASK_STREAM_REF_MAX_CODE_UNITS) && eventOffsetValue(value.offset)
    );
  }
  return false;
}

export function isTaskFinding(value: unknown): value is TaskFinding {
  return (
    exactObject(value, ["fingerprint", "summary", "citation"]) &&
    typeof value.fingerprint === "string" &&
    TASK_FINGERPRINT_PATTERN.test(value.fingerprint) &&
    boundedText(value.summary, 1024 * 1024) &&
    isTaskFindingCitation(value.citation)
  );
}

function isFindingList(value: unknown): value is readonly TaskFinding[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= TASK_MAX_FINDINGS &&
    value.every(isTaskFinding) &&
    new Set(value.map((finding) => finding.fingerprint)).size === value.length
  );
}

/** Exact-shape guard for one loop event; unknown fields, versions, and types are refused. */
export function isTaskEventShape(event: Event): event is TaskEvent {
  if (!isTaskActionType(event.type)) return false;
  const p = event.payload;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const payload = p as Record<string, unknown>;
  if (payload.v !== TASK_EVENT_VERSION) return false;
  if (event.type === "task.spec-revised") {
    return (
      exactObject(payload, ["v", "base", "folder", "origin", "readme", "sha256"]) &&
      (payload.base === TASK_SPEC_NO_BASE || eventOffsetValue(payload.base)) &&
      isTaskFolderPath(payload.folder) &&
      isTaskBranchRef(payload.origin) &&
      boundedText(payload.readme, TASK_SPEC_MAX_CODE_UNITS) &&
      typeof payload.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(payload.sha256)
    );
  }
  if (!isTaskActorRef(payload.by)) return false;
  switch (event.type) {
    case "task.started":
      return exactObject(payload, ["v", "by"]);
    case "task.claimed":
      return (
        exactObject(payload, ["v", "by", "branch", "evidence", "summary"]) &&
        isTaskBranchRef(payload.branch) &&
        isTaskEvidenceRef(payload.evidence) &&
        (payload.evidence as TaskEvidenceRef).attachmentIds.length >= 1 &&
        boundedText(payload.summary, 1024 * 1024)
      );
    case "task.refuted":
      return (
        exactObject(payload, ["v", "by", "claim", "branch", "evidence", "findings"]) &&
        isTaskRecordRef(payload.claim) &&
        isTaskBranchRef(payload.branch) &&
        isTaskEvidenceRef(payload.evidence) &&
        isFindingList(payload.findings)
      );
    case "task.rework-started":
      return exactObject(payload, ["v", "by", "refutation"]) && isTaskRecordRef(payload.refutation);
    case "task.verified":
      return (
        exactObject(payload, ["v", "by", "claim", "branch", "evidence", "summary"]) &&
        isTaskRecordRef(payload.claim) &&
        isTaskBranchRef(payload.branch) &&
        isTaskEvidenceRef(payload.evidence) &&
        boundedText(payload.summary, 1024 * 1024)
      );
  }
}

export function taskEventOffset(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return eventOffsetValue(offset) ? offset : undefined;
}
