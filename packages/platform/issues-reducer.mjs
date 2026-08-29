import {
  issueInitialState,
  issueInitialStateForStream,
  reduceIssueApplicationEvent,
} from "./dist/src/issues/reducer.js";
export const reducer = reduceIssueApplicationEvent;
export const initialState = issueInitialState;
export const initialStateForStream = issueInitialStateForStream;
