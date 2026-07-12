import type { Event } from "../src/envelope.js";

export interface FixtureState {
  readonly count: number;
  readonly values: readonly unknown[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export const fixtureInitialState: FixtureState = { count: 0, values: [], meta: {} };

export function fixtureReducer(state: FixtureState, event: Event): FixtureState {
  switch (event.type) {
    case "increment":
      return { ...state, count: state.count + Number(event.payload) };
    case "push":
      return { ...state, values: [...state.values, event.payload] };
    case "meta":
      return { ...state, meta: event.payload as Record<string, unknown> };
    default:
      return state;
  }
}
