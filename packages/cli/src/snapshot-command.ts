import { canonicalJson, type Offset } from "@eforest/protocol";
import {
  createSnapshot,
  FS_EVENT_VERSION,
  type SnapshotReceipt,
  type SnapshotRoot,
} from "@eforest/streamfs";

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
    dispatchSnapshot: async (event) => {
      const response = await fetch(`${url.origin}/streams/${parts[2]}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalJson(event),
      });
      const body = (await response.json()) as {
        event?: { readonly offset?: unknown };
        error?: unknown;
      };
      if (!response.ok) {
        throw new Error(`snapshot event dispatch failed with HTTP ${response.status}`);
      }
      if (typeof body.event?.offset !== "string") {
        throw new Error("snapshot dispatch omitted its offset");
      }
      return { event: { offset: body.event.offset as Offset } };
    },
    writeContent: async (streamId, bytes) => {
      const streamUrl = `${url.origin}/streams/${encodeURIComponent(streamId)}`;
      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: canonicalJson({
          type: "fs-file-content",
          version: `fs-v${FS_EVENT_VERSION}`,
        }),
      });
      if (!create.ok && create.status !== 200) {
        throw new Error(`snapshot content stream create failed with HTTP ${create.status}`);
      }
      const event = {
        type: "fs.file.content",
        payload: {
          v: FS_EVENT_VERSION,
          contentStreamId: streamId,
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
        ts: Date.now(),
      };
      const append = await fetch(streamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: canonicalJson({ events: [event] }),
      });
      if (!append.ok) throw new Error(`snapshot content append failed with HTTP ${append.status}`);
    },
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
