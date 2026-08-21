import {
  issueInitialState,
  issueInitialStateForStream,
  issueReducer,
} from "./dist/src/issues/reducer.js";
export const reducer = (state, record) =>
  issueReducer(state, { type: record.type, payload: record.payload, ts: record.ts });
export const initialState = issueInitialState;
export const initialStateForStream = issueInitialStateForStream;
