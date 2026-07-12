import {
  fixtureInitialState,
  fixtureReducer,
  type FixtureState,
} from "@eforest/protocol/fixtures/reducer";
import type { Event } from "@eforest/protocol";
import { ReducerRegistry } from "./registry.js";

export interface AlternateState {
  readonly total: number;
  readonly lastType: string | null;
}

export const alternateInitialState: AlternateState = { total: 0, lastType: null };

export interface CounterState {
  readonly count: number;
}

export const counterInitialState: CounterState = { count: 0 };

export function counterReducer(state: CounterState, event: Event): CounterState {
  switch (event.type) {
    case "counter/increment":
      return { count: state.count + Number(event.payload) };
    case "counter/decrement":
      return { count: state.count - Number(event.payload) };
    default:
      return state;
  }
}

export function alternateReducer(state: AlternateState, event: Event): AlternateState {
  return { total: state.total + 1, lastType: event.type };
}

export function createDefaultReducerRegistry(): ReducerRegistry {
  const registry = new ReducerRegistry();
  const fixtureActions = ["set", "increment", "push", "meta"];
  registry.register<FixtureState>(
    "fixture",
    fixtureReducer,
    "fixture-v1",
    fixtureInitialState,
    fixtureActions,
  );
  registry.register<FixtureState>(
    "default",
    fixtureReducer,
    "fixture-v1",
    fixtureInitialState,
    fixtureActions,
  );
  registry.register<AlternateState>(
    "alternate",
    alternateReducer,
    "alternate-v1",
    alternateInitialState,
    fixtureActions,
  );
  registry.register<CounterState>("counter", counterReducer, "counter-v1", counterInitialState, [
    "counter/increment",
    "counter/decrement",
  ]);
  return registry;
}
