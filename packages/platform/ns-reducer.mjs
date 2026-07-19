import { namespaceInitialState, namespaceReducer } from "./dist/src/ns/reducer.js";

export const reducer = (state, record) =>
  namespaceReducer(state, {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
  });
export const initialState = namespaceInitialState;
