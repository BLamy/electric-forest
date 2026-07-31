import { canonicalJson, sha256Hex } from "@eforest/protocol";
import type { FsMergeChange, FsMergeConflictPayload, FsMergeRevisionRef } from "./events.js";

export type FsMergeConflictIdentity = Omit<FsMergeConflictPayload, "v" | "mergeId">;

export interface FsMergePlanIdentity {
  readonly base: FsMergeRevisionRef;
  readonly target: FsMergeRevisionRef;
  readonly source: FsMergeRevisionRef;
  readonly changes: readonly FsMergeChange[];
  readonly conflicts: readonly FsMergeConflictIdentity[];
}

export function conflictIdentity(conflict: FsMergeConflictPayload): FsMergeConflictIdentity {
  return {
    path: conflict.path,
    kind: conflict.kind,
    reason: conflict.reason,
    base: conflict.base,
    target: conflict.target,
    source: conflict.source,
  };
}

export function mergePlanId(identity: FsMergePlanIdentity): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(identity)));
}

export function sameRevision(left: FsMergeRevisionRef, right: FsMergeRevisionRef): boolean {
  return (
    left.streamId === right.streamId &&
    left.offset === right.offset &&
    left.treeDigest === right.treeDigest
  );
}
