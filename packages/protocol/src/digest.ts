import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export function stateDigest(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}
