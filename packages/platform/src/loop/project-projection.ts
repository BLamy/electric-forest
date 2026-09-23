import { canonicalJson, stateDigest, type Offset, OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { PROJECT_STATES, type ProjectActorRole, type ProjectStatus } from "./project-events.js";
import type { ProjectState } from "./project-reducer.js";

/**
 * The `.eforest/project.json` projection: a deterministic function of `ProjectState`
 * alone. It is written by replay and read by people and folder tooling; the guard
 * never reads it, so editing or deleting the file cannot change a server decision and
 * the next replay overwrites it byte-for-byte.
 */
export interface ProjectProjection {
  readonly name: string;
  readonly status: ProjectStatus;
  readonly statusValues: readonly ProjectStatus[];
  readonly loop: "loop.md";
  readonly tasks: "tasks";
  readonly mainStream: string;
  readonly statusReason: string;
  /** ISO-8601 UTC of the accepted transition's event `ts`; null before any transition. */
  readonly updatedAt: string | null;
  readonly actor: string | null;
  readonly actorRole: ProjectActorRole | null;
  readonly stream: string;
  readonly offset: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly stateDigest: string;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Pure civil-date conversion (no `Date`, no host clock, no locale, no time zone). */
export function isoFromMillis(millis: number): string {
  const ms = Math.floor(millis);
  const days = Math.floor(ms / 86_400_000);
  const rem = ms - days * 86_400_000;
  // Howard Hinnant's civil_from_days.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const hours = Math.floor(rem / 3_600_000);
  const minutes = Math.floor((rem % 3_600_000) / 60_000);
  const seconds = Math.floor((rem % 60_000) / 1000);
  const fraction = rem % 1000;
  return `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(fraction, 3)}Z`;
}

export function projectProjection(state: ProjectState): ProjectProjection {
  return {
    name: state.repo,
    status: state.status,
    statusValues: [...PROJECT_STATES],
    loop: "loop.md",
    tasks: "tasks",
    mainStream: `fs:${state.org}/${state.repo}:main:meta`,
    statusReason: state.statusReason,
    updatedAt: state.updatedAt === null ? null : isoFromMillis(state.updatedAt),
    actor: state.actor,
    actorRole: state.actorRole,
    stream: state.stream,
    offset: state.head,
    stateDigest: stateDigest(state),
  };
}

/** The exact bytes of `.eforest/project.json` for this state: canonical JSON + newline. */
export function projectProjectionBytes(state: ProjectState): string {
  return `${canonicalJson(projectProjection(state))}\n`;
}
