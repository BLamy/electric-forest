import { canonicalJson } from "@eforest/protocol";
import { mkdir, open } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalAction =
  | "fs.dir.create"
  | "fs.dir.remove"
  | "fs.file.create"
  | "fs.file.delete"
  | "fs.file.patch"
  | "fs.file.write";

export interface JournalConflict {
  readonly path: string;
  readonly expectedBase: string;
  readonly actualBase: string;
}

export interface AcceptedJournalRecord {
  readonly seq: number;
  readonly kind: "accepted";
  readonly action: JournalAction;
  readonly path: string;
  readonly base: string;
  readonly offset: string;
}

export interface RefusedJournalRecord {
  readonly seq: number;
  readonly kind: "refused";
  readonly action: JournalAction;
  readonly path: string;
  readonly base: string;
  readonly conflict: JournalConflict;
}

export type JournalRecord = AcceptedJournalRecord | RefusedJournalRecord;

export interface JournalRecordInput {
  readonly kind: JournalRecord["kind"];
  readonly action: JournalAction;
  readonly path: string;
  readonly base: string;
  readonly offset?: string;
  readonly conflict?: JournalConflict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAction(value: unknown): value is JournalAction {
  return (
    value === "fs.dir.create" ||
    value === "fs.dir.remove" ||
    value === "fs.file.create" ||
    value === "fs.file.delete" ||
    value === "fs.file.patch" ||
    value === "fs.file.write"
  );
}

function parseConflict(value: unknown): JournalConflict {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["actualBase", "expectedBase", "path"]) ||
    typeof value.path !== "string" ||
    typeof value.expectedBase !== "string" ||
    typeof value.actualBase !== "string"
  ) {
    throw new Error("journal conflict is malformed");
  }
  return {
    path: value.path,
    expectedBase: value.expectedBase,
    actualBase: value.actualBase,
  };
}

function parseRecord(value: unknown, line: number): JournalRecord {
  if (!isRecord(value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq)) {
    throw new Error(`journal line ${line} is malformed`);
  }
  if (
    value.kind === "accepted" &&
    exactKeys(value, ["action", "base", "kind", "offset", "path", "seq"]) &&
    isAction(value.action) &&
    typeof value.path === "string" &&
    typeof value.base === "string" &&
    typeof value.offset === "string"
  ) {
    return {
      seq: value.seq,
      kind: "accepted",
      action: value.action,
      path: value.path,
      base: value.base,
      offset: value.offset,
    };
  }
  if (
    value.kind === "refused" &&
    exactKeys(value, ["action", "base", "conflict", "kind", "path", "seq"]) &&
    isAction(value.action) &&
    typeof value.path === "string" &&
    typeof value.base === "string"
  ) {
    return {
      seq: value.seq,
      kind: "refused",
      action: value.action,
      path: value.path,
      base: value.base,
      conflict: parseConflict(value.conflict),
    };
  }
  throw new Error(`journal line ${line} is malformed`);
}

/** Read and validate the append-only journal, including canonical line bytes. */
export function readJournal(path: string): readonly JournalRecord[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  if (source.length === 0) return [];
  if (!source.endsWith("\n") || source.endsWith("\r\n") || source.includes("\r")) {
    throw new Error("journal must end with LF-delimited canonical JSON");
  }
  const records: JournalRecord[] = [];
  for (const [index, line] of source.slice(0, -1).split("\n").entries()) {
    if (line.length === 0) throw new Error(`journal line ${index + 1} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`journal line ${index + 1} is not JSON: ${String(error)}`, { cause: error });
    }
    const record = parseRecord(parsed, index + 1);
    if (`${canonicalJson(record)}\n` !== `${line}\n`) {
      throw new Error(`journal line ${index + 1} is not canonical JSON`);
    }
    const expectedSeq = records.length + 1;
    if (record.seq !== expectedSeq) {
      throw new Error(`journal sequence expected ${expectedSeq}, got ${record.seq}`);
    }
    records.push(record);
  }
  return records;
}

/** Canonical bytes used by stdout mirroring and the on-disk journal. */
export function journalLine(record: JournalRecord): string {
  return `${canonicalJson(record)}\n`;
}

/** Append one record and fsync the journal before returning. */
export class JournalWriter {
  private nextSeq: number;

  constructor(readonly path: string) {
    const records = readJournal(path);
    this.nextSeq = records.length + 1;
  }

  async append(input: JournalRecordInput): Promise<JournalRecord> {
    const seq = this.nextSeq;
    const record: JournalRecord =
      input.kind === "accepted"
        ? {
            seq,
            kind: "accepted",
            action: input.action,
            path: input.path,
            base: input.base,
            offset:
              input.offset ??
              (() => {
                throw new Error("accepted journal record needs an offset");
              })(),
          }
        : {
            seq,
            kind: "refused",
            action: input.action,
            path: input.path,
            base: input.base,
            conflict:
              input.conflict ??
              (() => {
                throw new Error("refused journal record needs a conflict");
              })(),
          };
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.write(journalLine(record), undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.nextSeq += 1;
    return record;
  }
}
