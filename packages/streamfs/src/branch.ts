import type { Offset } from "@eforest/protocol";
import type { StreamFsRepo } from "./fs.js";
import type { FsTree } from "./tree.js";
import { BRANCH_EVENT_VERSION, FS_EVENT_VERSION } from "./version.js";

export { BRANCH_EVENT_VERSION };

export const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_BRANCH_NAMES = new Set(["main", "meta", "file"]);

export interface BranchInfo {
  readonly parentStreamId: string;
  readonly forkOffset: Offset;
}

export interface CreateBranchOptions {
  readonly at?: Offset;
}

export interface CreateBranchResult {
  readonly streamId: string;
  readonly forkOffset: Offset;
}

export function isBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH_NAME_PATTERN.test(value) &&
    !RESERVED_BRANCH_NAMES.has(value)
  );
}

export function branchMetadataStreamId(repoName: string, branch: string): string {
  return `fs:${repoName}:${branch}:meta`;
}

export function branchContentStreamPrefix(repoName: string, branch: string): string {
  return `fs:${repoName}:${branch}:file:`;
}

export function isBranchContentStreamId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("fs:")) return false;
  const match = /^fs:(.*):([a-z0-9][a-z0-9-]{0,63}):file:[^:]+$/.exec(value);
  return match !== null && match[2] !== "main" && !RESERVED_BRANCH_NAMES.has(match[2]!);
}

const branchStates = new WeakMap<object, BranchInfo>();

export function markBranchState<T extends FsTree>(state: T, info: BranchInfo): T {
  branchStates.set(state, info);
  return state;
}

/** Return the immutable fork directive associated with a resolved tree state. */
export function resolveBranch(state: unknown): BranchInfo | undefined {
  if (state !== null && typeof state === "object") {
    const hidden = branchStates.get(state);
    if (hidden !== undefined) return hidden;
    const candidate = state as Record<string, unknown>;
    if (typeof candidate.parentStreamId === "string" && typeof candidate.forkOffset === "string") {
      return {
        parentStreamId: candidate.parentStreamId,
        forkOffset: candidate.forkOffset as Offset,
      };
    }
  }
  return undefined;
}

interface BranchRepoInternals {
  readonly name: string;
  readonly metadataStreamId: string;
  now(): number;
  dump(): Promise<readonly { readonly offset: Offset }[]>;
  createForkStream(
    streamId: string,
    parentStreamId: string,
    forkOffset: Offset,
    config: unknown,
  ): Promise<void>;
  dispatchToStream(
    streamId: string,
    event: {
      readonly type: "fs.branch.fork";
      readonly payload: {
        readonly v: 1;
        readonly parentStreamId: string;
        readonly forkOffset: Offset;
      };
      readonly ts: number;
    },
  ): Promise<{ readonly offset: Offset }>;
}

/** Create one branch metadata stream and append its single fork directive. */
export async function createBranch(
  repo: StreamFsRepo,
  branch: string,
  options: CreateBranchOptions = {},
): Promise<CreateBranchResult> {
  if (!isBranchName(branch)) {
    throw new TypeError(`invalid branch name ${JSON.stringify(branch)}`);
  }
  const target = repo as unknown as BranchRepoInternals;
  const parentRecords = await target.dump();
  const currentHead = parentRecords.at(-1)?.offset;
  const forkOffset = options.at ?? currentHead ?? ("-1" as Offset);
  const streamId = branchMetadataStreamId(target.name, branch);
  await target.createForkStream(streamId, target.metadataStreamId, forkOffset, {
    type: "fs-meta",
    // Branch directives have their own v1 payload, but the stream carries the
    // current fs envelope so the ordinary state/reducer routes remain valid.
    version: `fs-v${FS_EVENT_VERSION}`,
  });
  await target.dispatchToStream(streamId, {
    type: "fs.branch.fork",
    payload: {
      v: BRANCH_EVENT_VERSION,
      parentStreamId: target.metadataStreamId,
      forkOffset,
    },
    ts: target.now(),
  });
  return { streamId, forkOffset };
}
