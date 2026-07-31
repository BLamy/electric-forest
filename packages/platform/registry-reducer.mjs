// E2-T08: the registry reducer registered for the repo's replay instrument
// (`ef replay <dump> --digest --reducer packages/platform/registry-reducer.mjs`),
// following the ns-reducer.mjs / identity reducer.mjs E0-T10 convention.
// The replay CLI supplies dump metadata (`offset`) alongside the event
// envelope; adapt that transport record at this boundary.
import { registryInitialState, registryReducer } from "../reducers/dist/src/index.js";

export const reducer = (state, record) =>
  registryReducer(state, {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
  });
export const initialState = registryInitialState;
