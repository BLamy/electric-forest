import { canonicalJson } from "@eforest/protocol";
import { StreamFsRepo, type SnapshotReceipt } from "@eforest/streamfs";

function repoFromStreamUrl(value: string): StreamFsRepo {
  const url = new URL(value);
  const match = /^\/streams\/([^/]+)$/.exec(url.pathname);
  if (!match) throw new Error("snapshot URL must point to /streams/<stream-id>");
  const streamId = decodeURIComponent(match[1]!);
  const streamMatch = /^fs:(.+):([a-z0-9][a-z0-9-]{0,63}):meta$/.exec(streamId);
  if (!streamMatch) throw new Error("snapshot URL must identify a StreamFS metadata stream");
  return new StreamFsRepo(url.origin, fetch, streamMatch[1]!, streamMatch[2]!);
}

export async function snapshotStreamUrl(value: string): Promise<SnapshotReceipt> {
  return repoFromStreamUrl(value).createSnapshot();
}

export function snapshotOutput(receipt: SnapshotReceipt): string {
  return canonicalJson({
    snapshotOffset: receipt.snapshotOffset,
    stateDigest: receipt.stateDigest,
  });
}
