# `@eforest/web-hooks`

Browser bindings for replayed Electric Forest projections.

## Dispatch contract

`useDispatch(streamId)` is versioned by `DISPATCH_HOOK_VERSION = 1`. Its callable return
value posts one event to `POST /api/dispatch` with the same-origin web session and resolves
only with the server-confirmed `{ offset }` receipt. A validator refusal rejects as
`DispatchRefusalError` with the server's `code` and `message` plus the original
`refusedAction`.

The hook never applies an action locally, writes browser storage, or maintains a second
reducer. A confirmation remains pending until the paired `useStreamReducer` checkpoint
reaches its offset. The observable counters are `sent`, `confirmed`, `reconciled`, and
`refused`.

Session dispatch transports a handled validator refusal as a successful HTTP envelope so
Chromium does not emit a spurious resource error. The body remains the validator's exact
structured error, and `x-eforest-refusal-status` carries its original `409`; bearer/API
callers retain HTTP `409`. The hook treats either transport form as the same typed refusal.

Changing the callable API, receipt or refusal fields, reconciliation semantics, or counter
names requires a version bump and regeneration of every downstream browser-write fixture.
