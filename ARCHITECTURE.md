# Runtime architecture

electric-forest is an application on Electric Durable Streams. It is not a competing
Durable Streams server.

## Ownership boundary

| Concern                                                                                   | Owner used by electric-forest                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Durable Streams HTTP protocol, persistence, live reads, writer coordination, native forks | Published `@durable-streams/client` and `@durable-streams/server`; Electric Cloud in deployed environments |
| Local Durable Streams process                                                             | `@durable-streams/server@0.3.8` with the checked-in pnpm patch for snapshot retention (`pnpm server:serve`) |
| Files, directories, patches, snapshots, branch metadata, merges, digests                  | `@eforest/streamfs`, as application events stored in official JSON streams                                 |
| Reducer validation and the authenticated mutation door                                    | electric-forest platform service; it appends accepted application events to Electric Cloud                 |
| Auth0/OIDC emulation                                                                      | pinned `blamy/emulate` submodule and `@emulators/auth0`                                                    |

`@eforest/server` is still only a launcher and re-export. The checked-in provider patch
is deliberately narrower than a second transport: it keeps the upstream server/store
and adds only the snapshot-compaction admin route, retained-prefix dump, and the
protocol-valid 410 boundary needed by E4-T03. Standard Durable Streams routes remain
upstream code.

## Application offsets

Electric transport offsets are opaque cursors and belong to Electric. electric-forest
needs stable event identities for reducer state, digests, evidence links, and branch
logic, so every JSON stream item carries a separate, canonical application `offset`.
Writers allocate the next padded application offset, submit it as the lexicographically
ordered `Stream-Seq`, and retry a rejected race after replaying current state. This keeps
application replay deterministic without interpreting or forging Electric's cursor.

Native head forks preserve the parent prefix and therefore preserve application offset
space across branches. The branch's own fork marker and later events continue after the
inherited prefix. Historic forks need an explicit application-offset to transport-offset
map; until that map lands, the cloud transport refuses a historic fork instead of
silently creating the wrong branch.

## Emulator rule

If `blamy/emulate` exposes a Durable Streams emulator, it must be a thin, version-pinned
launcher around the published `@durable-streams/server`. The local E4-T03 provider patch
is an explicit, temporary upstream fork because the latest published server still has
no retention/compaction operation; it must stay a minimal patch, never embed the retired
electric-forest server, and be removed or reduced when upstream provides equivalent
retention semantics. Shared fault scenarios and adversarial fixtures can move into the
emulator; a second transport cannot.

## Migration rule

New work follows these constraints:

1. Add protocol behavior upstream when Electric owns it; while upstream has no retention
   operation, keep the smallest pinned provider patch here and upgrade/rebase it after
   every published server release.
2. Add repository, filesystem, merge, identity, issue, or workflow behavior here as
   application events and reducers.
3. Prove every transport-facing change with `_v-official-streamfs` against the published
   reference server.
4. Never add a second Durable Streams transport to this repository.
