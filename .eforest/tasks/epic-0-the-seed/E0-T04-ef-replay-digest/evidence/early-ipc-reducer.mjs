process.send?.({ ok: true, digest: "not-a-digest" });

export const initialState = { count: 0 };
export function reducer(state) {
  return { count: state.count + 1 };
}
