import { BASE_NONE, type WorkspaceFileBase } from "@eforest/workspace";

export const UPLINK_TEMP_PATTERNS = Object.freeze([
  "basename ending in ~",
  "basename starting with .#",
  "basename ending in .swp or .swo",
  "basename ending in .tmp",
]);

export type PendingFsEventKind = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export interface PendingFsEvent {
  readonly kind: PendingFsEventKind;
  readonly path: string;
}

export interface UplinkLedgerView {
  readonly files: Readonly<Record<string, WorkspaceFileBase>>;
  /** Directory history is kept in-memory by the engine; the v1 workspace format stores files. */
  readonly directories?: readonly string[];
}

export type UplinkPlanKind = "mkdir" | "rmdir" | "create" | "write" | "delete";

export interface UplinkPlanEntry {
  readonly kind: UplinkPlanKind;
  readonly path: string;
  readonly base: string;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function isExcludedUplinkPath(path: string): boolean {
  if (path === ".ef" || path.startsWith(".ef/")) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    basename.endsWith("~") ||
    basename.startsWith(".#") ||
    basename.endsWith(".swp") ||
    basename.endsWith(".swo") ||
    basename.endsWith(".tmp")
  );
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

function actionRank(kind: UplinkPlanKind): number {
  switch (kind) {
    case "mkdir":
      return 0;
    case "delete":
      return 1;
    case "create":
      return 2;
    case "write":
      return 3;
    case "rmdir":
      return 4;
  }
}

function planSort(left: UplinkPlanEntry, right: UplinkPlanEntry): number {
  return actionRank(left.kind) - actionRank(right.kind) || compareUtf8(left.path, right.path);
}

function hasDirectoryHistory(path: string, ledger: UplinkLedgerView): boolean {
  if (ledger.directories?.includes(path)) return true;
  for (const file of Object.keys(ledger.files)) {
    if (file.startsWith(`${path}/`)) return true;
  }
  return false;
}

/**
 * Turn a chokidar burst into a deterministic metadata plan.
 *
 * This function intentionally never infers rename: an unlink followed by an
 * add is represented as delete plus create/write. The filesystem is consulted
 * by UplinkEngine only after this pure planning step.
 */
export function coalesce(
  pendingFsEvents: readonly PendingFsEvent[],
  ledger: UplinkLedgerView,
): readonly UplinkPlanEntry[] {
  const byPath = new Map<string, PendingFsEvent[]>();
  for (const event of pendingFsEvents) {
    if (event.path.length === 0 || isExcludedUplinkPath(event.path)) continue;
    const list = byPath.get(event.path) ?? [];
    list.push(event);
    byPath.set(event.path, list);
  }

  const plan: UplinkPlanEntry[] = [];
  for (const [path, events] of byPath) {
    const fileEvents = events.filter(
      (event) => event.kind !== "addDir" && event.kind !== "unlinkDir",
    );
    const directoryEvents = events.filter(
      (event) => event.kind === "addDir" || event.kind === "unlinkDir",
    );
    const base = ledger.files[path];
    const hadFileHistory = base !== undefined;
    const sawUnlink = fileEvents.some((event) => event.kind === "unlink");
    const finalFilePresent = fileEvents.at(-1)?.kind !== "unlink" && fileEvents.length > 0;

    if (fileEvents.length > 0) {
      if (!finalFilePresent) {
        if (hadFileHistory) {
          plan.push({ kind: "delete", path, base: base.base });
        }
      } else if (hadFileHistory && sawUnlink) {
        plan.push({ kind: "delete", path, base: base.base });
        plan.push({ kind: "create", path, base: BASE_NONE });
        plan.push({ kind: "write", path, base: BASE_NONE });
      } else if (hadFileHistory) {
        plan.push({ kind: "write", path, base: base.base });
      } else {
        plan.push({ kind: "create", path, base: BASE_NONE });
        plan.push({ kind: "write", path, base: BASE_NONE });
      }
    }

    if (directoryEvents.length > 0) {
      const finalDirectoryPresent = directoryEvents.at(-1)?.kind !== "unlinkDir";
      if (finalDirectoryPresent) {
        if (directoryEvents.some((event) => event.kind === "addDir")) {
          plan.push({ kind: "mkdir", path, base: BASE_NONE });
        }
      } else if (hasDirectoryHistory(path, ledger)) {
        plan.push({ kind: "rmdir", path, base: BASE_NONE });
      }
    }
  }

  // Chokidar can deliver a nested file before the addDir event for its parent.
  // Preserve the pinned directory-before-content property for any explicit
  // directory events without manufacturing events for absent parents.
  return plan.sort(planSort);
}

export function sortUplinkPlan(plan: readonly UplinkPlanEntry[]): readonly UplinkPlanEntry[] {
  return [...plan].sort(planSort);
}

export function directoryParentsForPlan(
  plan: readonly UplinkPlanEntry[],
): readonly UplinkPlanEntry[] {
  const directories = new Set<string>();
  for (const entry of plan) {
    if (entry.kind === "create" || entry.kind === "write") {
      for (const parent of parentDirectories(entry.path)) directories.add(parent);
    }
  }
  return [...directories]
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || compareUtf8(left, right);
    })
    .map((path) => ({ kind: "mkdir" as const, path, base: BASE_NONE }));
}
