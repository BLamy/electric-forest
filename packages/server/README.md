# `@eforest/server`

The server has two mutation doors. The raw protocol `POST /streams/:id` remains the
E0-T05/T09 compatibility door for protocol conformance. Reducer-backed streams are
mutated through `POST /streams/:id/dispatch`; dispatch validates the action before it
reaches the append wrapper.

## Validated dispatch contract

The dispatch pipeline is deliberately ordered:

1. Parse the JSON body (`malformed-body`, HTTP 400).
2. Validate the exact `{ type, payload, ts }` action envelope and canonical JSON values
   (`schema-violation`, HTTP 422).
3. Require the action type in the stream reducer's registered action set
   (`unknown-action-type`, HTTP 404).
4. Run every registered `ActionValidator` against the action. A validator may lazily
   read the reduced state at the captured head offset (`validator-rejected`, HTTP 409).

Every taxonomy refusal is returned as:

```json
{
  "error": {
    "class": "<class>",
    "actionType": "<optional>",
    "field": "<optional>",
    "reason": "<reason>"
  }
}
```

| class                 | status | meaning                                                                            |
| --------------------- | -----: | ---------------------------------------------------------------------------------- |
| `malformed-body`      |    400 | body is empty, invalid JSON, too large, or has an unusable content type            |
| `schema-violation`    |    422 | parsed JSON is not exactly the frozen action envelope                              |
| `unknown-action-type` |    404 | the existing stream has no reducer or the action is not registered for its reducer |
| `validator-rejected`  |    409 | a registered validator rejected the action for its current state                   |

`POST /streams/:missing/dispatch` keeps T05's `{"error":"stream_not_found",...}` 404
body and has no `error.class`; it is outside this taxonomy. An existing stream without a
registered reducer returns the taxonomy's `unknown-action-type` body, which distinguishes
the two 404 cases. The built-in `counter` reducer and `counter/decrement` validator are
the shipped state-dependent extension-point example.

The append wrapper is the only source-level invocation of `StreamStore.append`. It counts
raw and dispatch traffic independently, making the two-door audit executable. Refused
dispatches never call it, never publish a live frame, and leave the stream head and replay
digest unchanged.
