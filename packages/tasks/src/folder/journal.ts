/**
 * The E6-T05 provenance journal: a total, append-only account of every stream record
 * the task-folder sync engine consumed or produced, in a frozen canonical-JSON-lines
 * format. Nothing about echo suppression is a timing heuristic: a branch offset is
 * "own" exactly when a `projected` line names it, and the tail suppresses exactly those
 * offsets. The multiplicity rule is fixed per offset:
 *
 * - branch (StreamFS meta) offsets under the watched root: a foreign record appears
 *   exactly once as `ingested`; an own record appears exactly twice, `projected`
 *   (written at dispatch, with its receipt offset) then `suppressed` (seen on the tail).
 * - task / evidence stream offsets: every record the engine consumed appears exactly
 *   once as `applied`; a record the engine itself dispatched additionally appears once
 *   as `dispatched` (before `applied`).
 *
 * Evidence content streams (`evidence-content:*`) are byte stores, not decision inputs:
 * their integrity is bound by digest through the `evidence.attached` record that cites
 * them (sealed SHA-256 = attachment SHA-256 = folder bytes), so they are audited by
 * digest parity, not by per-record journal lines.
 *
 * `auditTaskSyncJournal` holds a journal to that rule against the stream dumps and names
 * any offset outside its multiplicity. The format is pure data: no clock, no filesystem.
 */
import { canonicalJson, sha256Hex, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";

export const TASK_SYNC_JOURNAL_VERSION = 1 as const;

export const TASK_SYNC_DISPOSITIONS = [
  "ingested",
  "projected",
  "suppressed",
  "dispatched",
  "applied",
] as const;
export type TaskSyncDisposition = (typeof TASK_SYNC_DISPOSITIONS)[number];

/** What an `ingested` branch record turned into. Frozen; the verifier counts these. */
export const TASK_SYNC_INGEST_KINDS = [
  "created",
  "revised",
  "log-entry",
  "evidence-added",
  "evidence-removed",
  "workshop",
  "directory",
  "awaiting-content",
  "unchanged",
  "refused",
  "restored",
  "outside",
] as const;
export type TaskSyncIngestKind = (typeof TASK_SYNC_INGEST_KINDS)[number];

export interface TaskSyncJournalRecord {
  readonly v: typeof TASK_SYNC_JOURNAL_VERSION;
  readonly seq: number;
  readonly stream: string;
  readonly offset: Offset;
  readonly disposition: TaskSyncDisposition;
  /** Branch path, or the event type for task/evidence stream records. */
  readonly subject: string;
  /** Sorted, deduplicated ingest kinds (only for `ingested`), else empty. */
  readonly kinds: readonly TaskSyncIngestKind[];
  /** Stream records this line caused (`ingested`) as `stream@offset`; else empty. */
  readonly effects: readonly string[];
  /** Refusal reason for `ingested` refusals; empty otherwise. */
  readonly reason: string;
  /** SHA-256 over the canonical record without this field. */
  readonly checksum: string;
}

export type TaskSyncJournalInput = Omit<TaskSyncJournalRecord, "v" | "seq" | "checksum">;

export class TaskSyncJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSyncJournalError";
  }
}

const RECORD_KEYS = [
  "checksum",
  "disposition",
  "effects",
  "kinds",
  "offset",
  "reason",
  "seq",
  "stream",
  "subject",
  "v",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checksumOf(record: Omit<TaskSyncJournalRecord, "checksum">): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(record)));
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Strict parse of one journal line's value; throws `TaskSyncJournalError`. */
export function parseTaskSyncJournalRecord(value: unknown, label: string): TaskSyncJournalRecord {
  if (!isRecord(value)) throw new TaskSyncJournalError(`${label} is not an object`);
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index]))
    throw new TaskSyncJournalError(`${label} has unexpected keys`);
  if (value.v !== TASK_SYNC_JOURNAL_VERSION) throw new TaskSyncJournalError(`${label} version`);
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1)
    throw new TaskSyncJournalError(`${label} seq`);
  if (typeof value.stream !== "string" || value.stream.length === 0)
    throw new TaskSyncJournalError(`${label} stream`);
  if (
    typeof value.offset !== "string" ||
    value.offset === "-1" ||
    !isWellFormedOffset(value.offset)
  )
    throw new TaskSyncJournalError(`${label} offset`);
  if (!(TASK_SYNC_DISPOSITIONS as readonly unknown[]).includes(value.disposition))
    throw new TaskSyncJournalError(`${label} disposition`);
  if (typeof value.subject !== "string" || value.subject.length === 0)
    throw new TaskSyncJournalError(`${label} subject`);
  if (
    !isStringList(value.kinds) ||
    !value.kinds.every((kind) => (TASK_SYNC_INGEST_KINDS as readonly string[]).includes(kind)) ||
    [...value.kinds].sort().join(",") !== value.kinds.join(",") ||
    new Set(value.kinds).size !== value.kinds.length
  )
    throw new TaskSyncJournalError(`${label} kinds`);
  if (!isStringList(value.effects)) throw new TaskSyncJournalError(`${label} effects`);
  if (typeof value.reason !== "string") throw new TaskSyncJournalError(`${label} reason`);
  if (typeof value.checksum !== "string") throw new TaskSyncJournalError(`${label} checksum`);
  const disposition = value.disposition as TaskSyncDisposition;
  if (disposition !== "ingested" && (value.kinds.length > 0 || value.effects.length > 0))
    throw new TaskSyncJournalError(`${label} carries ingest fields on ${disposition}`);
  const record: Omit<TaskSyncJournalRecord, "checksum"> = {
    v: TASK_SYNC_JOURNAL_VERSION,
    seq: value.seq,
    stream: value.stream,
    offset: value.offset as Offset,
    disposition,
    subject: value.subject,
    kinds: value.kinds as readonly TaskSyncIngestKind[],
    effects: value.effects,
    reason: value.reason,
  };
  if (checksumOf(record) !== value.checksum)
    throw new TaskSyncJournalError(`${label} checksum does not match its canonical bytes`);
  return { ...record, checksum: value.checksum };
}

export function serializeTaskSyncJournal(records: readonly TaskSyncJournalRecord[]): string {
  return records.map((record) => `${canonicalJson(record)}\n`).join("");
}

/** Strict parse of a whole journal text: canonical lines, contiguous `seq`, LF only. */
export function parseTaskSyncJournal(source: string): readonly TaskSyncJournalRecord[] {
  if (source.length === 0) return [];
  if (!source.endsWith("\n") || source.includes("\r"))
    throw new TaskSyncJournalError("journal must be LF-delimited canonical JSON lines");
  const records: TaskSyncJournalRecord[] = [];
  for (const [index, line] of source.slice(0, -1).split("\n").entries()) {
    const label = `journal line ${index + 1}`;
    if (line.length === 0) throw new TaskSyncJournalError(`${label} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new TaskSyncJournalError(`${label} is not JSON: ${String(error)}`);
    }
    const record = parseTaskSyncJournalRecord(parsed, label);
    if (canonicalJson(record) !== line) throw new TaskSyncJournalError(`${label} is not canonical`);
    if (record.seq !== records.length + 1)
      throw new TaskSyncJournalError(`${label} seq expected ${records.length + 1}`);
    records.push(record);
  }
  return records;
}

/**
 * The in-memory journal. `append` refuses a duplicate (stream, offset, disposition) so
 * every record has at most one line per disposition; persistence is the caller's
 * (`onAppend` receives the canonical line).
 */
export class TaskSyncJournal {
  private readonly records: TaskSyncJournalRecord[];
  private readonly index = new Set<string>();

  constructor(
    existing: readonly TaskSyncJournalRecord[] = [],
    private readonly onAppend?: (line: string, record: TaskSyncJournalRecord) => void,
  ) {
    this.records = [...existing];
    for (const record of this.records) this.index.add(this.key(record));
  }

  private key(record: Pick<TaskSyncJournalRecord, "stream" | "offset" | "disposition">): string {
    return `${record.stream} ${record.offset} ${record.disposition}`;
  }

  get state(): readonly TaskSyncJournalRecord[] {
    return [...this.records];
  }

  has(stream: string, offset: Offset, disposition: TaskSyncDisposition): boolean {
    return this.index.has(this.key({ stream, offset, disposition }));
  }

  append(input: TaskSyncJournalInput): TaskSyncJournalRecord {
    if (this.has(input.stream, input.offset, input.disposition)) {
      throw new TaskSyncJournalError(
        `journal already holds ${input.disposition} for ${input.stream}@${input.offset}`,
      );
    }
    const withoutChecksum: Omit<TaskSyncJournalRecord, "checksum"> = {
      v: TASK_SYNC_JOURNAL_VERSION,
      seq: this.records.length + 1,
      stream: input.stream,
      offset: input.offset,
      disposition: input.disposition,
      subject: input.subject,
      kinds: [...new Set(input.kinds)].sort(),
      effects: [...input.effects],
      reason: input.reason,
    };
    const record = parseTaskSyncJournalRecord(
      { ...withoutChecksum, checksum: checksumOf(withoutChecksum) },
      `journal seq ${withoutChecksum.seq}`,
    );
    this.records.push(record);
    this.index.add(this.key(record));
    this.onAppend?.(`${canonicalJson(record)}\n`, record);
    return record;
  }
}

export interface TaskSyncJournalAuditInput {
  /** Every branch offset under the watched root (from the meta dump). */
  readonly branch: { readonly stream: string; readonly offsets: readonly Offset[] };
  /** Every task/evidence stream offset the engine must have consumed. */
  readonly streams: readonly { readonly stream: string; readonly offsets: readonly Offset[] }[];
}

export interface TaskSyncJournalAudit {
  readonly ok: boolean;
  readonly own: number;
  readonly foreign: number;
  readonly applied: number;
  readonly dispatched: number;
  readonly violations: readonly string[];
}

/** Hold a journal to the multiplicity rule against the streams it claims to account for. */
export function auditTaskSyncJournal(
  records: readonly TaskSyncJournalRecord[],
  input: TaskSyncJournalAuditInput,
): TaskSyncJournalAudit {
  const violations: string[] = [];
  const by = new Map<string, TaskSyncDisposition[]>();
  for (const record of records) {
    const key = `${record.stream}@${record.offset}`;
    const list = by.get(key) ?? [];
    list.push(record.disposition);
    by.set(key, list);
  }
  let own = 0;
  let foreign = 0;
  for (const offset of input.branch.offsets) {
    const key = `${input.branch.stream}@${offset}`;
    const dispositions = (by.get(key) ?? []).join(",");
    if (dispositions === "ingested") foreign += 1;
    else if (dispositions === "projected,suppressed") own += 1;
    else violations.push(`${key}: ${dispositions === "" ? "unjournaled" : dispositions}`);
    by.delete(key);
  }
  let applied = 0;
  let dispatched = 0;
  for (const stream of input.streams) {
    for (const offset of stream.offsets) {
      const key = `${stream.stream}@${offset}`;
      const dispositions = (by.get(key) ?? []).join(",");
      if (dispositions === "applied") applied += 1;
      else if (dispositions === "dispatched,applied") {
        applied += 1;
        dispatched += 1;
      } else violations.push(`${key}: ${dispositions === "" ? "unjournaled" : dispositions}`);
      by.delete(key);
    }
  }
  for (const [key, dispositions] of by) {
    violations.push(`${key}: journaled (${dispositions.join(",")}) but absent from the streams`);
  }
  return { ok: violations.length === 0, own, foreign, applied, dispatched, violations };
}
