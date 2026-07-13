import { canonicalJson, compareOffsets, type Event, type Offset } from "@eforest/protocol";
import type { StreamRecord } from "@eforest/server";
import { isFsBranchForkEvent, isFsEvent, type FsBranchForkEvent } from "./events.js";

/** A raw metadata dump and, when available, the id of the stream it came from. */
export interface BranchDump {
  readonly streamId?: string;
  readonly records: readonly StreamRecord[];
}

/** The array form is convenient for pure callers and the object form preserves ids. */
export type Dump = BranchDump | readonly StreamRecord[];

function isBranchDump(value: Dump): value is BranchDump {
  return !Array.isArray(value) && value !== null && typeof value === "object";
}

export class BranchResolutionError extends Error {
  readonly code:
    | "branch/malformed-dump"
    | "branch/missing-parent"
    | "branch/parent-mismatch"
    | "branch/fork-offset-out-of-range"
    | "branch/fork-not-first"
    | "branch/cycle";

  constructor(code: BranchResolutionError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "BranchResolutionError";
    this.code = code;
  }
}

function recordsOf(dump: Dump): readonly StreamRecord[] {
  if (Array.isArray(dump)) return dump;
  if (isBranchDump(dump) && Array.isArray(dump.records)) {
    return dump.records;
  }
  throw new BranchResolutionError("branch/malformed-dump", "dump has no records array");
}

function eventOf(record: StreamRecord): Event {
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  if (!isFsEvent(event)) {
    throw new BranchResolutionError(
      "branch/malformed-dump",
      `record at ${String(record.offset)} is not a valid fs event`,
    );
  }
  return event;
}

function hasOffset(records: readonly StreamRecord[], offset: Offset): boolean {
  return records.some((record) => record.offset === offset);
}

function cut(records: readonly StreamRecord[], until: Offset | undefined): StreamRecord[] {
  if (until === undefined) return [...records];
  return records.filter((record) => compareOffsets(record.offset, until) <= 0);
}

interface Link {
  readonly records: readonly StreamRecord[];
  readonly fork?: FsBranchForkEvent;
}

function inspectDump(dump: Dump, index: number): Link {
  const records = recordsOf(dump);
  if (records.length === 0) {
    throw new BranchResolutionError("branch/malformed-dump", `dump ${index + 1} is empty`);
  }
  for (const record of records) eventOf(record);
  const first = eventOf(records[0]!);
  if (isFsBranchForkEvent(first)) {
    for (const record of records.slice(1)) {
      if (eventOf(record).type === "fs.branch.fork") {
        throw new BranchResolutionError(
          "branch/fork-not-first",
          `fs.branch.fork appears again at ${String(record.offset)}`,
        );
      }
    }
    return { records, fork: first };
  }
  if (records.some((record) => eventOf(record).type === "fs.branch.fork")) {
    throw new BranchResolutionError(
      "branch/fork-not-first",
      "fs.branch.fork must be the first event of a branch dump",
    );
  }
  return { records };
}

function checkStreamId(dump: Dump, expected: string, index: number): void {
  if (isBranchDump(dump) && dump.streamId !== undefined && dump.streamId !== expected) {
    throw new BranchResolutionError(
      "branch/parent-mismatch",
      `dump ${index + 1} is ${dump.streamId}, expected ${expected}`,
    );
  }
}

function resolveNode(
  links: readonly Link[],
  dumps: readonly Dump[],
  index: number,
  until: Offset | undefined,
  untilIsLinkForkSpace: boolean,
  expectedStreamIds: ReadonlyMap<number, string>,
  visiting: ReadonlySet<string>,
): StreamRecord[] {
  const link = links[index];
  if (link === undefined) {
    throw new BranchResolutionError(
      "branch/missing-parent",
      "fork chain ended without a root dump",
    );
  }
  const expected = expectedStreamIds.get(index);
  if (expected !== undefined) checkStreamId(dumps[index]!, expected, index);
  const streamKey = expected ?? `dump:${index}`;
  if (visiting.has(streamKey)) {
    throw new BranchResolutionError("branch/cycle", `fork chain repeats ${streamKey}`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(streamKey);
  if (link.fork === undefined) {
    if (index !== links.length - 1) {
      throw new BranchResolutionError(
        "branch/parent-mismatch",
        "a root dump was supplied before the end of the parent list",
      );
    }
    return cut(link.records, until);
  }

  if (index === links.length - 1) {
    throw new BranchResolutionError(
      "branch/missing-parent",
      `parent ${link.fork.payload.parentStreamId} was not supplied`,
    );
  }
  const parentRecords = links[index + 1]!.records;
  if (!hasOffset(parentRecords, link.fork.payload.forkOffset)) {
    throw new BranchResolutionError(
      "branch/fork-offset-out-of-range",
      `fork offset ${link.fork.payload.forkOffset} is not present in parent ${link.fork.payload.parentStreamId}`,
    );
  }

  // Compare `until` with the fork offset only in the leaf segment's offset
  // space. Once the segment containing the cut is known, the parent is capped
  // by either its own fork offset or the requested prefix token; never order
  // an offset from one stream against an offset from another stream.
  // At the leaf, the CLI's `until` is compared with that link's frozen parent
  // offset. During a recursive walk, however, `until` is already an offset in
  // the immediate parent segment (for example, a feature-stream offset while
  // resolving a nested branch). Never compare that token with the parent's own
  // fork offset, which lives in the grandparent's offset space.
  const parentUntil =
    untilIsLinkForkSpace &&
    until !== undefined &&
    compareOffsets(until, link.fork.payload.forkOffset) <= 0
      ? until
      : link.fork.payload.forkOffset;
  const parent = resolveNode(
    links,
    dumps,
    index + 1,
    parentUntil,
    false,
    expectedStreamIds,
    nextVisiting,
  );
  const branchRecords =
    until === undefined
      ? link.records.slice(1)
      : untilIsLinkForkSpace
        ? compareOffsets(until, link.fork.payload.forkOffset) > 0
          ? cut(link.records.slice(1), until)
          : []
        : cut(link.records.slice(1), until);
  return [...parent, ...branchRecords];
}

/**
 * Resolve a leaf dump followed by its immediate parent, grandparent, and so on.
 * Fork directives are consumed, never passed to the fs reducer. The optional
 * `until` cut is applied in each segment's own offset space.
 */
export function resolveBranchLog(dumps: readonly Dump[], until?: Offset): readonly StreamRecord[] {
  if (dumps.length === 0) {
    throw new BranchResolutionError("branch/malformed-dump", "at least one dump is required");
  }
  const links = dumps.map((dump, index) => inspectDump(dump, index));
  const expectedStreamIds = new Map<number, string>();
  for (let index = 0; index < links.length - 1; index += 1) {
    const fork = links[index]!.fork;
    if (fork !== undefined) expectedStreamIds.set(index + 1, fork.payload.parentStreamId);
  }
  const resolved = resolveNode(links, dumps, 0, until, true, expectedStreamIds, new Set());
  return resolved.map((record) => ({
    offset: record.offset,
    type: record.type,
    payload: JSON.parse(canonicalJson(record.payload)) as Event["payload"],
    ts: record.ts,
  }));
}
