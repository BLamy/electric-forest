import { isFsBranchForkEvent } from "./events.js";
import type { StreamFsRepo } from "./fs.js";

export interface FastForwardMergeReceipt {
  readonly mergeOffset: string;
  readonly mergedThroughOffset: string;
  readonly treeDigest: string;
}

/** Append one adoption event after the server validates the fast-forward. */
export async function mergeFastForward(
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<FastForwardMergeReceipt>;
/** Compatibility form matching the roadmap's repo, target, source wording. */
export async function mergeFastForward(
  repo: unknown,
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<FastForwardMergeReceipt>;
export async function mergeFastForward(
  first: StreamFsRepo | unknown,
  second: StreamFsRepo,
  third?: StreamFsRepo,
): Promise<FastForwardMergeReceipt> {
  const target = third === undefined ? (first as StreamFsRepo) : second;
  const source = third === undefined ? second : third;
  const sourceDump = await source.dump();
  const firstRecord = sourceDump[0];
  const firstEvent =
    firstRecord === undefined
      ? undefined
      : { type: firstRecord.type, payload: firstRecord.payload, ts: firstRecord.ts };
  if (firstRecord === undefined || firstEvent === undefined || !isFsBranchForkEvent(firstEvent)) {
    throw new Error("source stream is not a branch");
  }
  const mergedThroughOffset =
    sourceDump.length === 1 ? firstEvent.payload.forkOffset : sourceDump.at(-1)!.offset;
  const receipt = await target.dispatchToStream(target.metadataStreamId, {
    type: "fs.branch.merge",
    payload: {
      v: 1,
      sourceStreamId: source.metadataStreamId,
      forkOffset: firstEvent.payload.forkOffset,
      mergedThroughOffset,
    },
    ts: target.now(),
  });
  return {
    mergeOffset: receipt.event.offset,
    mergedThroughOffset,
    treeDigest: await target.digest(),
  };
}
