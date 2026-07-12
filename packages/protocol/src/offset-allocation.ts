import { OFFSET_BEFORE_FIRST, type Offset } from "./offset.js";

const OFFSET_COMPONENT_WIDTH = 16;
const OFFSET_PATTERN = /^[0-9]+(?:_[0-9]+)?$/;

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
