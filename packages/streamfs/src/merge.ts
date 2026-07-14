import { isFsBranchForkEvent } from "./events.js";
import type { StreamFsRepo } from "./fs.js";

function lastForkIndex(records: Awaited<ReturnType<StreamFsRepo["dump"]>>): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (isFsBranchForkEvent({ type: record.type, payload: record.payload, ts: record.ts })) {
      return index;
    }
  }
  return -1;
}

export interface FastForwardMergeReceipt {
  readonly mergeOffset: string;
  readonly mergedThroughOffset: string;
  readonly treeDigest: string;
}

/** Append one adoption event after the server validates the fast-forward. */
export async function mergeFastForward(
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<FastForwardMergeReceipt> {
  const sourceDump = await source.dump();
  const forkIndex = lastForkIndex(sourceDump);
  const forkRecord = forkIndex < 0 ? undefined : sourceDump[forkIndex];
  const forkEvent =
    forkRecord === undefined
      ? undefined
      : { type: forkRecord.type, payload: forkRecord.payload, ts: forkRecord.ts };
  if (forkRecord === undefined || forkEvent === undefined || !isFsBranchForkEvent(forkEvent)) {
    throw new Error("source stream is not a branch");
  }
  const sourcePostFork = sourceDump.slice(forkIndex + 1);
  const mergedThroughOffset =
    sourcePostFork.length === 0 ? forkEvent.payload.forkOffset : sourcePostFork.at(-1)!.offset;
  const receipt = await target.dispatchToStream(target.metadataStreamId, {
    type: "fs.branch.merge",
    payload: {
      v: 1,
      sourceStreamId: source.metadataStreamId,
      forkOffset: forkEvent.payload.forkOffset,
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
