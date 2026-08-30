import { stateDigest, type Event, type Offset, OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import {
  PROJECT_EVENT_VERSION,
  PROJECT_FENCE_EVENT,
  PROJECT_REDUCER_ID,
  isProjectActionType,
  isProjectEventShape,
  isProjectFencedEventShape,
  isProjectStreamId,
  parseProjectStreamId,
  projectEventOffset,
  type ProjectActorRole,
  type ProjectQueueRef,
  type ProjectStatus,
} from "./project-events.js";
import { decideProjectTransition } from "./project-transition.js";

export interface ProjectCompletion {
  readonly queue: ProjectQueueRef;
  readonly tasks: number;
  readonly capstone: string;
}

export interface ProjectLaunch {
  readonly offset: Offset;
  readonly run: string;
  readonly actor: string;
  readonly role: ProjectActorRole;
}

/**
 * Canonical `project/v1` state — the authoritative project status of one repository,
 * `replay(project:<org>/<repo>)`. `updatedAt` is the accepted transition event's `ts`;
 * `head` is the offset of the last accepted event (the value a dispatcher must cite as
 * `expectedOffset`). `.eforest/project.json` is a projection of this state, never an input.
 */
export interface ProjectState {
  readonly v: typeof PROJECT_EVENT_VERSION;
  readonly stream: string;
  readonly org: string;
  readonly repo: string;
  readonly status: ProjectStatus;
  readonly statusReason: string;
  readonly updatedAt: number | null;
  readonly actor: string | null;
  readonly actorRole: ProjectActorRole | null;
  readonly head: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly transitions: number;
  readonly launches: number;
  /** Door-appended fences (guarded task loop events bound to this stream); never move `head`. */
  readonly fences: number;
  readonly completion?: ProjectCompletion;
  readonly lastLaunch?: ProjectLaunch;
}

export function projectInitialStateFor(stream: string, org: string, repo: string): ProjectState {
  return {
    v: PROJECT_EVENT_VERSION,
    stream,
    org,
    repo,
    status: "building",
    statusReason: "",
    updatedAt: null,
    actor: null,
    actorRole: null,
    head: OFFSET_BEFORE_FIRST,
    transitions: 0,
    launches: 0,
    fences: 0,
  };
}

/** Identity-less initial state: no stream reference can ever match it (fail closed). */
export const projectInitialState: ProjectState = Object.freeze(projectInitialStateFor("", "", ""));

export function projectInitialStateForStream(streamId: string): ProjectState {
  const identity = parseProjectStreamId(streamId);
  if (identity === undefined) throw new TypeError(`invalid project stream id: ${streamId}`);
  return projectInitialStateFor(streamId, identity.org, identity.repo);
}

function cleanPayload(event: Event): Event {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))
    return event;
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { ...event, payload };
}

/**
 * Total over every event: a well-formed project event with a legal transition at the
 * cited offset advances the state; everything else (unknown types, unknown versions,
 * malformed shapes, stale offsets, illegal transitions) keeps the prior state as a
 * deterministic no-op. The door refused those before append; replay agrees.
 */
export function projectReducer(state: ProjectState, rawEvent: Event): ProjectState {
  if (state.v !== PROJECT_EVENT_VERSION) return state;
  const event = cleanPayload(rawEvent);
  if (event.type === PROJECT_FENCE_EVENT) {
    if (!isProjectFencedEventShape(event) || projectEventOffset(rawEvent) === undefined)
      return state;
    return { ...state, fences: state.fences + 1 };
  }
  if (!isProjectActionType(event.type) || !isProjectEventShape(event)) return state;
  const offset = projectEventOffset(rawEvent);
  if (offset === undefined) return state;
  const transition = decideProjectTransition(state, event, offset);
  return transition.ok ? transition.next : state;
}

export function reduceProjectApplicationEvent(state: unknown, event: Event): ProjectState {
  return projectReducer(state as ProjectState, event);
}

export function replayProjectLog(streamId: string, events: readonly Event[]): ProjectState {
  return events.reduce(projectReducer, projectInitialStateForStream(streamId));
}

export const projectReducerDefinition = Object.freeze({
  id: PROJECT_REDUCER_ID,
  version: PROJECT_EVENT_VERSION,
  initialState: projectInitialState,
  initialStateForStream: projectInitialStateForStream,
  reduce: reduceProjectApplicationEvent,
  digest: stateDigest as (state: unknown) => string,
  matchesStream: isProjectStreamId,
});
