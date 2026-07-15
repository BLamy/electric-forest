import { identityInitialState, identityReducer } from "./dist/src/reducer.js";

// The replay CLI supplies dump metadata (`offset`) alongside the event envelope.
// Keep the public guards exact by adapting that transport record at this boundary.
export const reducer = (state, record) =>
  identityReducer(state, {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
  });
export const initialState = identityInitialState;
