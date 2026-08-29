import { createHash } from "node:crypto";
import {
  attachmentInitialState,
  attachmentInitialStateForStream,
  attachmentReducer,
  contentInitialStateForStream,
  contentReducer,
  evidenceContentStreamId,
  evidenceStreamId,
  EvidenceRefusalError,
  EvidenceSchemaError,
  EvidenceUnknownActionError,
  isEvidenceActionType,
  isEvidenceContentActionType,
  isEvidenceContentStreamId,
  isEvidenceEntityType,
  isEvidenceStreamId,
  parseEvidenceStreamIdentity,
  type EvidenceResolvedStream,
} from "@eforest/evidence";
import {
  isLabelActionType,
  isRepoLabelsStreamId,
  labelInitialState,
  labelReducer,
  repoLabelsStreamId,
  LabelRefusalError,
  LabelSchemaError,
  LabelUnknownActionError,
} from "@eforest/issues";
import {
  checkpoint as applicationCheckpoint,
  isDurableConflict,
  isDurableExistsConflict,
  isDurableNotFound,
  type StreamBatch,
  type StreamCheckpoint,
  type StreamRecord,
} from "@eforest/client";
import { emptyView } from "@eforest/identity";
import {
  isPrActionType,
  isPrEvent,
  isPrStreamId,
  prInitialStateForStream,
  prReducer,
  PrRefusalError,
  PrSchemaError,
  PrUnknownActionError,
} from "@eforest/pr";
import {
  canonicalJson,
  compareOffsets,
  isEvent,
  OFFSET_BEFORE_FIRST,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { fileViewStreamId, requireReducer, type ReducerDefinition } from "@eforest/reducers";
import {
  isFsFileContentEvent,
  isFsEvent,
  isFsBranchForkEvent,
  isFsBranchGenesisEvent,
  isBranchName,
  isValidFsPath,
  applyPatch,
  patchResultSize,
  resolveBranchLog,
  type BranchDump,
  type PatchOps,
} from "@eforest/streamfs";
import { UnauthorizedError } from "./auth.js";
import {
  GrantTargetCommitError,
  GrantTargetUnavailableError,
  TokenRevokedError,
  type AuthorizationContext,
  type AuthorizationVerifier,
} from "./auth/grants.js";
import {
  classifyDispatchTarget,
  decideStreamAuthorization,
  isAuthzName,
  repoTargetFromPath,
  type AuthzDecision,
  type AuthzRefused,
  type AuthzTarget,
} from "./authz/decide.js";
import { AuthzViewUnavailableError, NamespaceViewReader } from "./authz/view.js";
import type { NamespaceView } from "./ns/reducer.js";
import {
  StreamForkExistsError,
  StreamForkValidationError,
  type StreamAdapter,
} from "./official.js";
import {
  NamespaceContentionError,
  NamespaceDispatcher,
  NamespaceRefusalError,
  NamespaceSchemaError,
} from "./ns/dispatch.js";
import { resolvePath } from "./ns/resolve.js";
import {
  registryApplicationProjectionResponse,
  registryLongPollResponse,
  registrySnapshotResponse,
  registrySseResponse,
  type RegistryScope,
} from "./registry/doors.js";
import type { RegistryProjector } from "./registry/projector.js";
import {
  isWellFormedOffset,
  nextAllocatedOffset,
  offsetForOrdinal,
} from "@eforest/protocol/offset-allocation";
import type { AuthorizationView } from "@eforest/identity";
import {
  WriterLaneContentionError,
  WriterLaneCorruptionError,
  WriterLaneDispatcher,
  WriterLaneRefusalError,
  reduceWriterLanes,
  type WriterScopedEvent,
} from "./writer-lanes.js";
import { classifyPlatformRoute } from "./route-topology.js";
import {
  DEFAULT_PLATFORM_RATE_LIMIT,
  FixedWindowRateLimiter,
  RateLimitExceededError,
  rateLimitResponse,
  type RateLimitOperation,
} from "./rate-limit.js";
import { decideTenantAccess } from "./tenant-isolation.js";
import {
  nativeBranchOffsets,
  readExistingNativeBranchRecords,
  RepositoryHomeCorruptError,
  RepositoryHomeNativeForkError,
  RepositoryHomeStore,
  type RepositoryHomeRegion,
} from "./repo-home.js";
import {
  BOARD_REDUCER,
  isIssueActionType,
  isIssueStreamId,
  issueStreamId,
  repoIssueBoardStreamId,
} from "@eforest/reducers";
import { issueInitialStateFor, issueReducer } from "./issues/reducer.js";
import {
  isIssueEnvelopeSourceValid,
  parseJsonWithIssueEnvelopeSource,
  type IssueEnvelopeSource,
} from "./issues/envelope.js";
import {
  IssueRefusalError,
  IssueSchemaError,
  IssueUnknownActionError,
} from "./issues/validators.js";
import { ActionValidatorRegistry, registerApplicationValidators } from "./validation.js";
import {
  IssueBoardMaterializer,
  type IssueBoardMaterializerOptions,
} from "./issues/board-store.js";

export interface PlatformGatewayOptions {
  readonly verifier: AuthorizationVerifier;
  readonly streams: StreamAdapter;
  readonly namespaces?: NamespaceDispatcher;
  /** Decision seam used by conformance sensitivity; production defaults to the pure door. */
  readonly decideAuthorization?: typeof decideStreamAuthorization;
  /** E2-T08: the registry projector to nudge after accepted namespace dispatches. */
  readonly registry?: RegistryProjector;
  /** Shared with the web app in production; tests inject a deterministic clock and limit. */
  readonly rateLimiter?: FixedWindowRateLimiter;
  /** Deterministic test seam; production always constructs the isolated replay reader. */
  readonly namespaceViewReader?: Pick<NamespaceViewReader, "viewFor">;
  readonly repositoryHomes?: RepositoryHomeStore;
  readonly actionValidators?: ActionValidatorRegistry;
  readonly issueBoards?: IssueBoardMaterializer;
  readonly boardCacheDir?: IssueBoardMaterializerOptions["cacheDir"];
}

type ErrorCode = "unauthorized" | "invalid_request" | "dispatch_failed";

const MAX_FOLLOW_WAIT_MS = 20_000;
const DEFAULT_FOLLOW_WAIT_MS = 10_000;

class ApplicationProjectionError extends Error {
  readonly offset: string;

  constructor(offset: string, message: string) {
    super(message);
    this.name = "ApplicationProjectionError";
    this.offset = offset;
  }
}

class BranchForkRefusalError extends GrantTargetUnavailableError {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super();
    this.message = message;
    this.name = "BranchForkRefusalError";
  }
}

class FsStaleBaseError extends Error {
  constructor(
    readonly conflict: {
      readonly path: string;
      readonly expectedBase: string;
      readonly actualBase: string;
    },
  ) {
    super("stale-base");
    this.name = "FsStaleBaseError";
  }
}

function moveBasePaths(values: Map<string, string>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, base] of [...values.entries()]) {
    if (path === from) {
      values.delete(path);
      values.set(to, base);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.set(`${to}${path.slice(from.length)}`, base);
    }
  }
}

function validateFsBase(records: readonly unknown[], event: Event): void {
  if (event.type === "fs.branch.genesis") {
    if (records.length > 0) {
      throw new BranchForkRefusalError("fs/branch-exists", "branch already exists");
    }
    return;
  }
  if (event.type !== "fs.file.write" && event.type !== "fs.file.patch") return;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.path !== "string" || typeof payload.base !== "string") return;
  const bases = new Map<string, string>();
  for (const [index, candidate] of records.entries()) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as {
      readonly type?: unknown;
      readonly payload?: unknown;
      readonly offset?: unknown;
    };
    if (
      record.payload === null ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    ) {
      continue;
    }
    const recordPayload = record.payload as Record<string, unknown>;
    if (record.type === "fs.rename") {
      const from = recordPayload.from;
      const to = recordPayload.to;
      if (typeof from === "string" && typeof to === "string") moveBasePaths(bases, from, to);
      continue;
    }
    const path = recordPayload.path;
    if (typeof path !== "string") continue;
    const offset = typeof record.offset === "string" ? record.offset : offsetForOrdinal(index);
    if (record.type === "fs.file.create") {
      if (!bases.has(path)) bases.set(path, "BASE_NONE");
    } else if (record.type === "fs.file.write" || record.type === "fs.file.patch") {
      bases.set(path, offset);
    } else if (record.type === "fs.file.delete") {
      bases.delete(path);
    }
  }
  const expectedBase = bases.get(payload.path) ?? "BASE_NONE";
  if (payload.base !== expectedBase) {
    throw new FsStaleBaseError({
      path: payload.path,
      expectedBase,
      actualBase: payload.base,
    });
  }
}

function fsContentStreams(records: readonly unknown[]): Map<string, string> {
  const streams = new Map<string, string>();
  for (const candidate of records) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as { readonly type?: unknown; readonly payload?: unknown };
    if (
      record.payload === null ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    ) {
      continue;
    }
    const payload = record.payload as Record<string, unknown>;
    if (record.type === "fs.rename") {
      if (typeof payload.from === "string" && typeof payload.to === "string") {
        moveFileMap(streams, payload.from, payload.to);
      }
      continue;
    }
    if (typeof payload.path !== "string") continue;
    if (record.type === "fs.file.create" && typeof payload.contentStreamId === "string") {
      streams.set(payload.path, payload.contentStreamId);
    } else if (record.type === "fs.file.delete") {
      streams.delete(payload.path);
    }
  }
  return streams;
}

function fullWriteContentStream(
  records: readonly unknown[],
  write: Event,
  contentEvent: Event,
): string {
  if (write.type !== "fs.file.write" || !isFsFileContentEvent(contentEvent)) {
    throw new TypeError("invalid_full_write_content_event");
  }
  const payload = write.payload as Record<string, unknown>;
  const path = payload.path;
  if (typeof path !== "string") throw new TypeError("invalid_full_write_path");
  const contentStreamId = fsContentStreams(records).get(path);
  if (
    contentStreamId === undefined ||
    contentEvent.payload.contentStreamId !== contentStreamId
  ) {
    throw new TypeError("full_write_content_stream_mismatch");
  }
  const encoded = contentEvent.payload.contentBase64;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new TypeError("full_write_content_not_canonical_base64");
  }
  if (
    payload.contentSha256 !== createHash("sha256").update(bytes).digest("hex") ||
    payload.size !== bytes.byteLength
  ) {
    throw new TypeError("full_write_content_integrity_mismatch");
  }
  return contentStreamId;
}

async function stageFullWriteContent(
  streams: StreamAdapter,
  metadataRecords: readonly unknown[],
  write: Event,
  contentEvent: Event,
  operationId?: string,
): Promise<void> {
  const contentStreamId = fullWriteContentStream(metadataRecords, write, contentEvent);
  try {
    await streams.create(contentStreamId);
  } catch (error) {
    if (!isDurableExistsConflict(error)) throw error;
  }
  let lastLength = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const records = await streams.read(contentStreamId);
    const applicationOffset = offsetForOrdinal(records.length);
    try {
      await streams.append(contentStreamId, contentEvent, {
        sequence: applicationOffset,
        applicationOffset,
        ...(operationId === undefined
          ? {}
          : { idempotencyKey: `${operationId}:fs-file-content` }),
      });
      return;
    } catch (error) {
      if (!isDurableConflict(error)) throw error;
      if (records.length <= lastLength) throw new WriterLaneContentionError();
      lastLength = records.length;
    }
  }
  throw new WriterLaneContentionError();
}

function issueEventWithoutServerMetadata(value: unknown): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IssueSchemaError();
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.ts !== "number") {
    throw new IssueSchemaError();
  }
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    throw new IssueSchemaError();
  }
  const payload = Object.fromEntries(
    Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { type: record.type, payload, ts: record.ts };
}

async function validateIssueDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
  issueBoards: IssueBoardMaterializer,
  issueSource?: IssueEnvelopeSource,
): Promise<Offset | undefined> {
  const issueRecords = records.map(issueEventWithoutServerMetadata);
  const issueId = streamId.slice(streamId.lastIndexOf("/") + 1);
  const state = issueRecords.reduce(issueReducer, issueInitialStateFor(issueId));
  const action = issueEventWithoutServerMetadata(event);
  await actionValidators.validate(action, {
    streamId,
    state,
    headOffset:
      issueRecords.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(issueRecords.length - 1),
    nextOffset: offsetForOrdinal(issueRecords.length),
    records: issueRecords,
    ...(issueSource === undefined ? {} : { issueSource }),
  });
  const identity = /^issue:([^/]+)\/([^/]+)\/[^/]+$/.exec(streamId);
  if (identity === null) throw new IssueSchemaError();
  if (action.type === "issue.labeled" || action.type === "issue.unlabeled") {
    const labels = await issueBoards.labelsForRepo(identity[1]!, identity[2]!);
    const labelId = (action.payload as { readonly label: string }).label;
    if (!Object.prototype.hasOwnProperty.call(labels.labels, labelId))
      throw new IssueRefusalError("issue/unknown-label");
  }
  if (action.type === "issue.opened") {
    return issueBoards.discoverIssue(
      identity[1]!,
      identity[2]!,
      streamId,
      offsetForOrdinal(issueRecords.length),
      action.ts,
    );
  } else {
    try {
      await issueBoards.assertIssueDeclared(
        identity[1]!,
        identity[2]!,
        streamId,
        offsetForOrdinal(0),
      );
    } catch (error) {
      throw new IssueRefusalError(
        error instanceof Error ? error.message : "repo-issues/migration-required",
      );
    }
  }
  return undefined;
}

function labelEventWithoutServerMetadata(value: unknown): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new LabelSchemaError();
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.ts !== "number" ||
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  )
    throw new LabelSchemaError();
  return {
    type: record.type,
    payload: Object.fromEntries(
      Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    ts: record.ts,
  };
}

function validateLabelDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
): Promise<void> {
  if (!isRepoLabelsStreamId(streamId)) throw new LabelUnknownActionError();
  const labelRecords = records.map(labelEventWithoutServerMetadata);
  const state = labelRecords.reduce(labelReducer, labelInitialState);
  return actionValidators.validate(labelEventWithoutServerMetadata(event), {
    streamId,
    state,
    headOffset:
      labelRecords.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(labelRecords.length - 1),
    nextOffset: offsetForOrdinal(labelRecords.length),
    records: labelRecords,
  });
}

function prEventWithoutServerMetadata(value: unknown, fallbackOffset: Offset): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PrSchemaError();
  }
  const record = value as Record<string, unknown>;
  const base = { type: record.type, payload: record.payload, ts: record.ts };
  if (!isEvent(base)) throw new PrSchemaError();
  if (base.payload === null || typeof base.payload !== "object" || Array.isArray(base.payload)) {
    throw new PrSchemaError();
  }
  const rawOffset = record.offset;
  if (
    rawOffset !== undefined &&
    (typeof rawOffset !== "string" ||
      rawOffset === OFFSET_BEFORE_FIRST ||
      !isWellFormedOffset(rawOffset))
  ) {
    throw new PrSchemaError();
  }
  const payload = Object.fromEntries(
    Object.entries(base.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  const event = {
    ...base,
    payload,
    offset: (rawOffset ?? fallbackOffset) as Offset,
  } as Event;
  if (!isPrEvent(event)) throw new PrSchemaError();
  return event;
}

async function validatePrDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
  streams: StreamAdapter,
): Promise<void> {
  const prRecords = records.map((record, index) =>
    prEventWithoutServerMetadata(record, offsetForOrdinal(index)),
  );
  const state = prRecords.reduce(prReducer, prInitialStateForStream(streamId));
  const nextOffset = offsetForOrdinal(prRecords.length);
  const action = prEventWithoutServerMetadata(event, nextOffset);
  await actionValidators.validate(action, {
    streamId,
    state,
    headOffset: prRecords.at(-1)
      ? ((prRecords.at(-1) as Event & { readonly offset: Offset }).offset as Offset)
      : OFFSET_BEFORE_FIRST,
    nextOffset,
    records: prRecords,
    resolveBranch: async (branchStreamId) => {
      const branchRecords = await readExistingNativeBranchRecords(streams, branchStreamId);
      return branchRecords === undefined
        ? undefined
        : { streamId: branchStreamId, offsets: nativeBranchOffsets(branchRecords) };
    },
  });
}

function isLooseEvidenceStreamId(streamId: string): boolean {
  return parseEvidenceStreamIdentity(streamId) !== undefined;
}

function evidenceEventWithoutServerMetadata(value: unknown, fallbackOffset: Offset): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceSchemaError();
  }
  const record = value as Record<string, unknown>;
  const base = { type: record.type, payload: record.payload, ts: record.ts };
  if (
    !isEvent(base) ||
    base.payload === null ||
    typeof base.payload !== "object" ||
    Array.isArray(base.payload)
  ) {
    throw new EvidenceSchemaError();
  }
  const payload = Object.fromEntries(
    Object.entries(base.payload as Record<string, unknown>).filter(
      ([key]) => key !== "actor" && key !== "writer",
    ),
  );
  const offset =
    typeof record.offset === "string" &&
    record.offset !== OFFSET_BEFORE_FIRST &&
    isWellFormedOffset(record.offset)
      ? (record.offset as Offset)
      : fallbackOffset;
  return { ...base, payload, offset } as Event;
}

function reduceEvidenceState(streamId: string, records: readonly Event[]): unknown {
  if (isEvidenceContentStreamId(streamId)) {
    return records.reduce(contentReducer, contentInitialStateForStream(streamId));
  }
  if (isEvidenceStreamId(streamId)) {
    return records.reduce(attachmentReducer, attachmentInitialStateForStream(streamId));
  }
  if (isLooseEvidenceStreamId(streamId)) return attachmentInitialState;
  throw new EvidenceUnknownActionError();
}

async function validateEvidenceDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
  streams: StreamAdapter,
): Promise<void> {
  const normalized = records.map((record, index) =>
    evidenceEventWithoutServerMetadata(record, offsetForOrdinal(index)),
  );
  const nextOffset = offsetForOrdinal(normalized.length);
  const action = evidenceEventWithoutServerMetadata(event, nextOffset);
  await actionValidators.validate(action, {
    streamId,
    state: reduceEvidenceState(streamId, normalized),
    headOffset: normalized.at(-1)
      ? ((normalized.at(-1) as Event & { readonly offset: Offset }).offset as Offset)
      : OFFSET_BEFORE_FIRST,
    nextOffset,
    records: normalized,
    resolveStream: async (targetStreamId): Promise<EvidenceResolvedStream | undefined> => {
      let values: readonly unknown[];
      try {
        values = await streams.read(targetStreamId);
      } catch (error) {
        if (isDurableNotFound(error)) return undefined;
        throw error;
      }
      const targetRecords = values.map((record, index) =>
        evidenceEventWithoutServerMetadata(record, offsetForOrdinal(index)),
      );
      const state =
        isEvidenceStreamId(targetStreamId) || isEvidenceContentStreamId(targetStreamId)
          ? reduceEvidenceState(targetStreamId, targetRecords)
          : undefined;
      return {
        records: targetRecords,
        ...(state === undefined ? {} : { state }),
      };
    },
  });
}

interface BranchProjectionMetadata {
  readonly name: string;
  readonly streamId: string;
  readonly parentStreamId: string | null;
  readonly forkCheckpoint: Offset;
  readonly ancestry: readonly {
    readonly streamId: string;
    readonly parentStreamId: string;
    readonly forkCheckpoint: Offset;
  }[];
}

interface RepositoryProjection {
  readonly records: readonly StreamRecord[];
  readonly metadata: BranchProjectionMetadata;
}

interface HistoryProjectionRecord extends StreamRecord {
  readonly sourceStreamId: string;
  readonly actor: string;
  readonly nativeOffset: Offset;
}

interface RepositoryHistory {
  readonly records: readonly HistoryProjectionRecord[];
  readonly metadata: BranchProjectionMetadata;
}

function branchFork(record: StreamRecord | undefined) {
  if (record === undefined) return undefined;
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  return isFsBranchForkEvent(event) ? event : undefined;
}

function branchGenesis(record: StreamRecord | undefined) {
  if (record === undefined) return undefined;
  const clean = stripWriterMetadata(record);
  const event = { type: clean.type, payload: clean.payload, ts: clean.ts };
  return isFsBranchGenesisEvent(event) ? event : undefined;
}

/**
 * The official Durable Streams fork read includes the inherited transport
 * prefix. StreamFS resolution, however, consumes a leaf segment beginning at
 * that leaf's own fork directive. Rebase that child-owned segment to its local
 * application offsets while leaving parentless/main streams untouched.
 */
function branchLocalSegment(records: readonly StreamRecord[]): readonly StreamRecord[] {
  let firstForkIndex = -1;
  let lastForkIndex = -1;
  let repeatedParentForkIndex = -1;
  let previousParentStreamId: string | undefined;
  for (let index = 0; index < records.length; index += 1) {
    const fork = branchFork(records[index]);
    if (fork === undefined) continue;
    if (firstForkIndex < 0) firstForkIndex = index;
    if (
      repeatedParentForkIndex < 0 &&
      previousParentStreamId !== undefined &&
      previousParentStreamId === fork.payload.parentStreamId
    ) {
      repeatedParentForkIndex = firstForkIndex;
    }
    previousParentStreamId = fork.payload.parentStreamId;
    lastForkIndex = index;
  }
  const forkIndex = repeatedParentForkIndex >= 0 ? repeatedParentForkIndex : lastForkIndex;
  if (forkIndex < 0) return records;
  return records.slice(forkIndex).map((record, index) => ({
    ...record,
    offset: offsetForOrdinal(index),
  }));
}

function stripWriterMetadata(record: StreamRecord): StreamRecord {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return record;
  }
  const payload = Object.fromEntries(
    Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { ...record, payload };
}

function stampedActor(record: StreamRecord): string {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return "unknown-actor";
  }
  const payload = record.payload as Record<string, unknown>;
  const writer = payload.writer;
  const actor = payload.actor;
  if (
    writer !== null &&
    typeof writer === "object" &&
    !Array.isArray(writer) &&
    (writer as Record<string, unknown>).v === 1 &&
    typeof (writer as Record<string, unknown>).sub === "string" &&
    Number.isSafeInteger((writer as Record<string, unknown>).seq) &&
    ((writer as Record<string, unknown>).seq as number) >= 1 &&
    actor === (writer as Record<string, unknown>).sub
  ) {
    return (writer as Record<string, unknown>).sub as string;
  }
  return "unknown-actor";
}

function publicHistoryRecord(
  record: HistoryProjectionRecord,
): Omit<HistoryProjectionRecord, "nativeOffset"> {
  return {
    offset: record.offset,
    type: record.type,
    payload: record.payload,
    ts: record.ts,
    sourceStreamId: record.sourceStreamId,
    actor: record.actor,
  };
}

function branchMetadata(
  name: string,
  streamId: string,
  metadata: Omit<BranchProjectionMetadata, "name" | "streamId">,
  headCheckpoint: Offset,
): Record<string, unknown> {
  return {
    name,
    streamId,
    parentStreamId: metadata.parentStreamId,
    forkCheckpoint: metadata.forkCheckpoint,
    headCheckpoint,
    ancestry: metadata.ancestry,
  };
}

function projectionRecord(value: unknown, previous: Offset): StreamRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationProjectionError(previous, "record is not an object");
  }
  const candidate = value as Record<string, unknown>;
  const offset = candidate.offset;
  if (typeof offset !== "string" || !isWellFormedOffset(offset) || offset === OFFSET_BEFORE_FIRST) {
    throw new ApplicationProjectionError(String(offset ?? previous), "invalid application offset");
  }
  if (compareOffsets(offset, previous) <= 0) {
    throw new ApplicationProjectionError(offset, "duplicate or out-of-order application offset");
  }
  let expected: Offset;
  try {
    expected = nextAllocatedOffset(previous);
  } catch {
    throw new ApplicationProjectionError(previous, "invalid prior application checkpoint");
  }
  if (offset !== expected) {
    throw new ApplicationProjectionError(
      expected,
      `missing application event before observed offset ${offset}`,
    );
  }
  const event = { type: candidate.type, payload: candidate.payload, ts: candidate.ts };
  if (!isEvent(event)) {
    throw new ApplicationProjectionError(offset, "invalid application event");
  }
  return { offset, ...event };
}

function projectionRecords(values: readonly unknown[], from: Offset): readonly StreamRecord[] {
  const records: StreamRecord[] = [];
  let previous = from;
  for (const value of values) {
    const record = projectionRecord(value, previous);
    records.push(record);
    previous = record.offset;
  }
  return records;
}

function validateProjectionReducer(
  definition: ReducerDefinition,
  events: readonly StreamRecord[],
  streamId?: string,
): void {
  let state =
    streamId !== undefined && definition.initialStateForStream !== undefined
      ? definition.initialStateForStream(streamId)
      : definition.initialState;
  for (const event of events) {
    try {
      state = definition.reduce(state, event);
    } catch (error) {
      throw new ApplicationProjectionError(
        event.offset,
        `reducer rejected event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

interface FileContentExpectation {
  readonly digest: string;
  readonly size: number;
}

interface FileContentCandidate extends FileContentExpectation {
  readonly contentBase64: string;
}

class FileContentProjectionError extends ApplicationProjectionError {
  constructor(offset: string, message: string) {
    super(offset, message);
    this.name = "FileContentProjectionError";
  }
}

function objectPayload(value: unknown, offset: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FileContentProjectionError(offset, "file event payload is not an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, offset: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FileContentProjectionError(offset, `file event ${field} is invalid`);
  }
  return value;
}

function requiredSize(value: unknown, field: string, offset: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FileContentProjectionError(offset, `file event ${field} is invalid`);
  }
  return value;
}

function contentCandidate(value: unknown, streamId: string): FileContentCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FileContentProjectionError(
      "-1",
      `content stream ${streamId} contains a malformed record`,
    );
  }
  const record = value as Record<string, unknown>;
  const offset = typeof record.offset === "string" ? record.offset : "-1";
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  if (!isFsFileContentEvent(event) || event.payload.contentStreamId !== streamId) {
    throw new FileContentProjectionError(
      offset,
      `content stream ${streamId} contains a non-content event`,
    );
  }
  const encoded = event.payload.contentBase64;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    throw new FileContentProjectionError(offset, `content stream ${streamId} has invalid base64`);
  }
  if (bytes.toString("base64") !== encoded) {
    throw new FileContentProjectionError(
      offset,
      `content stream ${streamId} has noncanonical base64`,
    );
  }
  return {
    contentBase64: encoded,
    digest: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function moveFileMap<T>(values: Map<string, T>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, value] of [...values.entries()]) {
    if (path === from) {
      values.delete(path);
      values.set(to, value);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.set(`${to}${path.slice(from.length)}`, value);
    }
  }
}

function consumeFileContent(
  records: readonly FileContentCandidate[],
  start: number,
  expected: FileContentExpectation,
  path: string,
  offset: string,
): { readonly content: FileContentCandidate; readonly next: number } {
  for (let index = start; index < records.length; index += 1) {
    const candidate = records[index]!;
    if (candidate.digest === expected.digest && candidate.size === expected.size) {
      return { content: candidate, next: index + 1 };
    }
  }
  throw new FileContentProjectionError(
    offset,
    `file ${path} has no content generation matching ${expected.digest}/${expected.size}`,
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function canonicalResponse(status: number, body: unknown): Response {
  return new Response(canonicalJson(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: ErrorCode, reason: string): Response {
  return json(status, { error: { code, reason } });
}

/**
 * Map a pure refusal to its transport response. Private-unauthorized and
 * nonexistent targets share one refusal (`authz/not-found`), so their
 * responses are byte-identical by construction. Every refusal cites the
 * exact identity-view offset the decision was replayed at.
 */
function authzRefusalResponse(decision: AuthzRefused): Response {
  const status =
    decision.refusal === "authz/grant-revoked" || decision.refusal === "authz/unauthenticated"
      ? 401
      : decision.refusal === "authz/write-grant-required"
        ? 403
        : 404;
  return json(status, {
    error: {
      code: "authz_refused",
      reason: decision.refusal,
      identityOffset: decision.identityOffset,
    },
  });
}

function ownKey(payload: unknown, key: "actor" | "writer"): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.prototype.hasOwnProperty.call(payload, key)
  );
}

function namespaceTenant(streamId: string): string {
  const prefix = "ns:org:";
  const tenant = streamId.startsWith(prefix) ? streamId.slice(prefix.length) : "control";
  return isAuthzName(tenant) ? tenant : "control";
}

function branchForkTarget(streamId: string): Extract<AuthzTarget, { kind: "repo" }> | undefined {
  const match = /^fs:([^/]+)\/([^:]+):([^:]+):meta$/.exec(streamId);
  if (match === null) return undefined;
  const [, org, repo, branch] = match as unknown as [string, string, string, string];
  if (!isAuthzName(org) || !isAuthzName(repo)) return undefined;
  // The branch grammar is validated by the fork validator below. Keeping the
  // parsed value here lets the server return fs/invalid-branch-name instead of
  // making the CLI invent that refusal before the authenticated door.
  return { kind: "repo", org, repo, branch, streamId };
}

function branchForkParentMatches(
  target: Extract<AuthzTarget, { kind: "repo" }>,
  parentStreamId: string,
): boolean {
  const match = /^fs:([^/]+)\/([^:]+):([^:]+):meta$/.exec(parentStreamId);
  if (match === null) return false;
  const [, org, repo, branch] = match as unknown as [string, string, string, string];
  return org === target.org && repo === target.repo && (branch === "main" || isBranchName(branch));
}

function parseDispatch(value: unknown): {
  readonly streamId: string;
  readonly event: Event;
  readonly contentEvent?: Event;
  readonly writerSeq?: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("body_must_be_object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.streamId !== "string" || record.streamId.length === 0) {
    throw new TypeError("invalid_stream_id");
  }
  if (!isEvent(record.event)) throw new TypeError("invalid_event");
  if (
    record.event.payload === null ||
    typeof record.event.payload !== "object" ||
    Array.isArray(record.event.payload)
  ) {
    throw new TypeError("payload_must_be_object");
  }
  const contentEvent = record.contentEvent;
  if (contentEvent !== undefined && !isEvent(contentEvent)) {
    throw new TypeError("invalid_content_event");
  }
  if (
    contentEvent !== undefined &&
    (contentEvent.payload === null ||
      typeof contentEvent.payload !== "object" ||
      Array.isArray(contentEvent.payload))
  ) {
    throw new TypeError("content_payload_must_be_object");
  }
  if (
    record.writerSeq !== undefined &&
    (typeof record.writerSeq !== "number" ||
      !Number.isSafeInteger(record.writerSeq) ||
      record.writerSeq < 1)
  ) {
    throw new TypeError("invalid_writer_sequence");
  }
  return {
    streamId: record.streamId,
    event: record.event,
    ...(contentEvent === undefined ? {} : { contentEvent }),
    ...(record.writerSeq === undefined ? {} : { writerSeq: record.writerSeq as number }),
  };
}

export class PlatformGateway {
  private readonly verifier: AuthorizationVerifier;
  private readonly streams: StreamAdapter;
  private readonly namespaces: NamespaceDispatcher;
  private readonly writers: WriterLaneDispatcher;
  private readonly registry: RegistryProjector | undefined;
  private readonly decideAuthorization: typeof decideStreamAuthorization;
  private readonly rateLimiter: FixedWindowRateLimiter;
  private readonly repositoryHomes: RepositoryHomeStore;
  private readonly actionValidators: ActionValidatorRegistry;
  private readonly issueBoards: IssueBoardMaterializer;
  /** Lazily constructed: only repo-target operations replay the namespace view. */
  private views:
    | (Pick<NamespaceViewReader, "viewFor"> & Partial<Pick<NamespaceViewReader, "terminate">>)
    | undefined;

  constructor(options: PlatformGatewayOptions) {
    this.verifier = options.verifier;
    this.streams = options.streams;
    this.namespaces = options.namespaces ?? new NamespaceDispatcher(options.streams);
    this.writers = new WriterLaneDispatcher(options.streams);
    this.registry = options.registry;
    this.decideAuthorization = options.decideAuthorization ?? decideStreamAuthorization;
    this.rateLimiter =
      options.rateLimiter ?? new FixedWindowRateLimiter(DEFAULT_PLATFORM_RATE_LIMIT);
    this.repositoryHomes = options.repositoryHomes ?? new RepositoryHomeStore(options.streams);
    this.actionValidators = options.actionValidators ?? registerApplicationValidators();
    this.issueBoards =
      options.issueBoards ??
      new IssueBoardMaterializer({
        streams: options.streams,
        ...(options.boardCacheDir === undefined ? {} : { cacheDir: options.boardCacheDir }),
      });
    this.views = options.namespaceViewReader;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (classifyPlatformRoute(url.pathname)) {
      case "dispatch":
        return this.dispatchRoute(request);
      case "namespaces":
        return this.namespaceRoute(request, url);
      case "repos":
        return this.repoRoute(request, url);
      case "registry":
        return this.registryRoute(request, url);
      default:
        return failure(404, "invalid_request", "not_found");
    }
  }

  terminate(): void {
    this.views?.terminate?.();
  }

  /**
   * The web shell has already resolved and validated its signed session
   * cookie against the identity stream. Keep that session credential out of
   * browser JavaScript while reusing the registry door with the exact
   * replayed authorization view.
   */
  async handleSessionRegistry(
    request: Request,
    subject: string,
    authView: AuthorizationView,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/registry/me" || request.headers.has("authorization")) {
      return failure(404, "invalid_request", "not_found");
    }
    return this.registryRoute(request, url, { subject, authView });
  }

  async handleSessionRepositoryHome(
    request: Request,
    subject: string,
    authView: AuthorizationView,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.includes("/home/") || request.headers.has("authorization")) {
      return failure(404, "invalid_request", "not_found");
    }
    return this.repoRoute(request, url, {
      principal: { kind: "identified", sub: subject },
      identity: authView,
      identityOffset: "-1",
    });
  }

  async handleSessionRepository(
    request: Request,
    subject: string,
    authView: AuthorizationView,
    identityOffset: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/repos/") || request.headers.has("authorization")) {
      return failure(404, "invalid_request", "not_found");
    }
    return this.repoRoute(request, url, {
      principal: { kind: "identified", sub: subject, session: true },
      identity: authView,
      identityOffset,
    });
  }

  async handleSessionDispatch(
    request: Request,
    subject: string,
    authView: AuthorizationView,
    identityOffset: string,
  ): Promise<Response> {
    if (new URL(request.url).pathname !== "/api/dispatch" || request.headers.has("authorization")) {
      return failure(404, "invalid_request", "not_found");
    }
    const response = await this.dispatchRoute(request, {
      principal: { kind: "identified", sub: subject, session: true },
      identity: authView,
      identityOffset,
    });
    if (response.status !== 409) return response;
    // Chromium reports handled fetch 4xx responses as console errors. Most
    // same-origin session validators retain the legacy 200 refusal envelope,
    // but the StreamFS stale-write fence is contractually HTTP 409 in every
    // transport, including the browser route.
    const body = (await response.clone().json()) as {
      readonly error?: Readonly<Record<string, unknown>>;
    };
    const error = body.error;
    if (error?.reason === "stale-base") return response;
    const refusal =
      error !== undefined && typeof error.reason === "string" && error.message === undefined
        ? { ...body, error: { ...error, message: error.reason } }
        : body;
    return new Response(JSON.stringify(refusal), {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "x-eforest-refusal-status": "409",
      },
    });
  }

  /**
   * Resolve the request's authorization context. Verifiers without a grant
   * view (the plain E2-T03 BearerVerifier) authenticate the JWT and yield a
   * grant-less principal over the empty identity view: such principals can
   * never satisfy a grant-scoped rule, so they fail closed on private and
   * write decisions.
   */
  private async authzContext(header: string | null): Promise<AuthorizationContext> {
    if (this.verifier.authorizationContext !== undefined) {
      return this.verifier.authorizationContext(header);
    }
    if (header === null || header.trim() === "") {
      return { principal: { kind: "anonymous" }, identity: emptyView(), identityOffset: "-1" };
    }
    const identity = await this.verifier.verifyAuthorization(header);
    return {
      principal: { kind: "identified", sub: identity.sub },
      identity: emptyView(),
      identityOffset: "-1",
    };
  }

  private async namespaceViewFor(org: string): Promise<NamespaceView> {
    this.views ??= new NamespaceViewReader(this.streams);
    return this.views.viewFor(org);
  }

  private admitRate(tenant: string, subject: string | null, operation: RateLimitOperation): void {
    const decision = this.rateLimiter.consume({
      tenant,
      subject: subject ?? "anonymous",
      operation,
    });
    if (!decision.allowed) throw new RateLimitExceededError(decision);
  }

  private tenantRefusal(
    context: AuthorizationContext,
    tenant: string,
    operation: "read" | "follow" | "dispatch",
  ): AuthzRefused | undefined {
    const subject = context.principal.kind === "identified" ? context.principal.sub : null;
    if (decideTenantAccess(context.identity, subject, tenant).allowed) return undefined;
    return {
      allowed: false,
      operation,
      identityOffset: context.identityOffset,
      refusal: "authz/not-found",
    };
  }

  /**
   * Authenticated, read-only namespace resolution through the single E2-T06
   * reducer/resolver pair. Authentication completes before any namespace
   * stream is read, so a refused credential cannot touch namespace state.
   */
  private async namespaceRoute(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    let context: AuthorizationContext;
    try {
      context = await this.authzContext(request.headers.get("authorization"));
      if (context.principal.kind !== "identified" || context.principal.sub.length === 0) {
        await this.verifier.verifyAuthorization(request.headers.get("authorization"));
      }
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      return failure(401, "unauthorized", "malformed_token");
    }

    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice("/api/namespaces/".length));
    } catch {
      return failure(404, "invalid_request", "not_found");
    }
    const org = path.split("/")[0] ?? "";
    if (!isAuthzName(org)) return failure(404, "invalid_request", "not_found");

    try {
      const tenantRefusal = this.tenantRefusal(context, org, "read");
      if (tenantRefusal !== undefined) return authzRefusalResponse(tenantRefusal);
      this.admitRate(
        org,
        context.principal.kind === "identified" ? context.principal.sub : null,
        "namespace.lookup",
      );
      const resolution = resolvePath(await this.namespaceViewFor(org), path);
      return json(200, { ok: true, path, resolution });
    } catch (error) {
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      throw error;
    }
  }

  /**
   * Decide a repo-target operation. Refusals are computed entirely from the
   * two replayed views (`__identity__`, `ns:root`/`ns:org:<org>`): the
   * target stream itself is never created, read, followed, or appended for
   * a refused operation, and nothing is appended anywhere.
   */
  private async decideRepo(
    operation: "read" | "follow" | "dispatch",
    target: AuthzTarget,
    header: string | null,
    trustedContext?: AuthorizationContext,
  ): Promise<AuthzDecision> {
    const context = trustedContext ?? (await this.authzContext(header));
    // GrantAwareVerifier deliberately represents an unknown/revoked grant as
    // an identified principal with grantId="" and (for opaque tokens) an
    // empty subject. Credential refusal precedes tenant accounting: an
    // unauthenticated credential must neither consume quota nor become a
    // malformed counter key. The pure decision returns grant-revoked before
    // consulting the namespace view for every well-formed repo target.
    if (
      target.kind === "repo" &&
      context.principal.kind === "identified" &&
      context.principal.grantId === ""
    ) {
      return this.decideAuthorization({
        operation,
        target,
        principal: context.principal,
        ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
        identity: context.identity,
        identityOffset: context.identityOffset,
        namespace: { orgs: {} },
      });
    }
    if (target.kind === "repo") {
      const tenantRefusal = this.tenantRefusal(context, target.org, operation);
      if (tenantRefusal !== undefined) return tenantRefusal;
      this.admitRate(
        target.org,
        context.principal.kind === "identified" ? context.principal.sub : null,
        operation === "read"
          ? "application.read"
          : operation === "follow"
            ? "application.follow"
            : "application.dispatch",
      );
    } else {
      this.admitRate(
        "malformed",
        context.principal.kind === "identified" ? context.principal.sub : null,
        operation === "read"
          ? "application.read"
          : operation === "follow"
            ? "application.follow"
            : "application.dispatch",
      );
    }
    const namespace =
      target.kind === "repo" ? await this.namespaceViewFor(target.org) : { orgs: {} };
    return this.decideAuthorization({
      operation,
      target,
      principal: context.principal,
      ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
      identity: context.identity,
      identityOffset: context.identityOffset,
      namespace,
    });
  }

  private async dispatchRoute(
    request: Request,
    trustedContext?: AuthorizationContext,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return failure(405, "invalid_request", "method_not_allowed");
    }

    let preliminaryIdentity:
      | {
          readonly sub: string;
        }
      | undefined =
      trustedContext?.principal.kind === "identified"
        ? { sub: trustedContext.principal.sub }
        : undefined;
    let revokedCredential: TokenRevokedError | undefined;
    if (trustedContext === undefined) {
      try {
        preliminaryIdentity = await this.verifier.verifyAuthorization(
          request.headers.get("authorization"),
        );
      } catch (error) {
        if (error instanceof TokenRevokedError) {
          // Authentication stays first (frozen E2-T03/E2-T05 door ordering),
          // but a revoked credential aimed at a repo stream must cite the
          // identity-view offset that refused it — classify the target first.
          revokedCredential = error;
        } else if (error instanceof UnauthorizedError) {
          return failure(401, "unauthorized", error.reason);
        } else {
          return failure(401, "unauthorized", "malformed_token");
        }
      }
    }

    let parsed;
    try {
      const body = await request.arrayBuffer();
      let bodySource: string;
      try {
        bodySource = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        throw new SyntaxError("dispatch body is not valid UTF-8");
      }
      const source = parseJsonWithIssueEnvelopeSource(bodySource, body.byteLength);
      parsed = { ...parseDispatch(source.value), issueSource: source.issueSource };
    } catch (error) {
      if (revokedCredential !== undefined) {
        return json(401, { error: { class: "token-revoked" } });
      }
      const reason = error instanceof TypeError ? error.message : "malformed_json";
      return failure(400, "invalid_request", reason);
    }
    const namespaceEvent = await this.namespaces.isEventType(parsed.event.type);
    const branchForkEvent = isFsBranchForkEvent(parsed.event) ? parsed.event : undefined;
    const branchGenesisEvent = isFsBranchGenesisEvent(parsed.event) ? parsed.event : undefined;
    const evidenceStream =
      isEvidenceStreamId(parsed.streamId) || isLooseEvidenceStreamId(parsed.streamId);
    const evidenceContentStream = isEvidenceContentStreamId(parsed.streamId);
    const target = parsed.streamId.startsWith("issue-board:")
      ? ({ kind: "internal" as const, streamId: parsed.streamId } satisfies AuthzTarget)
      : branchForkEvent === undefined
        ? classifyDispatchTarget(parsed.streamId, namespaceEvent ? "namespace" : "application")
        : (branchForkTarget(parsed.streamId) ?? {
            kind: "malformed" as const,
            input: parsed.streamId,
          });
    if (branchForkEvent !== undefined && target.kind === "repo") {
      if (!isBranchName(target.branch)) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: "fs/invalid-branch-name",
            message: `invalid branch name ${JSON.stringify(target.branch)}`,
          },
        });
      }
      if (!branchForkParentMatches(target, branchForkEvent.payload.parentStreamId)) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: "fs/parent-not-found",
            message: "parent stream does not exist",
          },
        });
      }
    }
    if (
      branchGenesisEvent !== undefined &&
      target.kind === "repo" &&
      branchGenesisEvent.payload.branch !== target.branch
    ) {
      return json(409, {
        error: {
          class: "validator-rejected",
          reason: "fs/invalid-branch-name",
          message: "branch genesis does not match its target stream",
        },
      });
    }
    if (revokedCredential !== undefined) {
      if (target.kind === "repo" || target.kind === "malformed") {
        return authzRefusalResponse({
          allowed: false,
          operation: "dispatch",
          identityOffset: revokedCredential.identityOffset ?? "-1",
          refusal: target.kind === "malformed" ? "authz/malformed-target" : "authz/grant-revoked",
        });
      }
      return json(401, { error: { class: "token-revoked" } });
    }
    if (!namespaceEvent && ownKey(parsed.event.payload, "actor")) {
      return failure(400, "invalid_request", "client_actor_forbidden");
    }
    if (!namespaceEvent && ownKey(parsed.event.payload, "writer")) {
      return failure(400, "invalid_request", "client_writer_forbidden");
    }
    if (
      parsed.contentEvent !== undefined &&
      (ownKey(parsed.contentEvent.payload, "actor") || ownKey(parsed.contentEvent.payload, "writer"))
    ) {
      return failure(400, "invalid_request", "client_content_writer_metadata_forbidden");
    }
    if (
      parsed.contentEvent !== undefined &&
      (parsed.event.type !== "fs.file.write" || !isFsFileContentEvent(parsed.contentEvent))
    ) {
      return failure(400, "invalid_request", "invalid_full_write_content_event");
    }

    try {
      if (
        !namespaceEvent &&
        isIssueActionType(parsed.event.type) &&
        !isIssueStreamId(parsed.streamId)
      ) {
        throw new IssueUnknownActionError();
      }
      if (
        !namespaceEvent &&
        isLabelActionType(parsed.event.type) &&
        !isRepoLabelsStreamId(parsed.streamId)
      ) {
        throw new LabelUnknownActionError();
      }
      if (!namespaceEvent && isPrActionType(parsed.event.type) && !isPrStreamId(parsed.streamId)) {
        throw new PrUnknownActionError();
      }
      if (
        !namespaceEvent &&
        ((isEvidenceActionType(parsed.event.type) && !evidenceStream) ||
          (isEvidenceContentActionType(parsed.event.type) && !evidenceContentStream) ||
          (evidenceStream && !isEvidenceActionType(parsed.event.type)) ||
          (evidenceContentStream && !isEvidenceContentActionType(parsed.event.type)))
      ) {
        throw new EvidenceUnknownActionError();
      }
      // E2-T07: every dispatch is decided before any official-stream
      // operation. Repo targets replay both views; control and sandbox
      // targets are decided purely (no reads) and keep their frozen door
      // behavior; internal and malformed targets always refuse.
      let repoDecision: AuthzDecision | undefined;
      if (target.kind === "repo") {
        repoDecision = await this.decideRepo(
          "dispatch",
          target,
          request.headers.get("authorization"),
          trustedContext,
        );
        if (!repoDecision.allowed) return authzRefusalResponse(repoDecision);
      } else {
        const tenant = target.kind === "control" ? namespaceTenant(parsed.streamId) : target.kind;
        if (target.kind === "control" && tenant !== "control") {
          const context =
            trustedContext ?? (await this.authzContext(request.headers.get("authorization")));
          const tenantRefusal = this.tenantRefusal(context, tenant, "dispatch");
          if (tenantRefusal !== undefined) return authzRefusalResponse(tenantRefusal);
        }
        this.admitRate(tenant, preliminaryIdentity!.sub, "application.dispatch");
        const decision = decideStreamAuthorization({
          operation: "dispatch",
          target,
          principal: { kind: "identified", sub: preliminaryIdentity!.sub },
          eventKind: namespaceEvent ? "namespace" : "application",
          identity: trustedContext?.identity ?? emptyView(),
          identityOffset: trustedContext?.identityOffset ?? "-1",
          namespace: { orgs: {} },
        });
        if (!decision.allowed) return authzRefusalResponse(decision);
      }

      // Writer-lane recovery may return an existing idempotency receipt before
      // invoking options.validate. Keep static source-shape validation outside
      // that recovery shortcut, after authz and unknown-action classification;
      // the lane still owns full envelope and workflow validation before append.
      if (isIssueStreamId(parsed.streamId)) {
        if (!isIssueActionType(parsed.event.type)) throw new IssueUnknownActionError();
        if (!isIssueEnvelopeSourceValid(parsed.issueSource)) throw new IssueSchemaError();
      }
      if (isPrStreamId(parsed.streamId)) {
        if (!isPrActionType(parsed.event.type)) throw new PrUnknownActionError();
        if (!isPrEvent(parsed.event)) throw new PrSchemaError();
      }
      if (evidenceStream && !isEvidenceActionType(parsed.event.type)) {
        throw new EvidenceUnknownActionError();
      }
      if (evidenceContentStream && !isEvidenceContentActionType(parsed.event.type)) {
        throw new EvidenceUnknownActionError();
      }

      const eventFor = async (
        identity: { readonly sub: string },
        _operationId?: string,
      ): Promise<Event> => {
        if (branchForkEvent !== undefined) return branchForkEvent;
        if (namespaceEvent) {
          return this.namespaces.stampEvent(parsed.event, identity.sub);
        }
        // Grant-aware planning must remain target-I/O-free: E2-T05 records
        // the durable operation before discovering a missing/closed target.
        // Writer metadata is stamped only at target mutation time, after the
        // operation is durable; recovery derives the same next lane from the
        // target stream and recognizes a prior append by operation id.
        const payload = parsed.event.payload as Record<string, unknown>;
        return { ...parsed.event, payload: { ...payload, actor: identity.sub } };
      };
      const mutate = async (
        identity: { readonly sub: string },
        operationId?: string,
        assertActive?: () => Promise<void>,
        decidedAt?: string,
      ): Promise<Response> => {
        if (branchForkEvent !== undefined) {
          if (target.kind !== "repo" || this.streams.fork === undefined) {
            throw new GrantTargetCommitError("native branch fork is unavailable");
          }
          try {
            if (assertActive !== undefined) await assertActive();
            await this.streams.fork(
              parsed.streamId,
              branchForkEvent.payload.parentStreamId,
              branchForkEvent.payload.forkOffset,
              branchForkEvent,
              operationId === undefined ? {} : { idempotencyKey: operationId },
            );
          } catch (error) {
            if (error instanceof StreamForkValidationError) {
              throw new BranchForkRefusalError(error.reason, error.message);
            }
            if (error instanceof StreamForkExistsError) {
              throw new BranchForkRefusalError("fs/branch-exists", "branch already exists");
            }
            if (isDurableExistsConflict(error)) {
              throw new BranchForkRefusalError("fs/branch-exists");
            }
            if (isDurableNotFound(error)) {
              throw new BranchForkRefusalError(
                "fs/parent-not-found",
                "parent stream does not exist",
              );
            }
            throw new GrantTargetCommitError(error);
          }
          return json(202, {
            ok: true,
            streamId: parsed.streamId,
            forkOffset: branchForkEvent.payload.forkOffset,
            ...(repoDecision === undefined
              ? {}
              : { identityOffset: decidedAt ?? repoDecision.identityOffset }),
          });
        }
        if (namespaceEvent) {
          await this.namespaces.dispatch(
            parsed.streamId,
            parsed.event,
            identity.sub,
            operationId,
            assertActive,
          );
          // E2-T08: nudge the registry projector — the accepted source event
          // becomes a derived frame without waiting for the poll interval.
          this.registry?.poke();
          return json(202, { ok: true, actor: identity.sub });
        }
        let dispatchOffset: Offset | undefined;
        let committedEvent: Event | undefined;
        let issueCatalogOffset: Offset | undefined;
        try {
          if (branchGenesisEvent !== undefined) {
            try {
              await this.streams.create(parsed.streamId);
            } catch (error) {
              if (isDurableExistsConflict(error)) {
                throw new BranchForkRefusalError("fs/branch-exists", "branch already exists");
              }
              throw error;
            }
          }
          if (isIssueStreamId(parsed.streamId) && parsed.event.type === "issue.opened") {
            try {
              await this.streams.create(parsed.streamId);
            } catch (error) {
              if (!isDurableExistsConflict(error)) throw error;
            }
          }
          if (isRepoLabelsStreamId(parsed.streamId)) {
            try {
              await this.streams.create(parsed.streamId);
            } catch (error) {
              if (!isDurableExistsConflict(error)) throw error;
            }
          }
          if (evidenceStream || evidenceContentStream) {
            try {
              await this.streams.create(parsed.streamId);
            } catch (error) {
              if (!isDurableExistsConflict(error)) throw error;
            }
          }
          let fullWriteContentStaged = false;
          const validateApplication = async (
            records: readonly unknown[],
            stamped: WriterScopedEvent,
          ): Promise<void> => {
            validateFsBase(records, stamped);
            if (isIssueStreamId(parsed.streamId)) {
              issueCatalogOffset = await validateIssueDispatch(
                records,
                stamped,
                parsed.streamId,
                this.actionValidators,
                this.issueBoards,
                parsed.issueSource,
              );
            }
            if (isRepoLabelsStreamId(parsed.streamId)) {
              await validateLabelDispatch(
                records,
                stamped,
                parsed.streamId,
                this.actionValidators,
              );
            }
            if (isPrStreamId(parsed.streamId)) {
              await validatePrDispatch(
                records,
                stamped,
                parsed.streamId,
                this.actionValidators,
                this.streams,
              );
            }
            if (evidenceStream || evidenceContentStream) {
              await validateEvidenceDispatch(
                records,
                stamped,
                parsed.streamId,
                this.actionValidators,
                this.streams,
              );
            }
            if (parsed.contentEvent !== undefined && !fullWriteContentStaged) {
              if (assertActive !== undefined) await assertActive();
              await stageFullWriteContent(
                this.streams,
                records,
                stamped,
                parsed.contentEvent,
                operationId,
              );
              fullWriteContentStaged = true;
            }
          };
          if (operationId === undefined) {
            const receipt = await this.writers.dispatch(
              parsed.streamId,
              parsed.event,
              identity.sub,
              {
                ...(parsed.writerSeq === undefined ? {} : { requestedSequence: parsed.writerSeq }),
                validate: validateApplication,
              },
            );
            dispatchOffset = receipt.globalSequence;
            committedEvent = receipt.event;
          } else {
            const receipt = await this.writers.dispatch(
              parsed.streamId,
              parsed.event,
              identity.sub,
              {
                operationId,
                ...(parsed.writerSeq === undefined ? {} : { requestedSequence: parsed.writerSeq }),
                ...(assertActive === undefined ? {} : { assertActive }),
                validate: validateApplication,
              },
            );
            dispatchOffset = receipt.globalSequence;
            committedEvent = receipt.event;
          }
        } catch (error) {
          if (error instanceof TokenRevokedError) throw error;
          if (
            error instanceof BranchForkRefusalError ||
            error instanceof TypeError ||
            error instanceof WriterLaneRefusalError ||
            error instanceof WriterLaneCorruptionError ||
            error instanceof WriterLaneContentionError ||
            error instanceof FsStaleBaseError ||
            error instanceof IssueUnknownActionError ||
            error instanceof IssueSchemaError ||
            error instanceof IssueRefusalError ||
            error instanceof LabelUnknownActionError ||
            error instanceof LabelSchemaError ||
            error instanceof LabelRefusalError ||
            error instanceof PrUnknownActionError ||
            error instanceof PrSchemaError ||
            error instanceof PrRefusalError ||
            error instanceof EvidenceUnknownActionError ||
            error instanceof EvidenceSchemaError ||
            error instanceof EvidenceRefusalError
          ) {
            throw error;
          }
          if (isDurableNotFound(error)) throw new GrantTargetUnavailableError();
          throw new GrantTargetCommitError(error);
        }
        try {
          if (
            (isIssueStreamId(parsed.streamId) || isRepoLabelsStreamId(parsed.streamId)) &&
            committedEvent !== undefined &&
            dispatchOffset !== undefined
          ) {
            await this.issueBoards.applyCommittedEvent(
              parsed.streamId,
              committedEvent,
              dispatchOffset,
              issueCatalogOffset,
            );
          }
        } catch {
          // The source event is already committed. A disposable derived-copy
          // refresh failure must not turn that accepted mutation into a false refusal.
        }
        if (target.kind === "repo") {
          return json(202, {
            ok: true,
            actor: identity.sub,
            identityOffset: decidedAt ?? repoDecision!.identityOffset,
            ...(request.headers.get("x-eforest-dispatch-receipt") === "offset" &&
            dispatchOffset !== undefined
              ? { offset: dispatchOffset }
              : {}),
          });
        }
        return json(202, { ok: true, actor: identity.sub });
      };
      if (trustedContext === undefined && this.verifier.withAuthorizedMutation !== undefined) {
        return await this.verifier.withAuthorizedMutation(
          request.headers.get("authorization"),
          async (identity, operationId) => ({
            streamId: parsed.streamId,
            event: await eventFor(identity, operationId),
          }),
          mutate,
        );
      }
      return await mutate(preliminaryIdentity!);
    } catch (error) {
      if (error instanceof BranchForkRefusalError) {
        return json(409, {
          error: { class: "validator-rejected", reason: error.reason, message: error.message },
        });
      }
      if (error instanceof StreamForkValidationError) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: error.reason,
            message: error.message,
          },
        });
      }
      if (error instanceof TokenRevokedError) {
        if (target.kind === "repo") {
          return authzRefusalResponse({
            allowed: false,
            operation: "dispatch",
            identityOffset: error.identityOffset ?? "-1",
            refusal: "authz/grant-revoked",
          });
        }
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      if (
        error instanceof IssueUnknownActionError ||
        error instanceof PrUnknownActionError ||
        error instanceof LabelUnknownActionError ||
        error instanceof EvidenceUnknownActionError
      ) {
        return json(404, { error: { class: "unknown-action-type" } });
      }
      if (
        error instanceof IssueSchemaError ||
        error instanceof PrSchemaError ||
        error instanceof LabelSchemaError ||
        error instanceof EvidenceSchemaError
      ) {
        return json(422, { error: { class: "schema-violation" } });
      }
      if (error instanceof IssueRefusalError) {
        return json(409, { error: { class: "validator-rejected", reason: error.reason } });
      }
      if (error instanceof LabelRefusalError) {
        return json(409, { error: { class: "validator-rejected", reason: error.reason } });
      }
      if (error instanceof PrRefusalError) {
        return json(409, { error: { class: "validator-rejected", reason: error.reason } });
      }
      if (error instanceof EvidenceRefusalError) {
        return json(409, { error: { class: "validator-rejected", reason: error.reason } });
      }
      if (error instanceof NamespaceSchemaError || error instanceof TypeError) {
        return json(422, { error: { class: "schema-violation" } });
      }
      if (error instanceof NamespaceRefusalError) {
        return json(409, {
          error: { class: "validator-rejected", reason: error.reason },
        });
      }
      if (error instanceof WriterLaneRefusalError) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: error.reason,
            expected: error.expected,
            provided: error.provided,
          },
        });
      }
      if (error instanceof FsStaleBaseError) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: "stale-base",
            conflict: error.conflict,
          },
        });
      }
      if (error instanceof WriterLaneCorruptionError) {
        return failure(503, "dispatch_failed", "writer_lane_corrupt");
      }
      if (error instanceof AuthzViewUnavailableError) {
        // Fail closed: without a replayed namespace view there is no
        // decision, no official-stream operation, and no append.
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof GrantTargetUnavailableError || error instanceof GrantTargetCommitError) {
        return failure(502, "dispatch_failed", "official_stream_append_failed");
      }
      if (error instanceof NamespaceContentionError) {
        // Internal append contention is a retryable coordination failure and
        // must never surface as an authentication error.
        return failure(503, "dispatch_failed", "namespace_contention");
      }
      if (error instanceof WriterLaneContentionError) {
        return failure(503, "dispatch_failed", "writer_lane_contention");
      }
      return failure(401, "unauthorized", "malformed_token");
    }
  }

  /**
   * E2-T08: `GET /registry/public | /registry/org/:org | /registry/me` in
   * snapshot, long-poll, and SSE modes. Every answer is filtered per the
   * requesting identity via the single `filterForIdentity`; `/registry/me`
   * requires a valid token (E2-T03's exact 401 otherwise); `/registry/org/:x`
   * for anonymous or non-member identities FILTERS (public subset) rather
   * than refusing — listing is filtered, not refused.
   */
  private async registryRoute(
    request: Request,
    url: URL,
    trustedSession?: { readonly subject: string; readonly authView: AuthorizationView },
  ): Promise<Response> {
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    const segments = url.pathname.split("/").slice(2);
    let scope: RegistryScope;
    let identityFree = false;
    let requireToken = false;
    if (segments.length === 1 && segments[0] === "public") {
      scope = {};
      identityFree = true;
    } else if (segments.length === 1 && segments[0] === "me") {
      scope = {};
      requireToken = true;
    } else if (segments.length === 2 && segments[0] === "org") {
      let org: string;
      try {
        org = decodeURIComponent(segments[1]!);
      } catch {
        org = " ";
      }
      // Grammar decided from request text alone — never a state consult, so
      // the refusal cannot leak existence.
      if (!isAuthzName(org)) return failure(404, "invalid_request", "not_found");
      scope = { org };
    } else {
      return failure(404, "invalid_request", "not_found");
    }

    let subject: string | null = trustedSession?.subject ?? null;
    let authView: AuthorizationView = trustedSession?.authView ?? emptyView();
    if (!identityFree && trustedSession === undefined) {
      const header = request.headers.get("authorization");
      try {
        if (header !== null && header.trim() !== "") {
          // A PRESENTED credential must verify (the exact E2-T03/E2-T05
          // refusal taxonomy — a revoked or unknown credential is 401, never
          // a silently-anonymous listing): membership visibility flows only
          // from a verified identity.
          const identity = await this.verifier.verifyAuthorization(header);
          subject = identity.sub;
          const context = await this.authzContext(header);
          authView = context.identity;
        } else if (requireToken) {
          // /registry/me with no token: E2-T03's exact 401.
          await this.verifier.verifyAuthorization(header);
        }
      } catch (error) {
        if (error instanceof TokenRevokedError) {
          return json(401, { error: { class: "token-revoked" } });
        }
        if (error instanceof UnauthorizedError) {
          return failure(401, "unauthorized", error.reason);
        }
        return failure(401, "unauthorized", "malformed_token");
      }
      if (requireToken && subject === null) {
        return failure(401, "unauthorized", "missing_bearer_token");
      }
      if (requireToken) scope = { ...scope, restrictOwn: subject! };
    }
    if (requireToken && trustedSession !== undefined) {
      scope = { ...scope, restrictOwn: trustedSession.subject };
    }

    try {
      const tenant = scope.org ?? (subject === null ? "public" : `subject:${subject}`);
      if (scope.org !== undefined && !decideTenantAccess(authView, subject, scope.org).allowed) {
        return failure(404, "invalid_request", "not_found");
      }
      this.admitRate(tenant, subject, "registry.query");
      const projection = url.searchParams.get("projection") === "1";
      if (projection) {
        if (!requireToken || subject === null) {
          return failure(400, "invalid_request", "invalid_projection");
        }
        try {
          requireReducer(url.searchParams.get("reducer") ?? "", "__registry__");
        } catch {
          return failure(400, "invalid_request", "invalid_reducer");
        }
        const liveProjection = url.searchParams.get("live");
        if (liveProjection === null) {
          return registryApplicationProjectionResponse(this.streams, authView, subject, scope);
        }
        if (liveProjection !== "1") {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        const checkpointRaw = url.searchParams.get("checkpoint") ?? "-1";
        if (!isWellFormedOffset(checkpointRaw)) {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_FOLLOW_WAIT_MS) {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        return registryApplicationProjectionResponse(
          this.streams,
          authView,
          subject,
          scope,
          checkpointRaw,
          waitMs,
        );
      }
      const live = url.searchParams.get("live");
      if (live === null) {
        return registrySnapshotResponse(this.streams, authView, subject, scope);
      }
      const afterRaw = url.searchParams.get("after") ?? "-1";
      if (afterRaw !== "-1" && !isWellFormedOffset(afterRaw)) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const after = afterRaw as Offset | "-1";
      if (live === "sse") {
        return registrySseResponse(this.streams, authView, subject, scope, after);
      }
      if (live !== "long-poll") {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_FOLLOW_WAIT_MS) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      return registryLongPollResponse(this.streams, authView, subject, scope, after, waitMs);
    } catch (error) {
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
  }

  /**
   * `GET /api/repos/<org>/<repo>/<branch>/events[?live=1&after=N&waitMs=M]`
   * — the authorized application read (and long-poll live follow) of a
   * repo/branch stream. The same decision function gates it before any
   * official-stream access to the target.
   */
  private async repoRoute(
    request: Request,
    url: URL,
    trustedContext?: AuthorizationContext,
  ): Promise<Response> {
    const segments = url.pathname.split("/").slice(2);
    const homeRegion =
      segments.length === 5 &&
      segments[3] === "home" &&
      (segments[4] === "namespace" || segments[4] === "branches" || segments[4] === "status")
        ? (segments[4] as RepositoryHomeRegion)
        : undefined;
    const applicationEvents = segments.length === 5 && segments[4] === "events";
    const boardRoute = segments.length === 4 && segments[3] === "board";
    const blobRoute = segments.length >= 6 && segments[4] === "blob";
    if (
      (!applicationEvents && homeRegion === undefined && !blobRoute && !boardRoute) ||
      segments.some((s) => s === "")
    ) {
      return failure(404, "invalid_request", "not_found");
    }
    if (boardRoute) {
      let org: string;
      let repo: string;
      try {
        org = decodeURIComponent(segments[1]!);
        repo = decodeURIComponent(segments[2]!);
      } catch {
        return failure(404, "invalid_request", "not_found");
      }
      return this.repositoryBoardRoute(request, url, org, repo, trustedContext);
    }
    let decoded: string[];
    try {
      decoded = segments
        .slice(1, homeRegion === undefined ? 4 : 3)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      decoded = [" ", " ", " "];
    }
    if (homeRegion !== undefined) {
      return this.repositoryHomeRoute(
        request,
        url,
        decoded[0]!,
        decoded[1]!,
        homeRegion,
        trustedContext,
      );
    }
    if (blobRoute) {
      const pathSegments: string[] = [];
      try {
        for (const encoded of segments.slice(5)) {
          const path = decodeURIComponent(encoded);
          if (path.includes("/")) return failure(404, "invalid_request", "not_found");
          pathSegments.push(path);
        }
      } catch {
        return failure(404, "invalid_request", "not_found");
      }
      return this.repositoryFileRoute(
        request,
        url,
        decoded[0]!,
        decoded[1]!,
        decoded[2]!,
        pathSegments.join("/"),
        trustedContext,
      );
    }
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    const selectedStream = url.searchParams.get("stream");
    const selectedIssueId = url.searchParams.get("issueId");
    const selectedEntityType = url.searchParams.get("entityType");
    const selectedEntityId = url.searchParams.get("entityId");
    const selectedAttachmentId = url.searchParams.get("attachmentId");
    if (
      selectedStream !== null &&
      selectedStream !== "repo-labels" &&
      selectedStream !== "issue" &&
      selectedStream !== "evidence" &&
      selectedStream !== "evidence-content"
    ) {
      return failure(400, "invalid_request", "invalid_stream_selector");
    }
    if (
      (selectedStream !== null && decoded[2] !== "main") ||
      (selectedStream === "issue" && selectedIssueId === null) ||
      (selectedStream !== "issue" && selectedIssueId !== null) ||
      (selectedStream === "evidence" &&
        (selectedEntityType === null ||
          !isEvidenceEntityType(selectedEntityType) ||
          selectedEntityId === null)) ||
      (selectedStream !== "evidence" &&
        (selectedEntityType !== null || selectedEntityId !== null)) ||
      (selectedStream === "evidence-content" && selectedAttachmentId === null) ||
      (selectedStream !== "evidence-content" && selectedAttachmentId !== null)
    ) {
      return failure(400, "invalid_request", "invalid_stream_selector");
    }
    let selectedIssueStream: string | undefined;
    let selectedEvidenceStream: string | undefined;
    if (selectedStream === "issue") {
      try {
        selectedIssueStream = issueStreamId(decoded[0]!, decoded[1]!, selectedIssueId!);
      } catch {
        return failure(400, "invalid_request", "invalid_issue_id");
      }
    }
    if (selectedStream === "evidence") {
      try {
        selectedEvidenceStream = evidenceStreamId({
          org: decoded[0]!,
          repo: decoded[1]!,
          entityType: selectedEntityType as "issue" | "pr",
          entityId: selectedEntityId!,
        });
      } catch {
        return failure(400, "invalid_request", "invalid_entity_id");
      }
    }
    if (selectedStream === "evidence-content") {
      try {
        selectedEvidenceStream = evidenceContentStreamId(
          decoded[0]!,
          decoded[1]!,
          selectedAttachmentId!,
        );
      } catch {
        return failure(400, "invalid_request", "invalid_attachment_id");
      }
    }
    const target =
      selectedStream === "repo-labels"
        ? classifyDispatchTarget(repoLabelsStreamId(decoded[0]!, decoded[1]!), "application")
        : selectedIssueStream !== undefined
          ? classifyDispatchTarget(selectedIssueStream, "application")
          : selectedEvidenceStream !== undefined
            ? classifyDispatchTarget(selectedEvidenceStream, "application")
            : repoTargetFromPath(decoded[0]!, decoded[1]!, decoded[2]!);
    const live = url.searchParams.get("live") === "1";
    const operation = live ? "follow" : "read";

    let decision: AuthzDecision;
    try {
      decision = await this.decideRepo(
        operation,
        target,
        request.headers.get("authorization"),
        trustedContext,
      );
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
    if (!decision.allowed) return authzRefusalResponse(decision);

    const projection = url.searchParams.get("projection") === "1";
    const reducerId = url.searchParams.get("reducer") ?? "";
    let reducer: ReturnType<typeof requireReducer> | undefined;
    if (projection) {
      try {
        reducer = requireReducer(reducerId, decision.streamId);
      } catch {
        return failure(400, "invalid_request", "invalid_reducer");
      }
    }
    const historyProjection = projection && reducer?.id === "history";

    if (!live) {
      if (projection) {
        try {
          if (historyProjection) {
            const history = await this.historyProjection(decision.streamId, decoded[2]!);
            const events = history.records.map(publicHistoryRecord);
            const checkpoint = applicationCheckpoint(events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST);
            validateProjectionReducer(reducer!, events, decision.streamId);
            return json(200, {
              ok: true,
              events,
              checkpoint: checkpoint.offset,
              reducer: { id: reducer!.id, version: reducer!.version },
              branch: branchMetadata(
                history.metadata.name,
                history.metadata.streamId,
                history.metadata,
                checkpoint.offset,
              ),
              identityOffset: decision.identityOffset,
              basis: decision.basis,
            });
          }
          const repository =
            decoded[2] === "main"
              ? {
                  records: (await this.bootstrapProjection(decision.streamId)).events,
                  metadata: {
                    name: decoded[2]!,
                    streamId: decision.streamId,
                    parentStreamId: null,
                    forkCheckpoint: OFFSET_BEFORE_FIRST,
                    ancestry: [],
                  } satisfies BranchProjectionMetadata,
                }
              : await this.repositoryProjection(decision.streamId, decoded[2]!);
          const batch = {
            events: repository.records,
            checkpoint: applicationCheckpoint(
              repository.records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
            ),
          };
          validateProjectionReducer(reducer!, batch.events, decision.streamId);
          return json(200, {
            ok: true,
            events: batch.events,
            checkpoint: batch.checkpoint.offset,
            reducer: { id: reducer!.id, version: reducer!.version },
            branch: branchMetadata(
              repository.metadata.name,
              repository.metadata.streamId,
              repository.metadata,
              batch.checkpoint.offset,
            ),
            identityOffset: decision.identityOffset,
            basis: decision.basis,
          });
        } catch (error) {
          if (error instanceof ApplicationProjectionError) {
            return json(422, {
              error: {
                class: "malformed_application_event",
                offset: error.offset,
                reason: error.message,
              },
            });
          }
          throw error;
        }
      }
      const events = await this.readTarget(decision.streamId);
      return json(200, {
        ok: true,
        events,
        count: events.length,
        identityOffset: decision.identityOffset,
        basis: decision.basis,
      });
    }

    if (projection) {
      const from = url.searchParams.get("checkpoint");
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (
        !isWellFormedOffset(from) ||
        !Number.isSafeInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > MAX_FOLLOW_WAIT_MS
      ) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      try {
        if (historyProjection) {
          const history = await this.followHistoryProjection(
            decision.streamId,
            decoded[2]!,
            applicationCheckpoint(from),
            waitMs,
          );
          const batch = history.batch;
          return json(200, {
            ok: true,
            events: batch.events,
            checkpoint: batch.checkpoint.offset,
            reducer: { id: reducer!.id, version: reducer!.version },
            branch: branchMetadata(
              history.metadata.name,
              history.metadata.streamId,
              history.metadata,
              batch.checkpoint.offset,
            ),
            identityOffset: decision.identityOffset,
            basis: decision.basis,
          });
        }
        const repository =
          decoded[2] === "main"
            ? {
                batch: await this.followProjection(
                  decision.streamId,
                  applicationCheckpoint(from),
                  waitMs,
                ),
                metadata: {
                  name: decoded[2]!,
                  streamId: decision.streamId,
                  parentStreamId: null,
                  forkCheckpoint: OFFSET_BEFORE_FIRST,
                  ancestry: [],
                } satisfies BranchProjectionMetadata,
              }
            : await this.followRepositoryProjection(
                decision.streamId,
                decoded[2]!,
                applicationCheckpoint(from),
                waitMs,
              );
        const batch = repository.batch;
        return json(200, {
          ok: true,
          events: batch.events,
          checkpoint: batch.checkpoint.offset,
          reducer: { id: reducer!.id, version: reducer!.version },
          branch: branchMetadata(
            repository.metadata.name,
            repository.metadata.streamId,
            repository.metadata,
            batch.checkpoint.offset,
          ),
          identityOffset: decision.identityOffset,
          basis: decision.basis,
        });
      } catch (error) {
        if (error instanceof ApplicationProjectionError) {
          return json(422, {
            error: {
              class: "malformed_application_event",
              offset: error.offset,
              reason: error.message,
            },
          });
        }
        throw error;
      }
    }

    const after = Number(url.searchParams.get("after") ?? "0");
    const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > MAX_FOLLOW_WAIT_MS
    ) {
      return failure(400, "invalid_request", "invalid_follow_parameters");
    }
    const events = await this.followTarget(decision.streamId, after, waitMs);
    return json(200, {
      ok: true,
      events,
      after: after + events.length,
      identityOffset: decision.identityOffset,
      basis: decision.basis,
    });
  }

  private async repositoryBoardRoute(
    request: Request,
    url: URL,
    org: string,
    repo: string,
    trustedContext?: AuthorizationContext,
  ): Promise<Response> {
    if (request.method !== "GET") return failure(405, "invalid_request", "method_not_allowed");
    const projection = url.searchParams.get("projection") === "1";
    const liveRaw = url.searchParams.get("live");
    const live = projection && liveRaw === "1";
    let decision: AuthzDecision;
    try {
      decision = await this.decideRepo(
        live ? "follow" : "read",
        repoTargetFromPath(org, repo, "main"),
        request.headers.get("authorization"),
        trustedContext,
      );
    } catch (error) {
      if (error instanceof TokenRevokedError)
        return json(401, { error: { class: "token-revoked" } });
      if (error instanceof UnauthorizedError) return failure(401, "unauthorized", error.reason);
      if (error instanceof AuthzViewUnavailableError)
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
    if (!decision.allowed) return authzRefusalResponse(decision);
    if (projection) {
      const streamId = repoIssueBoardStreamId(org, repo);
      let reducer: ReturnType<typeof requireReducer>;
      try {
        reducer = requireReducer(url.searchParams.get("reducer") ?? "", streamId);
      } catch {
        return failure(400, "invalid_request", "invalid_reducer");
      }
      if (reducer.id !== BOARD_REDUCER) {
        return failure(400, "invalid_request", "invalid_reducer");
      }
      if (liveRaw !== null && liveRaw !== "1") {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const checkpointRaw = live ? url.searchParams.get("checkpoint") : undefined;
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (
        (live && (checkpointRaw === null || !isWellFormedOffset(checkpointRaw))) ||
        !Number.isSafeInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > MAX_FOLLOW_WAIT_MS
      ) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      try {
        await this.issueBoards.materialize(org, repo);
        const batch = live
          ? await this.followProjection(
              streamId,
              applicationCheckpoint(checkpointRaw! as Offset),
              waitMs,
            )
          : await this.bootstrapProjection(streamId);
        validateProjectionReducer(reducer, batch.events, streamId);
        return json(200, {
          ok: true,
          events: batch.events,
          checkpoint: batch.checkpoint.offset,
          reducer: { id: reducer.id, version: reducer.version },
          branch: branchMetadata(
            "main",
            streamId,
            { parentStreamId: null, forkCheckpoint: OFFSET_BEFORE_FIRST, ancestry: [] },
            batch.checkpoint.offset,
          ),
          identityOffset: decision.identityOffset,
          basis: decision.basis,
        });
      } catch (error) {
        if (error instanceof ApplicationProjectionError) {
          return json(422, {
            error: {
              class: "malformed_application_event",
              offset: error.offset,
              reason: error.message,
            },
          });
        }
        throw error;
      }
    }
    const at = url.searchParams.get("at");
    if (at !== null) {
      if (!isWellFormedOffset(at) || at === OFFSET_BEFORE_FIRST) {
        return failure(400, "invalid_request", "invalid_board_projection_offset");
      }
      await this.issueBoards.materialize(org, repo);
      const snapshot = await this.issueBoards.snapshotAt(org, repo, at as Offset);
      return snapshot === undefined
        ? failure(404, "invalid_request", "board_projection_not_found")
        : canonicalResponse(200, snapshot);
    }
    return canonicalResponse(200, await this.issueBoards.materialize(org, repo));
  }

  /**
   * `GET /api/repos/<org>/<repo>/<branch>/blob/<path>` is a single browser
   * projection. The server joins the metadata commit log with the content
   * sidecar generations before the shared file-content reducer sees it; the
   * browser therefore has one reducer and one authorized transport.
   */
  private async repositoryFileRoute(
    request: Request,
    url: URL,
    org: string,
    repo: string,
    branch: string,
    path: string,
    trustedContext?: AuthorizationContext,
  ): Promise<Response> {
    if (!isAuthzName(org) || !isAuthzName(repo) || !isAuthzName(branch) || !isValidFsPath(path)) {
      return failure(404, "invalid_request", "not_found");
    }
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    const target = repoTargetFromPath(org, repo, branch);
    const live = url.searchParams.get("live") === "1";
    const operation = live ? "follow" : "read";
    let decision: AuthzDecision;
    try {
      decision = await this.decideRepo(
        operation,
        target,
        request.headers.get("authorization"),
        trustedContext,
      );
    } catch (error) {
      if (error instanceof TokenRevokedError)
        return json(401, { error: { class: "token-revoked" } });
      if (error instanceof UnauthorizedError) return failure(401, "unauthorized", error.reason);
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
    if (!decision.allowed) return authzRefusalResponse(decision);
    if (url.searchParams.get("projection") !== "1") {
      return failure(400, "invalid_request", "projection_required");
    }
    const streamId = fileViewStreamId(org, repo, branch, path);
    let reducer: ReturnType<typeof requireReducer>;
    try {
      reducer = requireReducer(url.searchParams.get("reducer") ?? "", streamId);
    } catch {
      return failure(400, "invalid_request", "invalid_reducer");
    }
    const checkpointRaw = live ? url.searchParams.get("checkpoint") : OFFSET_BEFORE_FIRST;
    const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
    if (
      checkpointRaw === null ||
      !isWellFormedOffset(checkpointRaw) ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > MAX_FOLLOW_WAIT_MS
    ) {
      return failure(400, "invalid_request", "invalid_follow_parameters");
    }

    const deadline = Date.now() + (live ? waitMs : 0);
    try {
      let projection = await this.fileProjection(decision.streamId, branch, path, reducer);
      let batch = projection.batch;
      let events = batch.events.filter((event) => compareOffsets(event.offset, checkpointRaw!) > 0);
      while (live && events.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        projection = await this.fileProjection(decision.streamId, branch, path, reducer);
        batch = projection.batch;
        events = batch.events.filter((event) => compareOffsets(event.offset, checkpointRaw!) > 0);
      }
      return json(200, {
        ok: true,
        events,
        checkpoint: events.at(-1)?.offset ?? checkpointRaw,
        reducer: { id: reducer.id, version: reducer.version },
        branch: branchMetadata(
          projection.metadata.name,
          projection.metadata.streamId,
          projection.metadata,
          batch.checkpoint.offset,
        ),
        identityOffset: decision.identityOffset,
        basis: decision.basis,
      });
    } catch (error) {
      if (error instanceof ApplicationProjectionError) {
        return json(422, {
          error: {
            class: "malformed_application_event",
            offset: error.offset,
            reason: error.message,
          },
        });
      }
      throw error;
    }
  }

  private async fileProjection(
    metadataStreamId: string,
    branch: string,
    path: string,
    reducer: ReducerDefinition,
  ): Promise<{ readonly batch: StreamBatch; readonly metadata: BranchProjectionMetadata }> {
    const repository = await this.repositoryProjection(metadataStreamId, branch);
    const metadata = repository.records;
    const contentStreamIds = new Set<string>();
    for (const record of metadata) {
      if (record.type !== "fs.file.create") continue;
      const payload = objectPayload(record.payload, record.offset);
      if (typeof payload.contentStreamId === "string")
        contentStreamIds.add(payload.contentStreamId);
    }
    const contentByStream = new Map<string, readonly FileContentCandidate[]>();
    for (const streamId of contentStreamIds) {
      const records = await this.readTarget(streamId);
      contentByStream.set(
        streamId,
        records.map((record) => contentCandidate(record, streamId)),
      );
    }
    const contentIndexes = new Map<string, number>();
    const pathStreams = new Map<string, string>();
    const expectations = new Map<string, FileContentExpectation>();
    const contentBytes = new Map<string, Uint8Array>();
    const events: StreamRecord[] = [];
    const append = (type: string, payload: unknown, ts: number): void => {
      events.push({ offset: offsetForOrdinal(events.length), type, payload, ts });
    };
    append("file.view.target", { v: 1, path }, 0);

    for (const record of metadata) {
      const payload = objectPayload(record.payload, record.offset);
      if (record.type === "fs.file.create") {
        const filePath = requiredString(payload.path, "path", record.offset);
        const contentStreamId = requiredString(
          payload.contentStreamId,
          "contentStreamId",
          record.offset,
        );
        const previousStream = pathStreams.get(filePath);
        const expected = expectations.get(filePath);
        const nextPayload: Record<string, unknown> = { ...payload };
        if (
          previousStream !== undefined &&
          previousStream !== contentStreamId &&
          expected !== undefined
        ) {
          const candidates = contentByStream.get(contentStreamId) ?? [];
          const consumed = consumeFileContent(
            candidates,
            contentIndexes.get(contentStreamId) ?? 0,
            expected,
            filePath,
            record.offset,
          );
          contentIndexes.set(contentStreamId, consumed.next);
          nextPayload.contentBase64 = consumed.content.contentBase64;
          nextPayload.contentSha256 = expected.digest;
          nextPayload.size = expected.size;
          contentBytes.set(filePath, Buffer.from(consumed.content.contentBase64, "base64"));
        } else if (previousStream === undefined) {
          contentBytes.set(filePath, new Uint8Array());
        }
        pathStreams.set(filePath, contentStreamId);
        append(record.type, nextPayload, record.ts);
        continue;
      }
      if (record.type === "fs.file.write") {
        const filePath = requiredString(payload.path, "path", record.offset);
        const contentStreamId = pathStreams.get(filePath);
        if (contentStreamId === undefined) {
          throw new FileContentProjectionError(
            record.offset,
            `write for ${filePath} precedes create`,
          );
        }
        const expected = {
          digest: requiredString(payload.contentSha256, "contentSha256", record.offset),
          size: requiredSize(payload.size, "size", record.offset),
        };
        const candidates = contentByStream.get(contentStreamId) ?? [];
        const consumed = consumeFileContent(
          candidates,
          contentIndexes.get(contentStreamId) ?? 0,
          expected,
          filePath,
          record.offset,
        );
        contentIndexes.set(contentStreamId, consumed.next);
        expectations.set(filePath, expected);
        contentBytes.set(filePath, Buffer.from(consumed.content.contentBase64, "base64"));
        append(
          record.type,
          { ...payload, contentBase64: consumed.content.contentBase64 },
          record.ts,
        );
        continue;
      }
      if (record.type === "fs.file.patch") {
        const filePath = requiredString(payload.path, "path", record.offset);
        const previous = expectations.get(filePath);
        const baseDigest = requiredString(payload.baseDigest, "baseDigest", record.offset);
        if (previous !== undefined && previous.digest !== baseDigest) {
          throw new FileContentProjectionError(
            record.offset,
            `patch base digest mismatch for ${filePath}`,
          );
        }
        const resultDigest = requiredString(payload.resultDigest, "resultDigest", record.offset);
        let resultSize: number;
        try {
          resultSize = patchResultSize(previous?.size ?? 0, payload.ops as PatchOps);
        } catch (error) {
          throw new FileContentProjectionError(
            record.offset,
            error instanceof Error ? error.message : String(error),
          );
        }
        expectations.set(filePath, { digest: resultDigest, size: resultSize });
        const previousBytes = contentBytes.get(filePath);
        if (previousBytes !== undefined) {
          try {
            const result = applyPatch(previousBytes, payload.ops as PatchOps);
            if (createHash("sha256").update(result).digest("hex") !== resultDigest) {
              throw new Error("patch/result-mismatch");
            }
            contentBytes.set(filePath, result);
          } catch (error) {
            throw new FileContentProjectionError(
              record.offset,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        append(record.type, payload, record.ts);
        continue;
      }
      if (record.type === "fs.rename") {
        const from = requiredString(payload.from, "from", record.offset);
        const to = requiredString(payload.to, "to", record.offset);
        moveFileMap(pathStreams, from, to);
        moveFileMap(expectations, from, to);
        moveFileMap(contentBytes, from, to);
        const materialized = contentBytes.get(path);
        const expected = expectations.get(path);
        if (
          (path === to || path.startsWith(`${to}/`)) &&
          materialized !== undefined &&
          expected !== undefined
        ) {
          append(
            record.type,
            {
              ...payload,
              contentBase64: Buffer.from(materialized).toString("base64"),
              contentSha256: expected.digest,
              size: expected.size,
            },
            record.ts,
          );
          continue;
        }
      } else if (record.type === "fs.file.delete") {
        const filePath = requiredString(payload.path, "path", record.offset);
        pathStreams.delete(filePath);
        expectations.delete(filePath);
        contentBytes.delete(filePath);
      }
      append(record.type, payload, record.ts);
    }
    validateProjectionReducer(reducer, events);
    const checkpoint = events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
    return {
      batch: { events, checkpoint: applicationCheckpoint(checkpoint) },
      metadata: repository.metadata,
    };
  }

  private async repositoryHomeRoute(
    request: Request,
    url: URL,
    org: string,
    repo: string,
    region: RepositoryHomeRegion,
    trustedContext?: AuthorizationContext,
  ): Promise<Response> {
    if (!isAuthzName(org) || !isAuthzName(repo)) {
      return failure(404, "invalid_request", "not_found");
    }
    let branch = "main";
    if (request.method === "POST") {
      if (region !== "branches") {
        return failure(405, "invalid_request", "method_not_allowed");
      }
      try {
        const value = (await request.json()) as { readonly name?: unknown };
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Reflect.ownKeys(value).length !== 1 ||
          typeof value.name !== "string"
        ) {
          return failure(400, "invalid_request", "invalid_branch_registration");
        }
        branch = value.name;
      } catch {
        return failure(400, "invalid_request", "invalid_branch_registration");
      }
    } else if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }

    const target = repoTargetFromPath(org, repo, branch);
    const live = request.method === "GET" && url.searchParams.get("live") === "1";
    const operation = request.method === "POST" ? "dispatch" : live ? "follow" : "read";
    let decision: AuthzDecision;
    try {
      decision = await this.decideRepo(
        operation,
        target,
        request.headers.get("authorization"),
        trustedContext,
      );
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
    if (!decision.allowed) return authzRefusalResponse(decision);

    if (request.method === "POST") {
      try {
        await this.repositoryHomes.registerNativeBranch(org, repo, branch);
        return json(202, { ok: true, branch, identityOffset: decision.identityOffset });
      } catch (error) {
        if (error instanceof RepositoryHomeNativeForkError) {
          return json(409, { error: { class: "validator-rejected", reason: error.message } });
        }
        if (error instanceof RepositoryHomeCorruptError || error instanceof TypeError) {
          return json(422, { error: { class: "malformed_application_event" } });
        }
        throw error;
      }
    }

    if (url.searchParams.get("projection") !== "1") {
      return failure(400, "invalid_request", "projection_required");
    }
    const streamId = `repo-home:${org}/${repo}:${region}`;
    let reducer: ReturnType<typeof requireReducer>;
    try {
      reducer = requireReducer(url.searchParams.get("reducer") ?? "", streamId);
    } catch {
      return failure(400, "invalid_request", "invalid_reducer");
    }
    const namespace = await this.namespaceViewFor(org);
    const project = namespace.orgs[org]?.repos[repo]?.project;
    if (project === undefined)
      return authzRefusalResponse({
        allowed: false,
        operation,
        identityOffset: decision.identityOffset,
        refusal: "authz/not-found",
      });

    try {
      // Idempotent derived-stream repair makes repository creation durable
      // across the namespace append -> catalog initialization boundary.
      await this.repositoryHomes.ensureRepository(org, repo, project);
      const checkpointRaw = live ? url.searchParams.get("checkpoint") : OFFSET_BEFORE_FIRST;
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (
        checkpointRaw === null ||
        !isWellFormedOffset(checkpointRaw) ||
        !Number.isSafeInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > MAX_FOLLOW_WAIT_MS
      ) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const deadline = Date.now() + (live ? waitMs : 0);
      let batch = await this.repositoryHomes.projection(namespace, org, repo, region);
      let events = (batch.events as readonly StreamRecord[]).filter(
        (event) => compareOffsets(event.offset, checkpointRaw) > 0,
      );
      while (live && events.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        const currentNamespace = await this.namespaceViewFor(org);
        batch = await this.repositoryHomes.projection(currentNamespace, org, repo, region);
        events = (batch.events as readonly StreamRecord[]).filter(
          (event) => compareOffsets(event.offset, checkpointRaw) > 0,
        );
      }
      return json(200, {
        ok: true,
        events,
        checkpoint: events.at(-1)?.offset ?? checkpointRaw,
        reducer: { id: reducer.id, version: reducer.version },
        identityOffset: decision.identityOffset,
        basis: decision.basis,
      });
    } catch (error) {
      if (error instanceof RepositoryHomeCorruptError) {
        return json(422, {
          error: {
            class: "malformed_application_event",
            region: error.region,
            reason: error.message,
          },
        });
      }
      throw error;
    }
  }

  private async readTarget(streamId: string): Promise<readonly unknown[]> {
    try {
      return await this.streams.read(streamId);
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }

  private historyRecords(streamId: string, values: readonly unknown[]): readonly StreamRecord[] {
    const records: StreamRecord[] = [];
    let previous = OFFSET_BEFORE_FIRST;
    for (const value of values) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ApplicationProjectionError(
          previous,
          `history record on ${streamId} is not an object`,
        );
      }
      const candidate = value as Record<string, unknown>;
      const offset = candidate.offset;
      if (
        typeof offset !== "string" ||
        !isWellFormedOffset(offset) ||
        offset === OFFSET_BEFORE_FIRST
      ) {
        throw new ApplicationProjectionError(
          String(offset ?? previous),
          `history record on ${streamId} has an invalid native offset`,
        );
      }
      if (compareOffsets(offset, previous) <= 0) {
        throw new ApplicationProjectionError(
          offset,
          `history record on ${streamId} is out of native offset order`,
        );
      }
      let expected: Offset;
      try {
        expected = nextAllocatedOffset(previous);
      } catch {
        throw new ApplicationProjectionError(
          previous,
          `history record on ${streamId} has an invalid prior native offset`,
        );
      }
      if (offset !== expected) {
        throw new ApplicationProjectionError(
          expected,
          `history record on ${streamId} is missing a native event before ${offset}`,
        );
      }
      if (
        !Object.prototype.hasOwnProperty.call(candidate, "payload") ||
        candidate.payload === undefined
      ) {
        throw new ApplicationProjectionError(
          offset,
          `history record on ${streamId} has no payload`,
        );
      }
      const event = { type: candidate.type, payload: candidate.payload, ts: candidate.ts };
      if (!isEvent(event)) {
        throw new ApplicationProjectionError(
          offset,
          `history record on ${streamId} is not an event`,
        );
      }
      const payload =
        event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : undefined;
      const supportedFsVersion =
        (event.type === "fs.branch.genesis" && payload?.v === 1) ||
        (event.type === "fs.branch.fork" && payload?.v === 1) ||
        (event.type === "fs.branch.merge" && (payload?.v === 1 || payload?.v === 2)) ||
        ((event.type === "fs.file.create" ||
          event.type === "fs.file.write" ||
          event.type === "fs.file.patch" ||
          event.type === "fs.file.delete" ||
          event.type === "fs.dir.create" ||
          event.type === "fs.dir.remove" ||
          event.type === "fs.rename") &&
          payload?.v === 2);
      const validationEvent = stripWriterMetadata({ offset, ...event });
      if (
        supportedFsVersion &&
        !isFsEvent({
          type: validationEvent.type,
          payload: validationEvent.payload,
          ts: validationEvent.ts,
        })
      ) {
        throw new ApplicationProjectionError(
          offset,
          `history record on ${streamId} has an invalid supported StreamFS payload`,
        );
      }
      records.push({ offset, ...event });
      previous = offset;
    }
    try {
      reduceWriterLanes(records);
    } catch (error) {
      if (error instanceof WriterLaneCorruptionError) {
        const record = records[error.index];
        throw new ApplicationProjectionError(
          record?.offset ?? previous,
          `history record on ${streamId} has corrupt writer metadata`,
        );
      }
      throw error;
    }
    return records;
  }

  /**
   * Materialize a logical StreamFS branch from its native fork chain. The
   * transport stream only carries the fork directive plus branch-local
   * events; inherited parent records are resolved here and rebased into one
   * contiguous application-offset space for the browser reducer.
   */
  private async repositoryProjection(
    streamId: string,
    branch: string,
  ): Promise<RepositoryProjection> {
    const leaf = branchLocalSegment((await this.readTarget(streamId)) as readonly StreamRecord[]);
    const initialFork = branchFork(leaf[0]);
    const initialGenesis = branchGenesis(leaf[0]);
    const baseMetadata = {
      parentStreamId: null,
      forkCheckpoint: OFFSET_BEFORE_FIRST,
      ancestry: [],
    } satisfies Omit<BranchProjectionMetadata, "name" | "streamId">;
    if (initialFork === undefined) {
      if (branch !== "main" && leaf.length > 0 && initialGenesis?.payload.branch !== branch) {
        throw new ApplicationProjectionError(
          OFFSET_BEFORE_FIRST,
          `branch ${branch} is missing its first fs.branch.fork directive`,
        );
      }
      return {
        records: projectionRecords(leaf, OFFSET_BEFORE_FIRST),
        metadata: { name: branch, streamId, ...baseMetadata },
      };
    }

    const dumps: BranchDump[] = [];
    const ancestry: {
      readonly streamId: string;
      readonly parentStreamId: string;
      readonly forkCheckpoint: Offset;
    }[] = [];
    const visited = new Set<string>();
    let currentStreamId = streamId;
    let currentRecords: readonly StreamRecord[] = leaf;
    while (true) {
      if (visited.has(currentStreamId)) {
        throw new ApplicationProjectionError(
          OFFSET_BEFORE_FIRST,
          `branch fork chain repeats ${currentStreamId}`,
        );
      }
      visited.add(currentStreamId);
      dumps.push({
        streamId: currentStreamId,
        records: currentRecords.map(stripWriterMetadata),
      });
      const fork = branchFork(currentRecords[0]);
      if (fork === undefined) break;
      ancestry.push({
        streamId: currentStreamId,
        parentStreamId: fork.payload.parentStreamId,
        forkCheckpoint: fork.payload.forkOffset,
      });
      currentStreamId = fork.payload.parentStreamId;
      currentRecords = branchLocalSegment(
        (await this.readTarget(currentStreamId)) as readonly StreamRecord[],
      );
    }

    let resolved: readonly StreamRecord[];
    try {
      resolved = resolveBranchLog(dumps);
    } catch (error) {
      throw new ApplicationProjectionError(
        initialFork.payload.forkOffset,
        error instanceof Error ? error.message : String(error),
      );
    }
    const records = resolved.map((record, ordinal) => ({
      ...record,
      offset: offsetForOrdinal(ordinal),
    }));
    return {
      records,
      metadata: {
        name: branch,
        streamId,
        parentStreamId: initialFork.payload.parentStreamId,
        forkCheckpoint: initialFork.payload.forkOffset,
        ancestry,
      },
    };
  }

  /**
   * Materialize the complete canonical event history for a branch. Unlike the
   * reducer projection above, this keeps the native fork directive and the
   * server-stamped writer actor, then assigns one contiguous logical offset
   * space so inherited and branch-local records have a total order.
   */
  private async repositoryHistory(
    streamId: string,
    branch: string,
    visited = new Set<string>(),
    requireFork = branch !== "main",
  ): Promise<RepositoryHistory> {
    if (visited.has(streamId)) {
      throw new ApplicationProjectionError(
        OFFSET_BEFORE_FIRST,
        `branch history repeats ${streamId}`,
      );
    }
    const nextVisited = new Set(visited);
    nextVisited.add(streamId);
    const raw = this.historyRecords(
      streamId,
      branchLocalSegment((await this.readTarget(streamId)) as readonly StreamRecord[]),
    );
    const repeatedFork = raw.slice(1).find((record) => branchFork(record) !== undefined);
    if (repeatedFork !== undefined) {
      throw new ApplicationProjectionError(
        repeatedFork.offset,
        `branch history has a repeated fs.branch.fork directive at ${repeatedFork.offset}`,
      );
    }
    const firstFork = branchFork(raw[0]);
    const firstGenesis = branchGenesis(raw[0]);
    const metadataBase = {
      parentStreamId: null,
      forkCheckpoint: OFFSET_BEFORE_FIRST,
      ancestry: [],
    } satisfies Omit<BranchProjectionMetadata, "name" | "streamId">;
    if (firstFork === undefined) {
      if (requireFork && raw.length > 0 && firstGenesis?.payload.branch !== branch) {
        throw new ApplicationProjectionError(
          OFFSET_BEFORE_FIRST,
          `branch ${branch} is missing its first fs.branch.fork directive`,
        );
      }
      return {
        records: raw.map((record) => ({
          ...record,
          sourceStreamId: streamId,
          actor: stampedActor(record),
          nativeOffset: record.offset,
        })),
        metadata: { name: branch, streamId, ...metadataBase },
      };
    }

    const parent = await this.repositoryHistory(
      firstFork.payload.parentStreamId,
      "parent",
      nextVisited,
      false,
    );
    const forkIndex = parent.records.findIndex(
      (record) =>
        record.sourceStreamId === firstFork.payload.parentStreamId &&
        record.nativeOffset === firstFork.payload.forkOffset,
    );
    if (forkIndex < 0) {
      throw new ApplicationProjectionError(
        firstFork.payload.forkOffset,
        `fork offset ${firstFork.payload.forkOffset} is not present in parent ${firstFork.payload.parentStreamId}`,
      );
    }
    const local = raw.map((record) => ({
      ...record,
      sourceStreamId: streamId,
      actor: stampedActor(record),
      nativeOffset: record.offset,
    }));
    const records = [...parent.records.slice(0, forkIndex + 1), ...local];
    return {
      records,
      metadata: {
        name: branch,
        streamId,
        parentStreamId: firstFork.payload.parentStreamId,
        forkCheckpoint: firstFork.payload.forkOffset,
        ancestry: [
          {
            streamId,
            parentStreamId: firstFork.payload.parentStreamId,
            forkCheckpoint: firstFork.payload.forkOffset,
          },
          ...parent.metadata.ancestry,
        ],
      },
    };
  }

  private async historyProjection(
    streamId: string,
    branch: string,
  ): Promise<{
    readonly records: readonly HistoryProjectionRecord[];
    readonly metadata: BranchProjectionMetadata;
  }> {
    const history = await this.repositoryHistory(streamId, branch);
    return {
      records: history.records.map((record, ordinal) => ({
        ...record,
        offset: offsetForOrdinal(ordinal),
      })),
      metadata: history.metadata,
    };
  }

  private async followHistoryProjection(
    streamId: string,
    branch: string,
    from: StreamCheckpoint,
    waitMs: number,
  ): Promise<{
    readonly batch: StreamBatch;
    readonly metadata: BranchProjectionMetadata;
  }> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const projection = await this.historyProjection(streamId, branch);
      const events = projection.records.filter(
        (event) => compareOffsets(event.offset, from.offset) > 0,
      );
      if (events.length > 0 || Date.now() >= deadline || waitMs === 0) {
        return {
          batch: {
            events: events.map(publicHistoryRecord),
            checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? from.offset),
          },
          metadata: projection.metadata,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  }

  private async followRepositoryProjection(
    streamId: string,
    branch: string,
    from: StreamCheckpoint,
    waitMs: number,
  ): Promise<{
    readonly batch: StreamBatch;
    readonly metadata: BranchProjectionMetadata;
  }> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const repository = await this.repositoryProjection(streamId, branch);
      const events = repository.records.filter(
        (event) => compareOffsets(event.offset, from.offset) > 0,
      );
      if (events.length > 0 || Date.now() >= deadline || waitMs === 0) {
        return {
          batch: {
            events,
            checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? from.offset),
          },
          metadata: repository.metadata,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  }

  private async bootstrapProjection(streamId: string): Promise<StreamBatch> {
    try {
      if (this.streams.applicationBootstrap !== undefined) {
        const batch = await this.streams.applicationBootstrap(streamId);
        const events = projectionRecords(batch.events, OFFSET_BEFORE_FIRST);
        const expected = events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
        if (batch.checkpoint.offset !== expected) {
          throw new ApplicationProjectionError(
            batch.checkpoint.offset,
            "bootstrap checkpoint does not match final event",
          );
        }
        return { events, checkpoint: applicationCheckpoint(expected) };
      }
      const events = projectionRecords(await this.readTarget(streamId), OFFSET_BEFORE_FIRST);
      return {
        events,
        checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST),
      };
    } catch (error) {
      if (isDurableNotFound(error)) {
        return { events: [], checkpoint: applicationCheckpoint(OFFSET_BEFORE_FIRST) };
      }
      throw error;
    }
  }

  private async followProjection(
    streamId: string,
    from: StreamCheckpoint,
    waitMs: number,
  ): Promise<StreamBatch> {
    const signal = AbortSignal.timeout(waitMs);
    try {
      if (this.streams.applicationFollow !== undefined) {
        for await (const batch of this.streams.applicationFollow(streamId, from, signal)) {
          const events = projectionRecords(batch.events, from.offset);
          const expected = events.at(-1)?.offset ?? from.offset;
          if (batch.checkpoint.offset !== expected) {
            throw new ApplicationProjectionError(
              batch.checkpoint.offset,
              "follow checkpoint does not match final event",
            );
          }
          return { events, checkpoint: applicationCheckpoint(expected) };
        }
        return { events: [], checkpoint: from };
      }
      const items: unknown[] = [];
      for await (const item of this.streams.follow(streamId, signal)) items.push(item);
      const all = projectionRecords(items, OFFSET_BEFORE_FIRST);
      const events = all.filter((event) => compareOffsets(event.offset, from.offset) > 0);
      return {
        events,
        checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? from.offset),
      };
    } catch (error) {
      if (isDurableNotFound(error)) return { events: [], checkpoint: from };
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return { events: [], checkpoint: from };
      }
      throw error;
    }
  }

  /** Long-poll: the first item past `after`, or empty after `waitMs`. */
  private async followTarget(
    streamId: string,
    after: number,
    waitMs: number,
  ): Promise<readonly unknown[]> {
    const signal = AbortSignal.timeout(waitMs);
    const items: unknown[] = [];
    let index = 0;
    try {
      for await (const item of this.streams.follow(streamId, signal)) {
        index += 1;
        if (index <= after) continue;
        items.push(item);
        break;
      }
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return items;
      }
      throw error;
    }
    return items;
  }
}

export function createPlatformHandler(
  options: PlatformGatewayOptions,
): (request: Request) => Promise<Response> {
  const gateway = new PlatformGateway(options);
  return (request) => gateway.handle(request);
}
