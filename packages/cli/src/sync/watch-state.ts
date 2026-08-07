import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WATCH_PID_NAME = "watch.pid" as const;
export const WATCH_READY_NAME = "watch.ready" as const;
export const WATCH_DIVERGENCE_NAME = "watch-diverged" as const;

export interface WatchState {
  readonly running: boolean;
  readonly pid?: number;
}

export function watchPidPath(root: string): string {
  return join(root, ".ef", WATCH_PID_NAME);
}

export function watchReadyPath(root: string): string {
  return join(root, ".ef", WATCH_READY_NAME);
}

export function watchDivergencePath(root: string): string {
  return join(root, ".ef", WATCH_DIVERGENCE_NAME);
}

export function readWatchPid(root: string): number | undefined {
  const path = watchPidPath(root);
  if (!existsSync(path)) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readWatchState(root: string): WatchState {
  const pid = readWatchPid(root);
  return pid === undefined || !isProcessAlive(pid) ? { running: false } : { running: true, pid };
}
