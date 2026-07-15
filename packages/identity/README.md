# `@eforest/identity`

Pure, versioned identity events and the canonical authorization view for Electric Forest.
The package performs no I/O, owns no clock, and persists no derived state. An identity
stream is ground truth; replaying it from offset `-1` rebuilds the complete view.

## Frozen v1 envelope

`IDENTITY_EVENT_VERSION = 1`. Every event is an exact `@eforest/protocol` envelope
`{ type, payload, ts }`; payloads reject extra, missing, or wrong-typed fields.

| Type                          | Exact payload                                     |
| ----------------------------- | ------------------------------------------------- |
| `identity.user.created`       | `{ v: 1, sub, email }`                            |
| `identity.org.created`        | `{ v: 1, orgId, name, ownerSub }`                 |
| `identity.membership.granted` | `{ v: 1, orgId, sub, role: "admin" or "member" }` |
| `identity.membership.revoked` | `{ v: 1, orgId, sub }`                            |
| `identity.grant.issued`       | `{ v: 1, grantId, sub, kind, scopes, tokenHash }` |
| `identity.grant.revoked`      | `{ v: 1, grantId }`                               |
| `identity.session.started`    | `{ v: 1, sessionId, sub }`                        |
| `identity.session.ended`      | `{ v: 1, sessionId }`                             |

`sub` and other opaque ids are non-empty, control-free, NFC strings; `sub` is at most
256 characters. `orgId` is `[a-z0-9][a-z0-9-]{0,63}`. Grant kind is `cli-token` or
`web-session-mint`. Scopes are non-empty canonical strings in strict lexicographic order,
so duplicates and unsorted arrays are refused rather than normalized. `tokenHash` is
exactly 64 lowercase hexadecimal characters. Exact schemas make `token`, `secret`, or any
other smuggled field invalid; raw bearer material never belongs in an event.

## Replay invariants

The reducer rejects duplicate users, orgs, grant ids, or session ids; orgs with unknown
owners; memberships for unknown users/orgs or already-active memberships; revoking an
inactive membership or the owner; grants for unknown users; duplicate token hashes among
active grants; revoking unknown/already-revoked grants; sessions for unknown users; and
ending unknown/already-ended sessions. A revoked grant's hash may be reused by a new grant.
These are replay invariants: `ef replay` fails on the offending line instead of skipping it.

Org creation materializes one permanent active `owner` membership. Revoked memberships and
grants and ended sessions remain in the view with flipped status; re-granting a revoked
membership reactivates it with the newly supplied role.

## Canonical authorization view

```text
{
  users:       { [sub]: { email } },
  orgs:        { [orgId]: { name, ownerSub } },
  memberships: { [orgId]: { [sub]: { role, status } } },
  grants:      { [grantId]: { sub, kind, scopes, tokenHash, status } },
  sessions:    { [sessionId]: { sub, status } }
}
```

`viewDigest(view)` delegates directly to `@eforest/protocol`'s `stateDigest`, which hashes
canonical JSON with SHA-256. Canonical JSON supplies object-key ordering; no second digest
implementation exists here.

The frozen enforcement API is:

- `userForSub(view, sub)`
- `roleOf(view, orgId, sub)`
- `findActiveGrantByTokenHash(view, tokenHash)`
- `isSessionActive(view, sessionId)`

All four are exact, pure queries. Revoked grants never match; owner role comes from the
org's `ownerSub` without a grantable owner event.

## Replay module and golden sensitivity

After `pnpm build`, `packages/identity/reducer.mjs` exports `reducer` and `initialState` for
`ef replay --reducer` and `ef bisect --reducer`. The frozen golden lives under
`.eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/evidence/`.

Every grant-payload byte must either make the mutated dump invalid or change the final
view digest; there are no grant carve-outs. The full-log sweep permits only positions whose
mutation is rejected, changes the digest, or independently folds to the exact original
view. Expected green positions are envelope `ts` changes (timestamps are deliberately not
authorization state) and mutations that parse to canonically identical JSON. They are
asserted, never skipped.

Changing the event envelope, any payload schema, the view shape, reducer semantics, or the
four query signatures requires an `IDENTITY_EVENT_VERSION` bump and regeneration of every
identity golden in the repository. Checks consume the committed digest; they never create
or bless it.
