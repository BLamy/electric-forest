---
id: E3-T03
epic: 3
title: "useStreamReducer: read and follow official-stream-backed application events in the browser"
priority: 303
status: in-progress
depends_on: [E3-T01, E3-T02b]
estimate: L
capstone: false
---

## Goal

`@eforest/web-hooks` exports `useStreamReducer`, the browser data path for every
stream-backed view. The hook requests an authorized application-event bootstrap from
`@eforest/platform`, folds those canonical events with the same reducer used by
`ef replay`, and follows later events from the returned application checkpoint.

The platform uses `@durable-streams/client` to read/follow Electric Durable Streams;
the browser API is an authenticated application projection, not an implementation or
proxy clone of the Durable Streams HTTP protocol. There is no server-materialized
reducer state endpoint and no second reducer.

## Deliverables

- `packages/web-hooks/src/useStreamReducer.ts` returning
  `{ state, checkpoint, digest, status }`.
- Platform application-event bootstrap/follow handlers backed by the official client.
- Reducer registry shared by CLI, platform validation, and browser bundles.
- Reconnect, hydration-boundary, duplicate, truncation, and malformed-event tests.
- A stream-inspector route exposing stream id, application checkpoint, digest, and
  reducer version in the DOM.

## Acceptance criteria

- [ ] Initial state equals `ef replay` over exactly the returned canonical event range.
- [ ] Events landing between bootstrap and follow are neither skipped nor duplicated.
- [ ] Disconnect resumes from the last application checkpoint without a full reset.
- [ ] Browser, CLI, and independent replay produce identical canonical state digests at
      the same checkpoint.
- [ ] The network trace contains only platform application APIs; it does not expose
      retired custom state/event endpoints or direct browser credentials for Electric.
- [ ] A malformed event fails loudly with the offending application offset.
- [ ] Playwright and Replay evidence show live convergence with zero console errors.

## Adversarial verification

1. Append at the bootstrap/follow boundary under repeated forced reconnects.
2. Duplicate, truncate, and reorder frames; silent digest convergence is a refutation.
3. Block further bootstrap requests after first load; recoverable reconnects must still
   converge from the saved checkpoint.
4. Compare source coverage against the browser recording and the independent replay log.
5. Search for a server-owned materialized reducer cache or a second transport client.

## Verification log

(appended by builder and critic)
