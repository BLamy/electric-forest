import type { Event } from "@eforest/protocol";
import type { AppendStreamResult, StreamStore } from "./store/types.js";

export type AppendDoor = "raw" | "dispatch";

export interface AppendInvocationStats {
  readonly raw: number;
  readonly dispatch: number;
  readonly total: number;
}

let rawInvocations = 0;
let dispatchInvocations = 0;

/** The only source-level invocation of StreamStore.append. */
export function appendThroughDoor(
  store: StreamStore,
  streamId: string,
  events: readonly Event[],
  sequence: number,
  door: AppendDoor,
): AppendStreamResult {
  if (door === "raw") rawInvocations += 1;
  else dispatchInvocations += 1;
  return store.append(streamId, events, sequence);
}

export function appendInvocationStats(): AppendInvocationStats {
  return {
    raw: rawInvocations,
    dispatch: dispatchInvocations,
    total: rawInvocations + dispatchInvocations,
  };
}

export function resetAppendInvocationStats(): void {
  rawInvocations = 0;
  dispatchInvocations = 0;
}
