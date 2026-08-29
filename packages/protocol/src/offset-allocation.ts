import { OFFSET_BEFORE_FIRST, type Offset } from "./offset.js";

const OFFSET_COMPONENT_WIDTH = 16;
const OFFSET_PATTERN = /^[0-9]+(?:_[0-9]+)?$/;
const ALLOCATED_OFFSET_PATTERN = /^0000000000000000_([0-9]{16})$/;

/** Authority-only allocator used by the in-memory stream server. Clients echo offsets. */
export function offsetForOrdinal(ordinal: number): Offset {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError("stream offset ordinal must be a non-negative safe integer");
  }
  return `0000000000000000_${String(ordinal).padStart(OFFSET_COMPONENT_WIDTH, "0")}` as Offset;
}

export function isWellFormedOffset(value: unknown): value is Offset {
  return value === OFFSET_BEFORE_FIRST || (typeof value === "string" && OFFSET_PATTERN.test(value));
}

/** Product-owned application offsets are a contiguous sequence, unlike opaque transport offsets. */
export function nextAllocatedOffset(previous: Offset): Offset {
  if (previous === OFFSET_BEFORE_FIRST) return offsetForOrdinal(0);
  const match = ALLOCATED_OFFSET_PATTERN.exec(previous);
  if (match?.[1] === undefined) {
    throw new RangeError(`application offset is not canonically allocated: ${previous}`);
  }
  const next = BigInt(match[1]) + 1n;
  if (next >= 10n ** BigInt(OFFSET_COMPONENT_WIDTH)) {
    throw new RangeError(`application offset sequence is exhausted: ${previous}`);
  }
  return `0000000000000000_${next.toString().padStart(OFFSET_COMPONENT_WIDTH, "0")}` as Offset;
}
