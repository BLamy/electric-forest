import { canonicalJson, isEvent, sha256Hex, stateDigest, type Event } from "@eforest/protocol";
import type {
  SessionManifestEntry,
  SessionRecord,
  SessionRole,
  ValidatedSession,
} from "./manifest.js";

export type SessionReplayFailureCode =
  | "session/unknown-reducer"
  | "session/reducer-role-mismatch"
  | "session/invalid-record"
  | "session/replay-failed"
  | "session/unresolved-link";

export interface SessionReplayFailureContext {
  readonly stream: string;
  readonly offset?: string;
  readonly rule?: 1 | 2 | 3 | 4;
}

export class SessionReplayError extends Error {
  readonly offset: string | undefined;
  readonly rule: 1 | 2 | 3 | 4 | undefined;

  constructor(
    readonly code: SessionReplayFailureCode,
    message: string,
    readonly stream: string,
    context: Omit<SessionReplayFailureContext, "stream"> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "SessionReplayError";
    this.offset = context.offset;
    this.rule = context.rule;
  }
}

export interface SessionStreamResult {
  readonly stream: string;
  readonly role: SessionRole;
  readonly reducer: string;
  readonly head: string;
  /** SHA-256 of the exact canonical JSONL bytes accepted from the dump. */
  readonly dumpDigest: string;
  readonly digest: string;
}

interface ReplayedSessionStream extends SessionStreamResult {
  readonly state: unknown;
  readonly records: readonly SessionRecord[];
}

export interface SessionLinkResult {
  readonly resolved: number;
  readonly unresolved: 0;
}

export interface SessionReplayResult {
  readonly version: 1;
  readonly streams: readonly SessionStreamResult[];
  readonly links: SessionLinkResult;
  readonly digest: string;
}

export interface CompositeDigestInput {
  readonly streams: readonly SessionStreamResult[];
  readonly links: { readonly resolved: number };
}

export interface SessionReducerDefinition {
  readonly id: string;
  readonly initialState: unknown;
  readonly initialStateForStream?: (streamId: string) => unknown;
  readonly reduce: (state: unknown, event: Event) => unknown;
  readonly digest: (state: unknown) => string;
}

/** Adapter boundary for @eforest/reducers.requireReducer. */
export type SessionReducerResolver = (
  reducerId: string,
  streamId: string,
) => SessionReducerDefinition;

const REDUCERS_BY_ROLE: Readonly<Record<SessionRole, readonly string[]>> = Object.freeze({
  issue: Object.freeze(["issue"]),
  branch: Object.freeze(["streamfs"]),
  wiki: Object.freeze(["streamfs"]),
  pr: Object.freeze(["pr"]),
  attachment: Object.freeze(["evidence", "evidence-content"]),
});

function replayError(
  code: Exclude<SessionReplayFailureCode, "session/unresolved-link">,
  message: string,
  stream: string,
  offset?: string,
): never {
  throw new SessionReplayError(code, message, stream, offset === undefined ? {} : { offset });
}

function unresolved(stream: string, offset: string, rule: 1 | 2 | 3 | 4, message: string): never {
  throw new SessionReplayError("session/unresolved-link", message, stream, { offset, rule });
}

function eventWithoutOffset(record: SessionRecord): Event | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const event = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "offset"));
  return isEvent(event) ? event : undefined;
}

function replayMember(
  entry: SessionManifestEntry,
  records: readonly SessionRecord[],
  resolveReducer: SessionReducerResolver,
): ReplayedSessionStream {
  if (!REDUCERS_BY_ROLE[entry.role].includes(entry.reducer)) {
    replayError(
      "session/reducer-role-mismatch",
      `reducer ${entry.reducer} is not valid for role ${entry.role}`,
      entry.stream,
    );
  }

  let reducer;
  try {
    reducer = resolveReducer(entry.reducer, entry.stream);
  } catch (error) {
    replayError(
      "session/unknown-reducer",
      error instanceof Error ? error.message : String(error),
      entry.stream,
    );
  }

  for (const record of records) {
    if (typeof record.offset !== "string" || eventWithoutOffset(record) === undefined) {
      replayError(
        "session/invalid-record",
        "dump record must contain one opaque offset and a valid event envelope",
        entry.stream,
        typeof record.offset === "string" ? record.offset : undefined,
      );
    }
  }

  try {
    const state = records.reduce<unknown>(
      (current, record) => reducer.reduce(current, record),
      reducer.initialStateForStream === undefined
        ? reducer.initialState
        : reducer.initialStateForStream(entry.stream),
    );
    const dumpDigest = sha256Hex(
      new TextEncoder().encode(`${records.map((record) => canonicalJson(record)).join("\n")}\n`),
    );
    const digest = reducer.digest(state);
    return {
      stream: entry.stream,
      role: entry.role,
      reducer: entry.reducer,
      head: entry.head,
      dumpDigest,
      digest,
      state,
      records,
    };
  } catch (error) {
    replayError(
      "session/replay-failed",
      error instanceof Error ? error.message : String(error),
      entry.stream,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface EntityRefValue {
  readonly entity: "issue";
  readonly stream: string;
}

function entityRef(value: unknown): EntityRefValue | undefined {
  const candidate = objectValue(value);
  if (candidate === undefined) return undefined;
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key === "symbol") ||
    !Object.prototype.hasOwnProperty.call(candidate, "entity") ||
    !Object.prototype.hasOwnProperty.call(candidate, "stream") ||
    candidate.entity !== "issue" ||
    typeof candidate.stream !== "string" ||
    candidate.stream.length === 0
  ) {
    return undefined;
  }
  return { entity: "issue", stream: candidate.stream };
}

function findEntityRefs(value: unknown, result: EntityRefValue[], seen: Set<object>): void {
  const ref = entityRef(value);
  if (ref !== undefined) {
    result.push(ref);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) findEntityRefs(item, result, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      findEntityRefs(item, result, seen);
    }
  }
}

function containsEntityRef(value: unknown, target: EntityRefValue): boolean {
  const refs: EntityRefValue[] = [];
  findEntityRefs(value, refs, new Set());
  return refs.some((ref) => ref.entity === target.entity && ref.stream === target.stream);
}

function referringOffsetForEntityRef(
  member: ReplayedSessionStream,
  target: EntityRefValue,
): string {
  return (
    member.records.find((record) => containsEntityRef(record.payload, target))?.offset ??
    member.head
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function memberByStream(
  members: ReadonlyMap<string, ReplayedSessionStream>,
  stream: unknown,
): ReplayedSessionStream | undefined {
  return typeof stream === "string" ? members.get(stream) : undefined;
}

function resolveEntityRefs(
  member: ReplayedSessionStream,
  members: ReadonlyMap<string, ReplayedSessionStream>,
): number {
  const refs: EntityRefValue[] = [];
  findEntityRefs(member.state, refs, new Set());
  const unique = new Map(refs.map((ref) => [`${ref.entity}\u0000${ref.stream}`, ref]));
  for (const ref of unique.values()) {
    const offset = referringOffsetForEntityRef(member, ref);
    const target = members.get(ref.stream);
    if (target === undefined || target.role !== "issue") {
      unresolved(
        member.stream,
        offset,
        1,
        `entity ref ${ref.entity}:${ref.stream} does not resolve to an issue member`,
      );
    }
  }
  return unique.size;
}

interface IssueClosure {
  readonly prStream: string;
  readonly prMergedOffset: string;
}

function issueClosures(state: unknown): readonly IssueClosure[] {
  const candidate = objectValue(state);
  if (candidate === undefined || !Array.isArray(candidate.closedBy)) return [];
  return candidate.closedBy.flatMap((value) => {
    const closure = objectValue(value);
    return closure !== undefined && isString(closure.prStream) && isString(closure.prMergedOffset)
      ? [{ prStream: closure.prStream, prMergedOffset: closure.prMergedOffset }]
      : [];
  });
}

function closureOffset(member: ReplayedSessionStream, closure: IssueClosure): string {
  return (
    member.records.find((record) => {
      if (record.type !== "issue.state-changed") return false;
      const payload = objectValue(record.payload);
      const via = objectValue(payload?.via);
      return via?.prStream === closure.prStream && via.prMergedOffset === closure.prMergedOffset;
    })?.offset ?? member.head
  );
}

function resolveIssueClosures(
  member: ReplayedSessionStream,
  members: ReadonlyMap<string, ReplayedSessionStream>,
): number {
  const closures = issueClosures(member.state);
  for (const closure of closures) {
    const offset = closureOffset(member, closure);
    const target = members.get(closure.prStream);
    const merge = target?.records.find(
      (record) => record.offset === closure.prMergedOffset && record.type === "pr.merged",
    );
    if (target === undefined || target.role !== "pr" || merge === undefined) {
      unresolved(
        member.stream,
        offset,
        2,
        `close provenance ${closure.prStream}@${closure.prMergedOffset} is not a PR merge`,
      );
    }
  }
  return closures.length;
}

interface PrBranchTriple {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly forkOffset: string;
  readonly openedAtOffset: string;
}

function prBranchTriple(state: unknown): PrBranchTriple | undefined {
  const candidate = objectValue(state);
  return candidate !== undefined &&
    isString(candidate.sourceBranch) &&
    isString(candidate.targetBranch) &&
    isString(candidate.forkOffset) &&
    isString(candidate.openedAtOffset)
    ? {
        sourceBranch: candidate.sourceBranch,
        targetBranch: candidate.targetBranch,
        forkOffset: candidate.forkOffset,
        openedAtOffset: candidate.openedAtOffset,
      }
    : undefined;
}

function resolvePrBranches(
  member: ReplayedSessionStream,
  members: ReadonlyMap<string, ReplayedSessionStream>,
): number {
  if (member.role !== "pr") return 0;
  const triple = prBranchTriple(member.state);
  if (triple === undefined) {
    unresolved(member.stream, member.head, 3, "PR state has no complete branch provenance");
  }
  const source = memberByStream(members, triple.sourceBranch);
  const target = memberByStream(members, triple.targetBranch);
  const hasFork = target?.records.some((record) => record.offset === triple.forkOffset) === true;
  if (
    source === undefined ||
    source.role !== "branch" ||
    target === undefined ||
    target.role !== "branch" ||
    !hasFork
  ) {
    unresolved(
      member.stream,
      triple.openedAtOffset,
      3,
      `branch provenance ${triple.sourceBranch}, ${triple.targetBranch}@${triple.forkOffset} is unresolved`,
    );
  }
  return 1;
}

interface ContentAttachmentValue {
  readonly contentStream: string;
  readonly sha256: string;
  readonly attachedAtOffset: string;
}

function contentAttachments(state: unknown): readonly ContentAttachmentValue[] {
  const candidate = objectValue(state);
  if (candidate === undefined || !Array.isArray(candidate.attachments)) return [];
  return candidate.attachments.flatMap((value) => {
    const attachment = objectValue(value);
    return attachment !== undefined &&
      attachment.type === "content" &&
      isString(attachment.contentStream) &&
      isString(attachment.sha256) &&
      isString(attachment.attachedAtOffset)
      ? [
          {
            contentStream: attachment.contentStream,
            sha256: attachment.sha256,
            attachedAtOffset: attachment.attachedAtOffset,
          },
        ]
      : [];
  });
}

function resolveAttachments(
  member: ReplayedSessionStream,
  members: ReadonlyMap<string, ReplayedSessionStream>,
): number {
  const attachments = contentAttachments(member.state);
  for (const attachment of attachments) {
    const content = members.get(attachment.contentStream);
    const contentState = objectValue(content?.state);
    if (
      content === undefined ||
      content.role !== "attachment" ||
      content.reducer !== "evidence-content" ||
      contentState?.sealed !== true ||
      contentState.sha256 !== attachment.sha256
    ) {
      unresolved(
        member.stream,
        attachment.attachedAtOffset,
        4,
        `attachment ${attachment.contentStream} does not resolve to sealed content with sha256 ${attachment.sha256}`,
      );
    }
  }
  return attachments.length;
}

function resolveLinks(members: readonly ReplayedSessionStream[]): number {
  const byStream = new Map(members.map((member) => [member.stream, member]));
  let resolved = 0;
  for (const member of members) {
    resolved += resolveEntityRefs(member, byStream);
    resolved += resolveIssueClosures(member, byStream);
    resolved += resolvePrBranches(member, byStream);
    resolved += resolveAttachments(member, byStream);
  }
  return resolved;
}

/** Frozen SHA-256 over canonical, stream-id-sorted replay results. */
export function compositeDigest(results: CompositeDigestInput): string {
  return stateDigest({
    version: 1,
    streams: results.streams
      .map(({ stream, role, reducer, head, dumpDigest, digest }) => ({
        stream,
        role,
        reducer,
        head,
        dumpDigest,
        digest,
      }))
      .sort((left, right) =>
        left.stream < right.stream ? -1 : left.stream > right.stream ? 1 : 0,
      ),
    links: { resolved: results.links.resolved },
  });
}

/** Replay a fully inventory- and head-validated session without I/O. */
export function replaySession(
  session: ValidatedSession,
  resolveReducer: SessionReducerResolver,
): SessionReplayResult {
  const members = session.manifest.streams.map((entry) =>
    replayMember(entry, session.dumps.get(entry.stream)!, resolveReducer),
  );
  const resolved = resolveLinks(members);
  const streams: readonly SessionStreamResult[] = members.map(
    ({ stream, role, reducer, head, dumpDigest, digest }) => ({
      stream,
      role,
      reducer,
      head,
      dumpDigest,
      digest,
    }),
  );
  const links = { resolved, unresolved: 0 as const };
  return {
    version: 1,
    streams,
    links,
    digest: compositeDigest({ streams, links }),
  };
}
