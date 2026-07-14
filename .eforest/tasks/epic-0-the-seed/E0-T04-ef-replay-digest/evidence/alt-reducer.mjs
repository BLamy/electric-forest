export const initialState = { seen: [] };

export function reducer(state, event) {
  return { seen: [...state.seen, `${event.type}:${event.ts}`] };
}
