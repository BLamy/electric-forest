console.log("LOAD-NOISE");

export const initialState = { count: 0 };

export function reducer(state, event) {
  process.stdout.write(`REDUCE-NOISE:${event.type}\n`);
  return { count: state.count + 1 };
}
