export const initialState = Object.freeze({ opened: [] });

export function reducer(state, event) {
  if (
    event.type !== "gate.opened" ||
    event.payload === null ||
    typeof event.payload !== "object" ||
    event.payload.v !== 1 ||
    typeof event.payload.path !== "string"
  ) {
    throw new TypeError("expected gate.opened v1 event");
  }
  return {
    opened: [
      ...state.opened,
      {
        path: event.payload.path,
        actor: event.payload.actor,
        writer: event.payload.writer,
      },
    ],
  };
}
