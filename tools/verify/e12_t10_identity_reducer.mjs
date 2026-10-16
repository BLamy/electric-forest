import { emptyView, identityReducer } from "../../packages/identity/dist/src/index.js";
export const initialState = emptyView();
export function reducer(state, record) {
  return identityReducer(state, { type: record.type, payload: record.payload, ts: record.ts });
}
