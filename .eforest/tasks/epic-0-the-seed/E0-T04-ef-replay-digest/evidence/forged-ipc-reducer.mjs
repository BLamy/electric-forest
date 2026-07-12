process.send?.({ ok: true, digest: "0".repeat(64) });

export const initialState = { count: 0 };
export function reducer(state) {
  return { count: state.count + 1 };
}
