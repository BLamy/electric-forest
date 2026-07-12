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

export function alternateReducer(state: AlternateState, event: Event): AlternateState {
  return { total: state.total + 1, lastType: event.type };
}

export function createDefaultReducerRegistry(): ReducerRegistry {
  const registry = new ReducerRegistry();
  registry.register<FixtureState>("fixture", fixtureReducer, "fixture-v1", fixtureInitialState);
  registry.register<FixtureState>("default", fixtureReducer, "fixture-v1", fixtureInitialState);
  registry.register<AlternateState>(
    "alternate",
    alternateReducer,
    "alternate-v1",
    alternateInitialState,
  );
  return registry;
}
