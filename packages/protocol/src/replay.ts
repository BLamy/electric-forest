import type { Event } from "./envelope.js";

export function replay<S>(
  events: Iterable<Event>,
  reducer: (state: S, event: Event) => S,
  initialState: S,
): S {
  let state = initialState;
  for (const event of events) state = reducer(state, event);
  return state;
}
