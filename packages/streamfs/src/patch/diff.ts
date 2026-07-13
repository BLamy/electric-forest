import { PatchError, type PatchOp, type PatchOps } from "./ops.js";

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function boundary(bytes: Uint8Array, position: number): number {
  let result = position;
  while (result > 0 && result < bytes.byteLength && (bytes[result]! & 0xc0) === 0x80) result -= 1;
  return result;
}

export function diffText(base: string, target: string): PatchOps {
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(base);
  const targetBytes = encoder.encode(target);
  if (!isText(baseBytes) || !isText(targetBytes)) {
    throw new PatchError(
      "patch/target-not-a-text-file",
      "diffText requires text without NUL bytes",
    );
  }
  let prefix = 0;
  while (
    prefix < baseBytes.byteLength &&
    prefix < targetBytes.byteLength &&
    baseBytes[prefix] === targetBytes[prefix]
  )
    prefix += 1;
  prefix = boundary(baseBytes, prefix);
  prefix = Math.min(prefix, boundary(targetBytes, prefix));
  let suffix = 0;
  while (
    suffix < baseBytes.byteLength - prefix &&
    suffix < targetBytes.byteLength - prefix &&
    baseBytes[baseBytes.byteLength - suffix - 1] ===
      targetBytes[targetBytes.byteLength - suffix - 1]
  )
    suffix += 1;
  const baseSuffixStart = boundary(baseBytes, baseBytes.byteLength - suffix);
  const targetSuffixStart = boundary(targetBytes, targetBytes.byteLength - suffix);
  suffix = Math.min(
    baseBytes.byteLength - baseSuffixStart,
    targetBytes.byteLength - targetSuffixStart,
  );
  const ops: PatchOp[] = [];
  if (prefix > 0) ops.push(["=", prefix]);
  const targetMiddle = targetBytes.slice(prefix, targetBytes.byteLength - suffix);
  if (targetMiddle.byteLength > 0)
    ops.push(["+", new TextDecoder("utf-8", { fatal: true }).decode(targetMiddle)]);
  const baseMiddle = baseBytes.byteLength - prefix - suffix;
  if (baseMiddle > 0) ops.splice(prefix > 0 ? 1 : 0, 0, ["-", baseMiddle]);
  if (suffix > 0) ops.push(["=", suffix]);
  return ops;
}
