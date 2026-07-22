import { isDurableNotFound } from "@eforest/client";
import type { Offset } from "@eforest/protocol";
import type { StreamAdapter } from "../official.js";
import { REGISTRY_STREAM, RegistryProjector } from "./projector.js";
import { registryStateDigest, replayRegistryStream } from "./reducer.js";

/**
 * E2-T08: `ef registry rebuild` — the bet-4 proof made operational.
 *
 * The rebuild replays the source namespace logs alone, in the frozen total
 * order (`ns:root` first, then each `ns:org:<org>` in lexicographic org
 * order, each stream in offset order), through `projectSourceEvent`, writing
 * the derived `__registry__` stream from scratch. It refuses to run while a
 * `__registry__` stream is still present unless told `--force` to discard it
 * — it NEVER reads a surviving materialization, so losing every index loses
 * nothing and a corrupt leftover copy cannot influence the output.
 */

export class RegistryPresentError extends Error {
  constructor() {
    super(
      `${REGISTRY_STREAM} already exists in this store — pass --force to discard and rebuild it`,
    );
    this.name = "RegistryPresentError";
  }
}

export interface RegistryStoreSurface extends StreamAdapter {
  /** The store's own deletion surface (`DELETE /streams/:id`). */
  delete(streamId: string): Promise<boolean>;
}

export interface RegistryRebuildResult {
  readonly digest: string;
  readonly headOffset: Offset | "-1";
  readonly events: number;
}

export async function rebuildRegistry(
  streams: RegistryStoreSurface,
  options: { readonly force?: boolean } = {},
): Promise<RegistryRebuildResult> {
  let present = true;
  try {
    await streams.read(REGISTRY_STREAM);
  } catch (error) {
    if (!isDurableNotFound(error)) throw error;
    present = false;
  }
  if (present) {
    if (options.force !== true) throw new RegistryPresentError();
    await streams.delete(REGISTRY_STREAM);
  }
  const projector = new RegistryProjector(streams);
  // Run to fixpoint: a pass that appends nothing proves every source event is
  // projected (syncOnce absorbs sequence conflicts by design; the loop makes
  // the rebuild's completeness independent of that absorption).
  while ((await projector.syncOnce()) > 0) {
    // next pass
  }
  const records = (await streams.read(REGISTRY_STREAM)) as readonly {
    readonly offset: Offset;
  }[];
  const state = replayRegistryStream(records);
  return {
    digest: registryStateDigest(state),
    headOffset: records.length === 0 ? "-1" : records.at(-1)!.offset,
    events: records.length,
  };
}
