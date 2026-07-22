# `@eforest/platform`

The platform package owns electric-forest's authenticated application boundary. A
`BearerVerifier` validates RS256 access tokens against the configured issuer, audience,
expiry, subject, and cached JWKS. Signature failure or an unknown key ID forces one JWKS
refresh, which makes same-`kid` key rotation replace rather than extend trust.

`PlatformGateway` exposes the web-standard `POST /api/dispatch` request handler. It
authenticates before parsing a dispatch body or touching the stream adapter, rejects any
client-supplied `actor`, injects the verified `sub`, and delegates the accepted append to
`OfficialStreamAdapter`. That adapter composes `@eforest/client`; this package does not
implement or wrap Durable Streams transport behavior.

## Stream namespace contract

Namespace creation uses the same authenticated `/api/dispatch` door. `ns.org.create`
targets `ns:root`; `ns.project.create` and `ns.repo.create` target the exact
`ns:org:<org>` stream. Client payloads contain no actor, owner, subject, or org field.
Accepted namespace events carry `actor: { sub }`, stamped from the verified bearer token.
Malformed payloads are `schema-violation` (422). State-dependent refusals are
`validator-rejected` (409) with one of `ns/name-taken`, `ns/invalid-name`,
`ns/reserved-name`, `ns/org-not-found`, or `ns/project-not-found`; every refusal is
log-neutral.

Production namespace decisions execute in a dedicated Node child whose local module graph
runs inside an isolated VM context. The VM receives JSON strings, not host objects or
functions; exposes no `process`, `fetch`, or `require`; disables string and Wasm code
generation; and links only the compiled `src/ns` decision modules. The child itself starts
under Node's permission model with filesystem writes, child processes, workers, addons,
the inspector, and WASI denied. A content-addressed manifest pins the decision graph and
its small official-stream host adapter, so changing the boundary requires an explicit
reviewed manifest update rather than teaching a source classifier another spelling.

The parent decision layer (dispatcher, gateway, runtime host, adapters — every file under
`packages/platform/src/`) is additionally held by a fail-closed structural sweep: any
module-scope `let`/`var`, any module-scope `const` whose initializer is not in a closed
immutable whitelist, any class static container, any module-scope executable statement,
and any value import of a capability module (`fs` in every spelling, `child_process`,
`vm`, sockets, `sqlite`, …) is a storage tell that fails verification unless it carries a
committed line-anchored disposition. Members reached through aliases, destructuring, or
`Reflect.get` change nothing — the import itself is the tell.

Mutable namespace state is created per replay or per dispatcher instance and is always
rebuilt from stream history. The host adapter can invoke only the existing
`StreamAdapter`; it receives cloned decisions back from the isolated runtime over the
JSON protocol.

Names pass the single exported pure `isNamespaceName` predicate: lowercase ASCII slugs of
1–40 characters, with no leading, trailing, or doubled hyphen. `main`, `ns`, and `fs` are reserved at every
level. Project names are unique within an org. Repo names are unique across the whole org,
not merely within a project, so `org/repo` is unambiguous. The same repo name may exist in
different orgs.

Validation and append are serialized by the official Durable Streams `Stream-Seq` fence.
Each attempt replays the current target log, validates that reduced state, assigns the next
fixed-width application offset, and submits that offset as `Stream-Seq`. A losing writer
replays and validates again; it cannot append a duplicate that the winning event made
invalid. Within one process, namespace dispatches additionally serialize through a
per-dispatcher promise chain, and the cross-process retry loop is progress-observing: it
retries as long as each conflict shows the head advanced (some writer landed), so every
well-formed create in a finite burst is either accepted or refused from re-read state.
Only a conflict stream that stops advancing — a misbehaving store — raises
`NamespaceContentionError`, which the gateway reports as a retryable
`503 { code: "dispatch_failed", reason: "namespace_contention" }`. Internal append
contention is never surfaced as an authentication error.

The `ns:root` log is the sole authority for which per-org namespace streams exist. An
accepted org creation synchronously mints `ns:org:<org>`. Because Durable Streams has no
cross-stream transaction, the dispatcher also reconciles every org recorded in `ns:root`
before namespace mutations. A restart or interruption after the root append but before the
empty org-stream create is therefore repaired idempotently from stream history. Reconciliation
never mints a stream for an org absent from `ns:root`; such dispatches return
`ns/org-not-found` before the official stream-existence check.

E2-T01's `identity.org.created` remains the authorization-domain record for org membership
and grants. E2-T06's `ns.org.create` is the namespace-path record that owns project/repo
resolution. They are distinct event projections with distinct reducers; namespace dispatch
does not duplicate, rewrite, or infer identity membership events.

## Web login configuration

The production entrypoint is `eforest-platform` (or `pnpm --filter @eforest/platform
start` after building). It constructs the OIDC client, transaction manager, identity
stream store, web application, and HTTP server from environment alone.

| Variable             | Required | Meaning                                                                                          |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `EF_OIDC_ISSUER`     | yes      | Absolute HTTP(S) OIDC issuer URL. Discovery is fetched from `/.well-known/openid-configuration`. |
| `EF_OIDC_CLIENT_ID`  | yes      | Public authorization-code client ID used as the ID-token audience.                               |
| `EF_SESSION_SECRET`  | yes      | HMAC secret for the session cookie; it must be at least 32 bytes.                                |
| `EF_SESSION_TTL`     | yes      | Positive whole number of seconds for a web session.                                              |
| `EFOREST_SERVER_URL` | yes      | Existing electric-forest convention for the official Durable Streams server base URL.            |
| `PORT`               | no       | Platform HTTP port; defaults to `4322`.                                                          |

`EF_SESSION_TTL` is measured from the `ts` of the corresponding
`identity.session.started` event. Expiry is derived while replaying the identity stream:
it does not append an expiry event and does not create a platform-local session record.
Consequently, restarting the platform preserves a still-live session as long as the
official stream remains available.

## Cookie and logout contract

The browser receives one cookie named `ef_session`. It is `HttpOnly`, `SameSite=Lax`,
scoped to `/`, and contains only the opaque session ID plus its HMAC signature. It never
contains an access token, ID token, email address, subject, or other claim. Session
validity comes exclusively from the reduced identity stream and the configured TTL.

`POST /auth/logout` appends one `identity.session.ended` event for an active session and
clears the cookie. Logout is idempotent: repeating it for the same ended session clears
the cookie again without attempting another identity-stream append. An expired, forged,
tampered, missing, or already-ended session is treated as logged out without changing the
stream.

## Authentication refusals

Authentication failures use `{ "error": { "class": "auth-refused", "reason": ... } }`.
The mapping is frozen:

| Reason          | HTTP status |
| --------------- | ----------: |
| `bad-state`     |         400 |
| `bad-verifier`  |         400 |
| `reused-code`   |         400 |
| `bad-nonce`     |         400 |
| `bad-token`     |         401 |
| `expired-token` |         401 |

Every refusal is log-neutral: it appends no user or session event.

## CLI credential grants

`POST /api/device-grants` registers a successfully redeemed device access-token JWT by
hash after independently verifying the access token and matching ID-token subject.
`POST /api/cli-tokens`, `GET /api/cli-tokens`, and
`DELETE /api/cli-tokens/:grantId` require a live signed web session. A raw CLI bearer can
never mint or revoke another credential. The mint response shows the opaque secret once;
lists and identity events contain only metadata and the SHA-256 token hash.

`GrantAwareVerifier` resolves both device and web-mint credentials against the replayed
identity authorization view before the dispatch door opens. Before an accepted target
append it also commits `identity.grant.operation.started`, including the exact target
stream and actor-stamped event; after the append it commits the matching
`identity.grant.operation.completed`. The identity reducer refuses to commit a revocation
while an operation for that grant is active. The revoker recovers the frozen target append
with operation-ID producer idempotency, completes it, and retries revocation. A crashed
runtime can therefore resume before or after its target append without duplicating it or
blocking revocation forever. If the frozen target has been deleted or never existed, the
revoker recreates its name as a closed tombstone with the operation producer at epoch 1.
The published server serializes that close-only fence against the original epoch-0 append:
if the append won, its exact event is present and the operation completes; if the fence won,
no user event is present and the revoker durably commits
`identity.grant.operation.aborted` with reason `target-unavailable`. It then revokes the
grant. The tombstoned target name is intentionally not reusable, so a delayed original
writer cannot become valid after revocation. Live target 404s use the same settlement and
never record a false completion. Other transport failures remain retryable and do not
discard the operation. Conversely, a revoke that wins Stream-Seq first makes a later
operation start fail as revoked. This durable lease is the authorization/append boundary shared by
independent platform runtimes, with no process-local lock participating in correctness.
Revocation therefore survives process restart and has no blacklist or platform-local database.

| Error class             | HTTP status |
| ----------------------- | ----------: |
| `token-revoked`         |         401 |
| `web-session-required`  |         401 |
| `grant-already-revoked` |         409 |
| `grant-not-found`       |         404 |

All four refusals are log-neutral. The two grant-revocation refusals leave the identity
head and digest unchanged; `token-revoked` leaves the target stream unchanged.

## Auth0 and local issuer parity

The application has no emulator import, hostname check, port check, or local-only auth
branch. Local verification points `EF_OIDC_ISSUER` and `EF_OIDC_CLIENT_ID` at the pinned
OIDC service. To use a real Auth0 tenant, register the platform's
`/auth/callback` URL as an allowed callback and change only those same two variables to
the Auth0 issuer and public client ID. The session secret, TTL, stream URL, cookie,
routes, event shapes, and verification behavior are unchanged. The authorization-code
client is public and uses PKCE S256; no client secret is read by the platform.

## E2-T08: the project index is a derived stream

The `__registry__` stream is the platform's project index, and it is pure
derivation (ROADMAP bet 4): a projector tails `ns:root` and every
`ns:org:<org>` and appends one `registry.*` derived event per accepted `ns.*`
source event, each carrying `source: { stream, offset }`. The projector's
resume checkpoint is the last derived event's `source` pointer read back from
`__registry__` itself — no side file, no counter outside a stream. Deleting
the materialized index and running `ef registry rebuild --data-dir <dir>`
reproduces it byte-for-byte from the source logs alone (frozen total order:
`ns:root`, then each `ns:org:<org>` in lexicographic order).

Read doors: `GET /registry/public`, `GET /registry/org/:org`,
`GET /registry/me` — snapshot, `?live=long-poll`, and `?live=sse` — each
filtered per requesting identity through the single `filterForIdentity` over
the E2-T01 authorization view. `asOf`, frame ids, and the `after` cursor are
raw `__registry__` offsets for every identity (frozen as not a leak: offset
metadata reveals at most hidden event counts, never entry contents).

### Rename/set-visibility ownership: the creator-only rule and its handoff

`ns.repo.rename` and `ns.repo.set-visibility` (frozen here, additive to
E2-T06's envelope) are authorized by a minimal **creator-only** rule: the
server-stamped actor must equal the repo's recorded creator, else the
dispatch refuses `ns/not-owner` (409 `validator-rejected`, log-neutral).
This rule is deliberately narrower than E2-T07's grant-based per-stream
authorization; E2-T07's grant/role model supersedes and extends it when a
later task widens rename/visibility rights (org admins, delegated grants) —
that task must freeze its own contract and version the change. A repo's
`repoStreamPrefix` is minted at creation and immutable: a rename changes the
listing name only, never the stream prefix.
