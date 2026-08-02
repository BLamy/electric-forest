import { canonicalJson } from "@eforest/protocol";
import type { HistoryApplicationRecord } from "@eforest/reducers";
import { BRANCH_EVENT_VERSION, FS_EVENT_VERSION } from "@eforest/streamfs";

export interface HumanizedHistoryRecord {
  readonly actor: string;
  readonly kind: string;
  readonly summary: string;
  readonly raw: string;
  readonly known: boolean;
}

function payloadObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function rawPayload(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return JSON.stringify(value) ?? String(value);
  }
}

function supportedVersion(type: string, version: unknown): boolean {
  if (type === "fs.branch.fork") return version === BRANCH_EVENT_VERSION;
  if (type === "fs.branch.merge") return version === 1 || version === 2;
  return version === FS_EVENT_VERSION;
}

/** Total, deterministic humanization for every canonical application record. */
export function humanizeRecord(record: HistoryApplicationRecord): HumanizedHistoryRecord {
  const payload = payloadObject(record.payload);
  const version = payload?.v;
  const versionLabel = typeof version === "number" ? `@v${String(version)}` : "";
  const knownType =
    record.type === "fs.file.create" ||
    record.type === "fs.file.write" ||
    record.type === "fs.file.patch" ||
    record.type === "fs.file.delete" ||
    record.type === "fs.dir.create" ||
    record.type === "fs.dir.remove" ||
    record.type === "fs.rename" ||
    record.type === "fs.branch.fork" ||
    record.type === "fs.branch.merge";
  const known = knownType && supportedVersion(record.type, version);
  let summary: string;
  switch (record.type) {
    case "fs.file.create":
      summary = `created ${text(payload?.path)}`;
      break;
    case "fs.file.write":
      summary = `wrote ${text(payload?.path)} (${typeof payload?.size === "number" ? String(payload.size) : "?"} bytes)`;
      break;
    case "fs.file.patch":
      summary = `patched ${text(payload?.path)}`;
      break;
    case "fs.file.delete":
      summary = `deleted ${text(payload?.path)}`;
      break;
    case "fs.dir.create":
      summary = `created directory ${text(payload?.path)}`;
      break;
    case "fs.dir.remove":
      summary = `removed directory ${text(payload?.path)}`;
      break;
    case "fs.rename":
      summary = `renamed ${text(payload?.from)} → ${text(payload?.to)}`;
      break;
    case "fs.branch.fork":
      summary = `forked from ${text(payload?.parentStreamId)} at ${text(payload?.forkOffset)}`;
      break;
    case "fs.branch.merge":
      summary = `merged ${text(payload?.sourceStreamId)}`;
      break;
    default:
      summary = `unknown event; raw payload retained${versionLabel}`;
      break;
  }
  return {
    actor: text(record.actor, "unknown-actor"),
    kind: known ? record.type : `${record.type}${versionLabel}`,
    summary,
    raw: rawPayload(record.payload),
    known,
  };
}
