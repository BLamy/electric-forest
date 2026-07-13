import { canonicalJson } from "@eforest/protocol";
import { createSnapshot, type SnapshotReceipt, type SnapshotRoot } from "@eforest/streamfs";

function rootFromUrl(value: string): SnapshotRoot {
  const url = new URL(value);
  const parts = url.pathname.split("/");
  if (parts.length !== 3 || parts[1] !== "streams" || !parts[2]) {
    throw new Error("snapshot URL must be a stream URL like http://host/streams/<id>");
  }
  return {
    baseUrl: url.origin,
    metadataStreamId: decodeURIComponent(parts[2]),
    fetcher: fetch,
  };
}

export async function snapshotStreamUrl(value: string): Promise<SnapshotReceipt> {
  return createSnapshot(rootFromUrl(value));
}

export function snapshotOutput(receipt: SnapshotReceipt): string {
  return canonicalJson({
    snapshotOffset: receipt.snapshotOffset,
    stateDigest: receipt.stateDigest,
  });
}
