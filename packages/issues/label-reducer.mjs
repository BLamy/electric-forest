import { labelInitialState, reduceLabelApplicationEvent } from "./dist/src/labelReducer.js";

export const reducer = (state, record) =>
  reduceLabelApplicationEvent(state, {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
  });
export const initialState = labelInitialState;
