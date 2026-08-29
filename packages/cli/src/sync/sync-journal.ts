import { canonicalJson, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SYNC_JOURNAL_VERSION = 1 as const;
export const SYNC_JOURNAL_NAME = "sync-journal" as const;

export type SyncDisposition = "uploaded" | "applied" | "suppressed";

export interface SyncJournalRecord {
  readonly v: typeof SYNC_JOURNAL_VERSION;
  readonly offset: string;
  readonly disposition: SyncDisposition;
  readonly writerId: string;
  readonly path: string;
}

export class SyncJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncJournalError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === 5 &&
    keys[0] === "disposition" &&
    keys[1] === "offset" &&
    keys[2] === "path" &&
    keys[3] === "v" &&
    keys[4] === "writerId"
  );
}

function parseRecord(value: unknown, label: string): SyncJournalRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value) ||
    value.v !== SYNC_JOURNAL_VERSION ||
    typeof value.offset !== "string" ||
    value.offset === "-1" ||
    !isWellFormedOffset(value.offset) ||
    (value.disposition !== "uploaded" &&
      value.disposition !== "applied" &&
      value.disposition !== "suppressed") ||
    typeof value.writerId !== "string" ||
    value.writerId.length === 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0
  ) {
    throw new SyncJournalError(`${label} is malformed`);
  }
  const record: SyncJournalRecord = {
    v: SYNC_JOURNAL_VERSION,
    offset: value.offset,
    disposition: value.disposition,
    writerId: value.writerId,
    path: value.path,
  };
  return record;
}

export function syncJournalPath(root: string): string {
  return join(root, ".ef", SYNC_JOURNAL_NAME);
}

export function readSyncJournal(path: string): readonly SyncJournalRecord[] {
  if (!existsSync(path)) return [];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new SyncJournalError(`cannot read ${path}: ${String(error)}`);
  }
  if (source.length === 0) return [];
  if (!source.endsWith("\n") || source.endsWith("\r\n") || source.includes("\r")) {
    throw new SyncJournalError(`${path} must end with LF-delimited canonical JSON`);
  }
  const records: SyncJournalRecord[] = [];
  for (const [index, line] of source.slice(0, -1).split("\n").entries()) {
    const label = `${path} line ${index + 1}`;
    if (line.length === 0) throw new SyncJournalError(`${label} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new SyncJournalError(`${label} is not JSON: ${String(error)}`);
    }
    const record = parseRecord(parsed, label);
    if (canonicalJson(record) !== line) {
      throw new SyncJournalError(`${label} is not canonical JSON`);
    }
    records.push(record);
  }
  return records;
}

export class SyncJournalWriter {
  private readonly records: SyncJournalRecord[];

  constructor(readonly path: string) {
    this.records = [...readSyncJournal(path)];
  }

  get state(): readonly SyncJournalRecord[] {
    return [...this.records];
  }

  hasOffset(offset: Offset | string, disposition?: SyncDisposition): boolean {
    return this.records.some(
      (record) =>
        record.offset === offset &&
        (disposition === undefined || record.disposition === disposition),
    );
  }

  async append(input: Omit<SyncJournalRecord, "v">): Promise<SyncJournalRecord> {
    const record = parseRecord({ v: SYNC_JOURNAL_VERSION, ...input }, this.path);
    if (
      this.records.some(
        (existing) =>
          existing.offset === record.offset &&
          existing.disposition === record.disposition &&
          existing.writerId === record.writerId &&
          existing.path === record.path,
      )
    ) {
      return this.records.find(
        (existing) =>
          existing.offset === record.offset &&
          existing.disposition === record.disposition &&
          existing.writerId === record.writerId &&
          existing.path === record.path,
      )!;
    }
    const line = `${canonicalJson(record)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(line, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.records.push(record);
    return record;
  }
}
