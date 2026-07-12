import { canonicalJson, type Offset } from "@eforest/protocol";
import {
  digestRecords,
  loadReducer,
  readDump,
  ReplayCliError,
  type DumpRecord,
  type ReducerModule,
} from "./replay-command.js";

export type BisectKind = "identical" | "divergence" | "prefix";

export interface BisectResult {
  readonly aOffset: Offset | null;
  readonly bOffset: Offset | null;
  readonly index: number;
  readonly kind: BisectKind;
  readonly lastCommonDigest: string;
}

export interface BisectStats {
  readonly probes: number;
  readonly recordsReplayed: number;
}

export interface BisectOptions {
  readonly reducerPath?: string;
  readonly stats?: boolean;
}

function canonicalRecord(record: DumpRecord): string {
  return canonicalJson(record);
}

function samePrefix(a: readonly DumpRecord[], b: readonly DumpRecord[], length: number): boolean {
  if (length > a.length || length > b.length) return false;
  for (let index = 0; index < length; index += 1) {
    if (canonicalRecord(a[index]!) !== canonicalRecord(b[index]!)) return false;
  }
  return true;
}

function offsetAt(records: readonly DumpRecord[], index: number): Offset | null {
  return records[index - 1]?.offset ?? null;
}

export function bisectRecords(
  a: readonly DumpRecord[],
  b: readonly DumpRecord[],
  reducer: ReducerModule,
): { readonly result: BisectResult; readonly stats: BisectStats } {
  let probes = 0;
  let recordsReplayed = 0;

  // Raw canonical-line equality is the monotone truth predicate. Digest comparison is
  // deliberately performed at every probe through the protocol replay core as a cheap
  // state-level witness, while the raw comparison keeps the search correct when state
  // effects reconverge after different records.
  const prefixAgrees = (length: number): boolean => {
    // Each predicate evaluation has two counted probes: one protocol state-digest
    // comparison and one canonical-record comparison. The final pinned-index line
    // check below is intentionally outside this counter.
    probes += 2;
    const aPrefix = a.slice(0, Math.min(length, a.length));
    const bPrefix = b.slice(0, Math.min(length, b.length));
    const aDigest = digestRecords(aPrefix, reducer);
    const bDigest = digestRecords(bPrefix, reducer);
    recordsReplayed += aPrefix.length + bPrefix.length;
    return (
      length <= a.length && length <= b.length && aDigest === bDigest && samePrefix(a, b, length)
    );
  };

  let low = 0;
  let high = Math.max(a.length, b.length) + 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (prefixAgrees(middle)) low = middle;
    else high = middle;
  }

  const commonLength = low;
  const lastCommonDigest = digestRecords(a, reducer, commonLength);
  recordsReplayed += commonLength;
  if (commonLength === Math.max(a.length, b.length)) {
    return {
      result: {
        aOffset: offsetAt(a, commonLength),
        bOffset: offsetAt(b, commonLength),
        index: commonLength,
        kind: "identical",
        lastCommonDigest,
      },
      stats: { probes, recordsReplayed },
    };
  }

  const index = commonLength + 1;
  if (index <= a.length && index <= b.length) {
    const aLine = canonicalRecord(a[index - 1]!);
    const bLine = canonicalRecord(b[index - 1]!);
    if (aLine === bLine) {
      throw new ReplayCliError(`bisect confirmation failed at record ${index}`);
    }
  }
  return {
    result: {
      aOffset: offsetAt(a, index),
      bOffset: offsetAt(b, index),
      index,
      kind: index <= a.length && index <= b.length ? "divergence" : "prefix",
      lastCommonDigest,
    },
    stats: { probes, recordsReplayed },
  };
}

export async function bisectFiles(
  aPath: string,
  bPath: string,
  options: BisectOptions = {},
): Promise<{ readonly result: BisectResult; readonly stats: BisectStats }> {
  let a: readonly DumpRecord[];
  let b: readonly DumpRecord[];
  try {
    // Both files use the exact iterateDump/readDump validation path used by ef replay;
    // allowing an empty file is the only E0-T12-specific terminal-state exception.
    a = await readDump(aPath, { allowEmpty: true });
    b = await readDump(bPath, { allowEmpty: true });
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    throw new ReplayCliError(
      `cannot read dump: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const reducer = await loadReducer(options.reducerPath);
  return bisectRecords(a, b, reducer);
}

export async function runBisect(
  aPath: string,
  bPath: string,
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
  options: BisectOptions = {},
): Promise<number> {
  const { result, stats } = await bisectFiles(aPath, bPath, options);
  io.stdout(`${canonicalJson(result)}\n`);
  if (options.stats) {
    io.stderr(`probes=${stats.probes} recordsReplayed=${stats.recordsReplayed}\n`);
  }
  return result.kind === "identical" ? 0 : 1;
}
