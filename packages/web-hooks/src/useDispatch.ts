import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareOffsets, OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";

export const DISPATCH_HOOK_VERSION = 1 as const;

export interface DispatchReceipt {
  readonly offset: Offset;
}

export interface DispatchCounters {
  readonly sent: number;
  readonly confirmed: number;
  readonly reconciled: number;
  readonly refused: number;
}

export interface DispatchLifecycle {
  readonly confirmedOffset: Offset | "";
  readonly counters: DispatchCounters;
  readonly pendingOffsets: readonly Offset[];
}

export interface DispatchRefusal {
  readonly code: string;
  readonly message: string;
  readonly refusedAction: Event;
}

export class DispatchRefusalError extends Error implements DispatchRefusal {
  readonly code: string;
  readonly refusedAction: Event;

  constructor(refusal: DispatchRefusal) {
    super(refusal.message);
    this.name = "DispatchRefusalError";
    this.code = refusal.code;
    this.refusedAction = refusal.refusedAction;
  }
}

export interface UseDispatchOptions {
  readonly apiPath?: string;
  readonly replayedOffset?: Offset;
  readonly fetch?: typeof fetch;
}

export interface DispatchActionOptions {
  /** Canonical StreamFS content generation staged by the same authorized dispatch request. */
  readonly contentEvent?: Event;
}

export interface DispatchFunction {
  (action: Event, options?: DispatchActionOptions): Promise<DispatchReceipt>;
  readonly confirmedOffset: Offset | "";
  readonly counters: DispatchCounters;
}

export const initialDispatchLifecycle: DispatchLifecycle = Object.freeze({
  confirmedOffset: "",
  counters: Object.freeze({ sent: 0, confirmed: 0, reconciled: 0, refused: 0 }),
  pendingOffsets: Object.freeze([]),
});

function greatestOffset(left: Offset | "", right: Offset): Offset {
  return left === "" || compareOffsets(left, right) < 0 ? right : left;
}

export function dispatchStarted(current: DispatchLifecycle): DispatchLifecycle {
  return {
    ...current,
    counters: { ...current.counters, sent: current.counters.sent + 1 },
  };
}

export function dispatchRefused(current: DispatchLifecycle): DispatchLifecycle {
  return {
    ...current,
    counters: { ...current.counters, refused: current.counters.refused + 1 },
  };
}

export function reconcileDispatches(
  current: DispatchLifecycle,
  replayedOffset: Offset,
): DispatchLifecycle {
  const reconciled = current.pendingOffsets.filter(
    (offset) => compareOffsets(offset, replayedOffset) <= 0,
  ).length;
  if (reconciled === 0) return current;
  return {
    ...current,
    counters: {
      ...current.counters,
      reconciled: current.counters.reconciled + reconciled,
    },
    pendingOffsets: current.pendingOffsets.filter(
      (offset) => compareOffsets(offset, replayedOffset) > 0,
    ),
  };
}

export function dispatchConfirmed(
  current: DispatchLifecycle,
  offset: Offset,
  replayedOffset: Offset,
): DispatchLifecycle {
  const confirmed: DispatchLifecycle = {
    confirmedOffset: greatestOffset(current.confirmedOffset, offset),
    counters: { ...current.counters, confirmed: current.counters.confirmed + 1 },
    pendingOffsets: [...current.pendingOffsets, offset],
  };
  return reconcileDispatches(confirmed, replayedOffset);
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function refusalFrom(body: unknown, action: Event, status: number): DispatchRefusal {
  const error = responseObject(responseObject(body)?.error);
  const code =
    typeof error?.reason === "string"
      ? error.reason
      : typeof error?.code === "string"
        ? error.code
        : typeof error?.class === "string"
          ? error.class
          : `http/${String(status)}`;
  const message = typeof error?.message === "string" ? error.message : code;
  return { code, message, refusedAction: action };
}

/** One authenticated browser write. This function never reduces or caches the action. */
export async function postDispatch(
  streamId: string,
  action: Event,
  options: Pick<UseDispatchOptions, "apiPath" | "fetch"> & DispatchActionOptions = {},
): Promise<DispatchReceipt> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(options.apiPath ?? "/api/dispatch", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-eforest-dispatch-receipt": "offset",
    },
    body: JSON.stringify({
      streamId,
      event: action,
      ...(options.contentEvent === undefined ? {} : { contentEvent: options.contentEvent }),
    }),
  });
  const body = await responseJson(response);
  if (!response.ok || responseObject(body)?.error !== undefined) {
    throw new DispatchRefusalError(refusalFrom(body, action, response.status));
  }
  const offset = responseObject(body)?.offset;
  if (typeof offset !== "string" || !isWellFormedOffset(offset) || offset === OFFSET_BEFORE_FIRST) {
    throw new Error("dispatch confirmation omitted a valid append offset");
  }
  return { offset };
}

/**
 * The callable return value is the frozen v1 API. Its metadata is observation
 * only: confirmed receipts wait in `pendingOffsets` until the paired reducer
 * has replayed them, and no action is ever applied by this hook.
 */
export function useDispatch(streamId: string, options: UseDispatchOptions = {}): DispatchFunction {
  const [lifecycle, setLifecycle] = useState<DispatchLifecycle>(initialDispatchLifecycle);
  const replayedOffset = options.replayedOffset ?? OFFSET_BEFORE_FIRST;
  const replayedOffsetRef = useRef(replayedOffset);
  replayedOffsetRef.current = replayedOffset;

  useEffect(() => {
    setLifecycle((current) => reconcileDispatches(current, replayedOffset));
  }, [replayedOffset]);

  const invoke = useCallback(
    async (action: Event, actionOptions: DispatchActionOptions = {}): Promise<DispatchReceipt> => {
      setLifecycle(dispatchStarted);
      let receipt: DispatchReceipt;
      try {
        receipt = await postDispatch(streamId, action, { ...options, ...actionOptions });
      } catch (error) {
        setLifecycle(dispatchRefused);
        throw error;
      }
      setLifecycle((current) =>
        dispatchConfirmed(current, receipt.offset, replayedOffsetRef.current),
      );
      return receipt;
    },
    [options.apiPath, options.fetch, streamId],
  );

  return useMemo(
    () =>
      Object.assign(
        (action: Event, actionOptions?: DispatchActionOptions) => invoke(action, actionOptions),
        {
          confirmedOffset: lifecycle.confirmedOffset,
          counters: lifecycle.counters,
        },
      ),
    [invoke, lifecycle.confirmedOffset, lifecycle.counters],
  );
}
