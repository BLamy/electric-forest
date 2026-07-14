import { diffText } from "./diff.js";
import { applyPatch, type PatchOps } from "./ops.js";

interface EditHunk {
  readonly start: number;
  readonly end: number;
  readonly inserted: Uint8Array;
}

export type TextMergeResult =
  | { readonly kind: "clean"; readonly bytes: Uint8Array; readonly ops: PatchOps }
  | { readonly kind: "conflict"; readonly reason: "overlap" | "binary" | "non-patchable" };

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function hunks(ops: PatchOps): readonly EditHunk[] {
  const result: EditHunk[] = [];
  let cursor = 0;
  let start: number | undefined;
  let end = 0;
  let inserted: Uint8Array[] = [];
  const flush = (): void => {
    if (start === undefined) return;
    const length = inserted.reduce((total, bytes) => total + bytes.byteLength, 0);
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const bytes of inserted) {
      combined.set(bytes, offset);
      offset += bytes.byteLength;
    }
    result.push({ start, end, inserted: combined });
    start = undefined;
    end = 0;
    inserted = [];
  };
  for (const [kind, value] of ops) {
    if (kind === "=") {
      flush();
      cursor += value;
    } else if (kind === "-") {
      start ??= cursor;
      cursor += value;
      end = cursor;
    } else {
      start ??= cursor;
      end = Math.max(end, cursor);
      inserted.push(new TextEncoder().encode(value));
    }
  }
  flush();
  return result;
}

function overlaps(left: EditHunk, right: EditHunk): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyHunks(base: Uint8Array, edits: readonly EditHunk[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of edits) {
    chunks.push(base.slice(cursor, edit.start), edit.inserted);
    cursor = edit.end;
  }
  chunks.push(base.slice(cursor));
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Compose target/source text changes in common-base byte coordinates. */
export function mergeTextBytes(
  base: Uint8Array,
  target: Uint8Array,
  source: Uint8Array,
): TextMergeResult {
  const baseText = decodeText(base);
  const targetText = decodeText(target);
  const sourceText = decodeText(source);
  if (baseText === undefined || targetText === undefined || sourceText === undefined) {
    return { kind: "conflict", reason: "binary" };
  }
  try {
    const targetHunks = hunks(diffText(baseText, targetText));
    const sourceHunks = hunks(diffText(baseText, sourceText));
    if (targetHunks.some((left) => sourceHunks.some((right) => overlaps(left, right)))) {
      return { kind: "conflict", reason: "overlap" };
    }
    const edits = [...targetHunks, ...sourceHunks].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    const merged = applyHunks(base, edits);
    const mergedText = decodeText(merged);
    if (mergedText === undefined) return { kind: "conflict", reason: "non-patchable" };
    const ops = diffText(targetText, mergedText);
    if (!Buffer.from(applyPatch(target, ops)).equals(Buffer.from(merged))) {
      return { kind: "conflict", reason: "non-patchable" };
    }
    return { kind: "clean", bytes: merged, ops };
  } catch {
    return { kind: "conflict", reason: "non-patchable" };
  }
}
