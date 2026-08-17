import { canonicalJson } from "@eforest/protocol";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SYNC_SCHEDULE_VERSION = 1 as const;
export type SyncMachine = "A" | "B";
export type SyncMode = "lockstep" | "free";

export type SyncOperation =
  | { readonly type: "write"; readonly path: string; readonly contentRef: string }
  | { readonly type: "append"; readonly path: string; readonly contentRef: string }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "rename"; readonly from: string; readonly to: string }
  | { readonly type: "stop"; readonly machine: SyncMachine }
  | { readonly type: "kill"; readonly machine: SyncMachine }
  | { readonly type: "restart"; readonly machine: SyncMachine }
  | { readonly type: "barrier" };

export interface SyncScheduleStep {
  readonly step: number;
  readonly machine: SyncMachine;
  readonly op: SyncOperation;
}

export interface SyncSchedule {
  readonly version: typeof SYNC_SCHEDULE_VERSION;
  readonly seed: number;
  readonly profile: string;
  readonly steps: readonly SyncScheduleStep[];
}

export interface SyncTranscriptStep {
  readonly step: number;
  readonly machine: SyncMachine;
  readonly op: SyncOperation;
  readonly digestA: string;
  readonly digestB: string;
  readonly headOffset: string;
}

export interface SyncTranscript {
  readonly version: typeof SYNC_SCHEDULE_VERSION;
  readonly seed: number;
  readonly profile: string;
  readonly mode: SyncMode;
  readonly steps: readonly SyncTranscriptStep[];
  readonly final: {
    readonly digestA: string;
    readonly digestB: string;
    readonly replayDigest: string;
    readonly appliedOffsetsA?: number;
    readonly appliedOffsetsB?: number;
  };
}

class XorShift32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.next() % values.length]!;
  }
}

const paths = ["docs/readme.txt", "src/naïve.bin", "nested/機械.json", "notes/todo.md"];
const contents = ["alpha", "bravo", "charlie", "delta"];

/** Expand a seed without wall-clock, process, or filesystem inputs. */
export function expandSchedule(seed: number, profile = "default"): SyncSchedule {
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new RangeError("seed must be a non-negative integer");
  const random = new XorShift32(seed);
  const steps: SyncScheduleStep[] = [];
  const add = (machine: SyncMachine, op: SyncOperation): void => {
    steps.push({ step: steps.length, machine, op });
  };

  if (profile === "offline") {
    add("A", { type: "write", path: paths[0]!, contentRef: contents[0]! });
    add("B", { type: "barrier" });
    add("A", { type: "stop", machine: "A" });
    add("B", { type: "stop", machine: "B" });
    add("A", {
      type: "write",
      path: "offline/a.txt",
      contentRef: contents[random.next() % contents.length]!,
    });
    add("B", {
      type: "write",
      path: "offline/b.txt",
      contentRef: contents[random.next() % contents.length]!,
    });
    add("A", {
      type: "append",
      path: "offline/a.txt",
      contentRef: contents[random.next() % contents.length]!,
    });
    add("B", { type: "rename", from: paths[0]!, to: "docs/offline-renamed.txt" });
    add("A", { type: "restart", machine: "A" });
    add("B", { type: "restart", machine: "B" });
    add("B", { type: "barrier" });
    return { version: SYNC_SCHEDULE_VERSION, seed, profile, steps };
  }

  add("A", { type: "write", path: paths[0]!, contentRef: contents[0]! });
  add("B", { type: "barrier" });
  add("A", { type: "stop", machine: "B" });
  add("A", {
    type: "write",
    path: paths[1 + (random.next() % (paths.length - 1))]!,
    contentRef: contents[random.next() % contents.length]!,
  });
  add("A", {
    type: "append",
    path: paths[0]!,
    contentRef: contents[random.next() % contents.length]!,
  });
  add("A", { type: "kill", machine: "A" });
  add("A", { type: "restart", machine: "A" });
  add("A", { type: "restart", machine: "B" });
  add("B", { type: "rename", from: paths[0]!, to: "docs/renamed.txt" });
  add("A", { type: "delete", path: paths[1]! });
  add("B", { type: "barrier" });
  return { version: SYNC_SCHEDULE_VERSION, seed, profile, steps };
}

export function serializeSchedule(schedule: SyncSchedule): string {
  return `${canonicalJson(schedule)}\n`;
}

export function canonicalTranscript(transcript: SyncTranscript): string {
  return `${canonicalJson(transcript)}\n`;
}

export function assertTranscriptCanon(text: string): void {
  if (
    /\/(?:private\/)?tmp\/|[A-Za-z]:\\|(?:^|[" ])(?:pid|port|timestamp|duration)\s*[:=]/i.test(text)
  ) {
    throw new Error("transcript contains runtime-specific data");
  }
  if (/\b20\d{2}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(text)) {
    throw new Error("transcript contains a wall-clock timestamp");
  }
}

export interface WorktreeMismatch {
  readonly path: string;
  readonly kind: "missing-left" | "missing-right" | "content" | "type";
}

function visibleEntries(root: string): Map<string, "file" | "directory"> {
  const entries = new Map<string, "file" | "directory">();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === ".ef") continue;
      const path = join(directory, name);
      const rel = relative(root, path);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        entries.set(rel, "directory");
        visit(path);
      } else if (stat.isFile()) {
        entries.set(rel, "file");
      }
    }
  };
  visit(root);
  return entries;
}

/** Return every visible byte/type mismatch, in canonical relative-path order. */
export function compareWorktrees(left: string, right: string): readonly WorktreeMismatch[] {
  const leftEntries = visibleEntries(left);
  const rightEntries = visibleEntries(right);
  const paths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort();
  const mismatches: WorktreeMismatch[] = [];
  for (const path of paths) {
    const leftType = leftEntries.get(path);
    const rightType = rightEntries.get(path);
    if (leftType === undefined) {
      mismatches.push({ path, kind: "missing-left" });
    } else if (rightType === undefined) {
      mismatches.push({ path, kind: "missing-right" });
    } else if (leftType !== rightType) {
      mismatches.push({ path, kind: "type" });
    } else if (
      leftType === "file" &&
      !readFileSync(join(left, path)).equals(readFileSync(join(right, path)))
    ) {
      mismatches.push({ path, kind: "content" });
    }
  }
  return mismatches;
}

/** Frozen E4-T06 mapping used to detect duplicate or lost uplink mutations. */
export function expectedMutationCount(schedule: SyncSchedule): number {
  return schedule.steps.reduce((count, { op }) => {
    if (op.type === "write" || op.type === "append" || op.type === "delete") return count + 1;
    if (op.type === "rename") return count + 2;
    return count;
  }, 0);
}
