---
id: E14-T01
epic: 14
title: "Freeze changesets, complete immutable file versions, and the legacy boundary"
priority: 551
status: pending
depends_on: [E15-T03]
estimate: M
capstone: false
---

## Goal

`@eforest/changesets` (`packages/changesets`) defines versioned `ContentObjectV1`,
`FileVersionV1`, `ChangesetV1` and `SourceMigrationBoundaryV1` contracts. New source
history consists of changesets linking complete immutable file versions; textual
diffs are computed in memory and are never persisted in new branch, content, changeset
or review state. Existing verified patch streams and evidence remain readable,
byte-identical historical records behind an explicit append-only migration boundary.

## Context

Priorities 551-556 place this epic after E13 design and E15's provider decision and
before the remaining hosted-loop work. E15 may recommend decline or conditional;
neither blocks this stream-native implementation or authorizes a production database.

The useful precedent from
`https://www.anthropic.com/engineering/redesigning-source-control` is a changeset's
changed-file list relative to its first parent, with content-addressed pointers to full
file contents. Forest retains its authenticated dispatch door, official Durable
Streams transport, reducers and native stream forks. No Spanner, blob service, SQL
authority or second transport is introduced. An alternative object store needs a
separate explicit future human architecture decision.

Freeze a repo-scoped object address such as
`source-object:<org>/<repo>/<sha256>` with strict canonical parsing. The SHA-256 is over
exact full uncompressed bytes, including text encoding/line endings or arbitrary binary
bytes. Equal bytes reuse the address within the authorized scope; changing bytes
changes the address. Path and rename identity are separate from content identity.
`FileVersionV1` includes immutable file identity, content reference/size and mode;
mode-only changes create a new version descriptor while reusing unchanged content.
Changesets carry ordered parents, changed paths/tombstones, version references,
provenance, expected parent and resulting tree digest. Their identifiers hash canonical
versioned bytes, not process time, transport cursors or a mutable branch label.

Only redacted agent tool logs may retain textual patch payloads, and source recovery
must work without those logs. Legacy histories are an explicit frozen exception; do
not delete, rewrite, renumber, rehash or re-bless their events, verdicts or evidence.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- `packages/changesets/src/contracts.ts`, canonical encoding/hash helpers using
  `@eforest/protocol`, pure validation/reduction and package documentation.
- `docs/decisions/changeset-source-model.md` defining object completion, publication,
  file/rename identity, first/merge parents, provenance, reviewer anchors, conflict
  references, retry identity and memory-only comparison boundaries.
- Frozen fixtures for literal `.patch` file contents, empty bytes, CRLF/Unicode text, binary, identical content at
  different paths, rename, mode-only change, deletion, a two-parent merge and legacy
  baseline provenance; pin expected object/version/changeset/tree digests independently.
- A finite compatibility catalog naming existing E1/E3/E4/E5 filesystem, CLI, fork,
  merge/conflict and review behaviors plus their preserved verify targets.
- Proposed `make verify-E14-T01`, contract/schema fuzz cases and
  `evidence/contract-matrix.json`; future commands are not current passing claims.

## Acceptance criteria

- [ ] `make verify-E14-T01` exits 0 cold. Two independent processes canonicalize every
      fixture to identical pinned object/version/changeset digests in
      `evidence/contract-digests.json`; expected values are committed inputs rather
      than computed by the code under test at runtime.
- [ ] The valid/invalid matrix covers unknown fields/version, malformed/noncanonical
      addresses, wrong byte count/hash, duplicate normalized paths, missing parents,
      tombstone/content conflicts and out-of-scope references. Each invalid input is
      refused with a pinned typed reason in `evidence/schema-refusals.json`.
- [ ] Identical bytes at two paths share a content address while preserving separate
      file identities; rename preserves identity/content, mode-only change changes
      version identity, and a one-byte content change changes its address. Exact
      field-by-field assertions are recorded in `evidence/file-identity.json`.
- [ ] The contract fixes one complete object record plus sealed completion through
      official streams, object/manifest size limits compatible with the verified file
      domain, and explicit refusal before publication for unsupported input. Limits
      cannot silently drop behavior listed in `evidence/compatibility-catalog.json`.
- [ ] `SourceMigrationBoundaryV1` identifies the exact legacy branch offset/digest and
      complete baseline versions without changing legacy bytes. Before/after fixture
      hashes and matching tree digests are in `evidence/legacy-boundary.json`.
- [ ] The schema audit rejects new source/review payloads containing textual patch/
      diff bodies and accepts reference-only changeset/claim/review manifests. Redacted
      agent logs are non-authoritative and explicitly separated. Removing all agent
      logs leaves fixture materialization byte-identical in
      `evidence/no-log-dependency.json`.
- [ ] Sensitivity mutations of a content byte, mode, parent and legacy boundary each
      fail a distinct pinned assertion. The claim declares `Replay: N/A (pure versioned
      contracts; no app integration in this task) + mitigation` with fixture replay,
      independent hashes and compatibility-catalog evidence.

## Adversarial verification

1. Supply binary/empty/CRLF/Unicode fixtures and independently hash raw bytes. Any
   text normalization, compression-dependent identity or hash of a patch instead of
   full bytes refutes content addressing.
2. Rename two identical-content files and change only one executable mode. Conflating
   file identity with hash/path or failing to distinguish mode changes refutes versions.
3. Insert a textual patch under an encoded/nested alternate field in a new manifest.
   Acceptance, or recovery that needs that patch, refutes the no-persisted-diff boundary.
4. Point a changeset at an object or parent in another repo and manipulate path
   normalization. Acceptance without the explicit scope relation refutes the contract.
5. Compare every legacy fixture/evidence hash before and after boundary generation.
   One changed historical byte or an old digest recomputed as a new golden refutes
   migration preservation.
6. Disable parent/hash/path validation separately in scratch copies. Every sabotage
   must turn its named fixture assertion red; a green apparatus cannot certify later
   object or publication tasks.

## Verification log
