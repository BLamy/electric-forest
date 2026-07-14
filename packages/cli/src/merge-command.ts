import { canonicalJson } from "@eforest/protocol";
import { FsHttpError, StreamFsRepo, mergeFastForward } from "@eforest/streamfs";

export class MergeCliError extends Error {
  readonly body: unknown;

  constructor(message: string, body?: unknown) {
    super(message);
    this.name = "MergeCliError";
    this.body = body;
  }
}

function repoFromStreamUrl(value: string): StreamFsRepo {
  const url = new URL(value);
  const match = /^\/streams\/([^/]+)$/.exec(url.pathname);
  if (!match) throw new MergeCliError("merge URLs must point to /streams/<stream-id>");
  const streamId = decodeURIComponent(match[1]!);
  const streamMatch = /^fs:(.+):([a-z0-9][a-z0-9-]{0,63}):meta$/.exec(streamId);
  if (!streamMatch) throw new MergeCliError("merge URLs must identify StreamFS metadata streams");
  return new StreamFsRepo(url.origin, fetch, streamMatch[1]!, streamMatch[2]!);
}

export async function runMergeCommand(
  targetUrl: string,
  sourceUrl: string,
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
): Promise<number> {
  try {
    const receipt = await mergeFastForward(
      repoFromStreamUrl(targetUrl),
      repoFromStreamUrl(sourceUrl),
    );
    io.stdout(`${receipt.mergeOffset}\n${receipt.treeDigest}\n`);
    return 0;
  } catch (error) {
    const body =
      error instanceof FsHttpError
        ? error.body
        : error instanceof MergeCliError
          ? error.body
          : undefined;
    if (body !== undefined) io.stderr(`${canonicalJson(body)}\n`);
    else io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
