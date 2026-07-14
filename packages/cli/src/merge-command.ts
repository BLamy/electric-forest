import { canonicalJson } from "@eforest/protocol";
import {
  fsInitialState,
  fsReducer,
  isFsBranchForkEvent,
  resolveBranchLog,
  treeDigest,
  type BranchDump,
  type MergeDump,
} from "@eforest/streamfs";

export class MergeCliError extends Error {
  readonly body: unknown;

  constructor(message: string, body?: unknown) {
    super(message);
    this.name = "MergeCliError";
    this.body = body;
  }
}

function streamId(url: string): string {
  const parsed = new URL(url);
  const match = /^\/streams\/([^/]+)$/.exec(parsed.pathname);
  if (!match) throw new MergeCliError("merge URLs must point to /streams/<stream-id>");
  return decodeURIComponent(match[1]!);
}

async function dump(url: string): Promise<readonly Record<string, unknown>[]> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/dump`);
  const text = await response.text();
  if (!response.ok) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    throw new MergeCliError(`merge dump failed with HTTP ${response.status}`, body);
  }
  if (text.length === 0) return [];
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function runMergeCommand(
  targetUrl: string,
  sourceUrl: string,
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
): Promise<number> {
  try {
    const targetStreamId = streamId(targetUrl);
    const sourceStreamId = streamId(sourceUrl);
    const sourceRecords = await dump(sourceUrl);
    const first = sourceRecords[0];
    const firstEvent =
      first === undefined ? undefined : { type: first.type, payload: first.payload, ts: first.ts };
    if (firstEvent === undefined || !isFsBranchForkEvent(firstEvent)) {
      throw new MergeCliError("source stream is not a branch");
    }
    const mergedThroughOffset = sourceRecords.at(-1)?.offset;
    if (typeof mergedThroughOffset !== "string") throw new MergeCliError("source stream is empty");
    const response = await fetch(`${targetUrl.replace(/\/+$/, "")}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson({
        type: "fs.branch.merge",
        payload: {
          v: 1,
          sourceStreamId,
          forkOffset: firstEvent.payload.forkOffset,
          mergedThroughOffset,
        },
        ts: Date.now(),
      }),
    });
    const responseText = await response.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    if (!response.ok) throw new MergeCliError("merge dispatch was refused", body);
    const offset = body?.offset;
    if (typeof offset !== "string")
      throw new MergeCliError("merge dispatch omitted its offset", body);
    const targetRecords = await dump(targetUrl);
    const targetDump: BranchDump = { streamId: targetStreamId, records: targetRecords as never };
    const sourceDump: MergeDump = { streamId: sourceStreamId, records: sourceRecords as never };
    let state = fsInitialState;
    for (const record of resolveBranchLog([targetDump], undefined, [sourceDump])) {
      state = fsReducer(state, record);
    }
    io.stdout(`${offset}\n${treeDigest(state)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof MergeCliError && error.body !== undefined) {
      io.stderr(`${canonicalJson(error.body)}\n`);
    } else {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 1;
  }
}
