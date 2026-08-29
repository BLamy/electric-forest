import { canonicalJson, compareOffsets, type Offset } from "@eforest/protocol";
import type { StreamRecord } from "@eforest/client";
import type { WorkspaceState } from "@eforest/workspace";
import type { WorkingTreeClassification } from "../classify.js";

export interface RepairDecision {
  readonly phase: "repair";
  readonly action: "confirmed";
  readonly path: string;
  readonly offset: Offset;
}

export interface UplinkPlanEntry {
  readonly phase: "uplink";
  readonly action: "dispatched";
  readonly path: string;
  readonly base: string;
}

export interface DownlinkDecision {
  readonly phase: "downlink";
  readonly action: "applied" | "suppressed";
  readonly path: string;
  readonly offset: Offset;
}

export interface RefusedDecision {
  readonly phase: "uplink";
  readonly action: "refused";
  readonly path: string;
  readonly base: string;
}

export type ReconcileDecision =
  RepairDecision | DownlinkDecision | UplinkPlanEntry | RefusedDecision;

export interface ReconcileSummary {
  readonly repaired: number;
  readonly applied: number;
  readonly dispatched: number;
  readonly refused: number;
  readonly checkpoint: { readonly from: Offset; readonly to: Offset };
}

export interface ReconcileClient {
  readonly branch: {
    read: (from: Offset) => Promise<readonly StreamRecord[]>;
  };
}

/** Confirm journal provenance against the authoritative branch without dispatching. */
export function repairJournal(
  journal: readonly { readonly kind: string; readonly path: string; readonly offset?: string }[],
  streamEvents: readonly Pick<StreamRecord, "offset">[],
): readonly RepairDecision[] {
  const assigned = new Set(streamEvents.map((record) => record.offset as string));
  return journal.flatMap((record) => {
    if (record.kind !== "accepted" || record.offset === undefined) return [];
    if (!assigned.has(record.offset)) {
      throw new Error(`reconcile/journal-offset-unassigned: ${record.offset}`);
    }
    return [
      {
        phase: "repair" as const,
        action: "confirmed" as const,
        path: record.path,
        offset: record.offset as Offset,
      },
    ];
  });
}

/** Build a deterministic path-ordered uplink plan from ledger classification only. */
export function planUplink(
  classification: Pick<WorkingTreeClassification, "added" | "deleted" | "modified">,
  downlinkTouchedPaths: readonly string[],
  ledgerView: Pick<WorkspaceState, "files">,
): readonly UplinkPlanEntry[] {
  const touched = new Set(downlinkTouchedPaths);
  const paths = [
    ...new Set([...classification.added, ...classification.deleted, ...classification.modified]),
  ]
    .filter((path) => !touched.has(path))
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return paths.map((path) => ({
    phase: "uplink" as const,
    action: "dispatched" as const,
    path,
    base: ledgerView.files[path]?.base ?? "BASE_NONE",
  }));
}

export function decisionLine(decision: ReconcileDecision): string {
  return `${canonicalJson(decision)}\n`;
}

export async function reconcile(
  workspace: WorkspaceState,
  client: ReconcileClient,
): Promise<ReconcileSummary> {
  const from = workspace.headOffset as Offset;
  const records = await client.branch.read(from);
  const to = records.at(-1)?.offset ?? from;
  return {
    repaired: 0,
    applied: records.length,
    dispatched: 0,
    refused: 0,
    checkpoint: { from, to },
  };
}

export function isAfter(left: Offset, right: Offset): boolean {
  return compareOffsets(left, right) > 0;
}
