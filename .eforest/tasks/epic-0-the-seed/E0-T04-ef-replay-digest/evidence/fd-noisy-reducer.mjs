import { writeSync } from "node:fs";

writeSync(1, "FD-LOAD-NOISE\n");

export const initialState = { count: 0 };

export function reducer(state, event) {
  writeSync(1, `FD-REDUCE-NOISE:${event.type}\n`);
  return { count: state.count + 1 };
}
