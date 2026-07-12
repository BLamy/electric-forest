export type AppendDoor = "raw" | "dispatch";

export interface AppendInvocationStats {
  readonly raw: number;
  readonly dispatch: number;
  readonly total: number;
}

let rawInvocations = 0;
let dispatchInvocations = 0;

export function recordAppendInvocation(door: AppendDoor): void {
  if (door === "raw") rawInvocations += 1;
  else dispatchInvocations += 1;
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
