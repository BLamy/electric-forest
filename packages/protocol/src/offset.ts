declare const offsetBrand: unique symbol;
export type Offset = string & { readonly [offsetBrand]: "Offset" };

export const OFFSET_BEFORE_FIRST = "-1" as Offset;

export function compareOffsets(a: Offset, b: Offset): -1 | 0 | 1 {
  if (a === b) return 0;
  if (a === OFFSET_BEFORE_FIRST) return -1;
  if (b === OFFSET_BEFORE_FIRST) return 1;
  return a < b ? -1 : 1;
}

export function isOffsetBefore(a: Offset, b: Offset): boolean {
  return compareOffsets(a, b) === -1;
}

export function maxOffset(a: Offset, b: Offset): Offset {
  return compareOffsets(a, b) >= 0 ? a : b;
}
