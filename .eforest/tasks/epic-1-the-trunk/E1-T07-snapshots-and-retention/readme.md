---
id: E1-T07
epic: 1
title: "Snapshots: offset-anchored compaction with bootstrap reads and 410 Gone retention semantics"
priority: 107
status: pending
depends_on: [E1-T02, E1-T03, E1-T05]
estimate: L
capstone: false
---

## Goal

A **snapshot** is an offset-anchored compaction point for a stream-fs repo: the complete
canonically-encoded reduced fs state as of offset `O` — every live path after renames and
tombstones (E1-T02), every file's full content including all applied patch events
(E1-T03) — captured as a content stream artifact, and announced through the one mutation
door as a `snapshot` event appended to the metadata stream carrying
`{snapshotOffset, stateDigest, contentRef, formatVersion}`. `packages/streamfs`
(`@eforest/streamfs`, per E1-T01) exports
`createSnapshot(root)` (dispatches the snapshot event and writes the artifact) and
`bootstrapRead(root)` (loads the newest snapshot, verifies its recomputed digest
against the `stateDigest` in the snapshot event, then tails from `O + 1` — the
snapshot state already includes the event at `O`),
so readers of long-lived repos start from snapshot-plus-tail instead of replaying from
offset `-1`. `packages/server` (whatever name E0-T05 gave the single server package)
gains **retention**: after a snapshot event exists, events at offsets strictly below `O`
may be compacted away by a **separate compaction operation** — creating a snapshot by
itself changes nothing about reads; the newest snapshot event itself is never pruned. A
catch-up `GET` at any
offset below the compaction point returns **exactly `410 Gone`** with the resume offset
in the `Stream-Snapshot-Offset` response header and a canonical-JSON body
`{error: "gone", snapshotOffset}` — both frozen as golden transcripts in
`packages/conformance`, run against both stores. `SNAPSHOT_FORMAT_VERSION = 1` and the
snapshot artifact encoding (the same canonical state encoding `ef replay --digest`
hashes) live in `packages/protocol` and are **frozen here**: bootstrap-from-snapshot
replay equals full replay-from-`-1` by digest, always, and a snapshot whose recomputed
digest mismatches its announced `stateDigest` is a typed `SnapshotIntegrityError` —
never a silently wrong tree.

## Context

ROADMAP Epic 1 names snapshots as one of the two capabilities the stream-fs reference
lacks that make this a VCS: without compaction points, a year-old repo replays from zero
on every cold read, and without retention semantics the server can never reclaim a byte.
The design keeps every architectural bet intact: a snapshot is not a side table or a
cache — it is an event on the metadata stream (bet 1: one mutation door) referencing a
content stream artifact (same currency as file content), and its `stateDigest` is the
E0-T03/E0-T04 canonical digest of the reduced state at `O`, so `replay(log)` from `-1`
remains ground truth and every snapshot is checkable against it. E1-T02 and E1-T03 are
dependencies because they are exactly what a naive snapshot gets wrong: tombstoned and
renamed paths must not resurrect, and patch-derived content must be materialized —
the golden logs here contain both by construction. The direct `depends_on` edges on
E1-T02 and E1-T03 are intentional even though E1-T05 transitively implies them: the
golden-log hard cases consume E1-T02/E1-T03 semantics directly, independent of the
watcher.

Contracts frozen here (later changes invalidate standing verifications, loudly):

- **Snapshot artifact format**: `SNAPSHOT_FORMAT_VERSION = 1` in `packages/protocol`;
  the artifact body is the canonical state encoding already pinned by
  `ef replay --digest`, so `SHA-256(artifact body) == stateDigest` by definition.
  Changing the encoding is a format version event, not a refactor.
- **The digest anchor**: the newest snapshot event (always retained, never compacted)
  carries
  `stateDigest`; every bootstrap **must** recompute the digest of the loaded artifact
  and compare before exposing any state. Tampering with the artifact — even rewriting
  artifact and its own header consistently — is caught because the anchor lives in the
  log, not in the artifact.
- **`410 Gone` shape**: exact status, `Stream-Snapshot-Offset` header, canonical-JSON
  body, identical on both stores, golden-transcripted in `packages/conformance` under
  the E0-T09 normalizer rules. A read at the compaction boundary offset itself succeeds;
  one below it is `410` — the boundary is exact, not fuzzy. This includes offset `-1`:
  `GET` from `-1` on a compacted stream is `410` with `Stream-Snapshot-Offset`, same as
  any other below-boundary offset — fresh readers are never auto-forwarded past the
  compaction point.
- **Boundary inclusivity convention** (all criteria and attack angles reference this
  one convention): the `GET` offset parameter is inclusive-start — a request at offset
  `k` serves the event at `k` first. The snapshot state is "as of `O`" and **includes**
  the event at `O`. The `Stream-Snapshot-Offset` header value is `O` (`snapshotOffset`)
  itself; a client resuming after bootstrap therefore requests `O + 1`, and the first
  event it receives is the one at `O + 1` — never a re-delivery of `O`, never a gap.
- **Retention rule**: snapshotting and compaction are **separate operations**.
  `createSnapshot` never changes read behavior: until the compaction operation runs, a
  catch-up `GET` at `-1` or at any offset below `O` still answers `200` and replays the
  full log byte-identically to the pre-snapshot transcript — `410` first appears only
  after the compaction operation executes. Compaction may prune only offsets strictly
  below the newest snapshot event's `snapshotOffset`; the **newest** snapshot event is
  never pruned, while **older** snapshot events hold no retention privilege — once a
  newer snapshot exists, they are ordinary below-boundary events and prunable like any
  other. The `Stream-Snapshot-Offset` header on a `410` always carries the **newest**
  snapshot's `O`, even when compaction lags behind it (a newer snapshot above the
  current compaction point wins the header). Refused reads leave the log untouched
  (digest before == after); a stream with no snapshot event never returns `410`.

This unblocks E1-T08 (branch forks on long streams), E3 (browsing big repos without
full replay), and E4 (fresh-machine `ef init` bootstrapping a working tree). E1-T05
deferred watcher behavior on compacted streams to this task: a watcher whose saved
checkpoint falls below the compaction point must surface the typed gone/resume path,
never a silent gap.

Non-goals: automatic snapshot scheduling or size heuristics (manual/CLI-triggered here),
snapshotting branch streams (E1-T08 owns fork semantics), incremental/delta snapshots,
garbage-collecting content streams of deleted files (retention here is about the
metadata log window), and any auth on the retention surface (Epic 2).

Replay declaration (E0-T02 convention): `Replay: N/A (no browser surface until Epic 3)`;
mitigation is the digest-equality, transcript, and corruption evidence below.

## Deliverables

- `packages/protocol`: `SNAPSHOT_FORMAT_VERSION`, the snapshot event payload type
  `{snapshotOffset, stateDigest, contentRef, formatVersion}`, the
  `Stream-Snapshot-Offset` header name constant, and the `410` body shape.
- `packages/streamfs/src/snapshot.ts`: `createSnapshot(root)` — reduces the log through
  head offset `O`, writes the canonical artifact as a content stream, dispatches the
  snapshot event, returns `{snapshotOffset, stateDigest}`; and
  `bootstrapRead(root)` — resolves the newest snapshot event, fetches the
  artifact, **verifies the recomputed SHA-256 against the event's `stateDigest`**
  (mismatch throws `SnapshotIntegrityError{expected, actual, snapshotOffset}` and
  exposes no state), then tails from `O + 1` per the frozen boundary inclusivity
  convention (no `from` parameter — resuming a caller-held checkpoint is out of scope
  for this task; a stale checkpoint goes through the typed gone path and a fresh
  `bootstrapRead`). Exported pure function `reduceSnapshotPlusTail(artifact, tailEvents)`
  so digest-equality is testable without a server.
- Server retention in the E0-T05 server package: a compaction operation (admin surface
  or `ef`-driven, pinned in the implementation and named in the claim) that prunes
  offsets strictly below the newest snapshot event, on **both** memory and file stores;
  catch-up `GET` below the compaction point answers the frozen `410` shape; long-poll
  and SSE requests below it answer the same `410`, never park.
- `ef snapshot <stream-url>` (create + print `{snapshotOffset, stateDigest}`) and
  `ef replay --bootstrap <artifact-file> --tail <dump.jsonl> --digest` (replay
  snapshot-plus-tail to a digest, the evidence-side twin of `bootstrapRead`).
- Conformance additions in `packages/conformance` (both-stores rule, E0-T09 discipline):
  golden transcripts for the `410` on catch-up/long-poll/SSE, boundary exactness
  (`O-1` → 410, `O` → 200), the no-snapshot-no-410 case, the
  snapshotted-but-not-yet-compacted case (after `createSnapshot`, before the compaction
  operation: `GET` at `-1` and at `O-1` → 200 with the full log byte-identical to the
  pre-snapshot transcript; `410` only after compaction runs), a second
  snapshot/compaction cycle case (boundary and header pinned to the newest `O` at each
  stage), and refused-read log-untouched digest checks; corpus seeds for reads at
  bogus/foreign offsets against a compacted stream.
- Two-process integration test `packages/streamfs/test/snapshot.test.ts` against a
  cold-started server on an ephemeral port: build the golden fs log from the committed
  script `evidence/e1-t07-writer-script.jsonl` (must include ≥3 patch appends to one
  file, a directory rename moving a subtree, a delete + re-create at the same path),
  snapshot mid-log, compact, then (a) digest-equality bootstrap vs full replay of the
  retained uncompacted reference dump, (b) a raw E0-T08 client reading from a
  pre-compaction offset, receiving `410`, bootstrapping, resuming across the boundary
  with no duplicated or skipped event, (c) single-byte artifact corruption →
  `SnapshotIntegrityError`, (d) an E1-T05 watcher with a checkpoint below the
  compaction point surfacing the typed gone path, and (e) an E1-T05 watcher with a
  checkpoint at or above the compaction point resuming normally, its transcript
  byte-identical to the same resume performed against the uncompacted reference stream
  — compaction is invisible to a reader whose checkpoint survives it.
- `make verify-E1-T07` composed into the E0-T02 verify spine, added to `verify-all` and
  `make verify-list`, passing `tools/verify/self_check.sh`.
- Evidence artifacts in `evidence/`: `e1-t07-writer-script.jsonl`, the full uncompacted
  golden log `e1-t07-fs-log.jsonl`, the snapshot artifact `e1-t07-snapshot.bin`, the
  snapshot event record `e1-t07-snapshot-event.json`, post-compaction dump
  `e1-t07-compacted-tail.jsonl`, the `410` golden transcripts, and
  `e1-t07-digests.txt` recording every equality: full-replay digest == bootstrap
  digest == announced `stateDigest`.

## Acceptance criteria

- [ ] `make verify-E1-T07` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      (scrubbed env, fresh install), spawning its own servers on ephemeral ports, and
      prints the digest triple it compared (full replay, bootstrap, announced).
- [ ] Digest equality on the golden: `ef replay evidence/e1-t07-fs-log.jsonl --digest`
      equals `ef replay --bootstrap evidence/e1-t07-snapshot.bin --tail
      evidence/e1-t07-compacted-tail.jsonl --digest` equals the `stateDigest` in
      `evidence/e1-t07-snapshot-event.json`, all three recorded in
      `evidence/e1-t07-digests.txt`; a committed test asserts the golden log contains
      ≥3 patch events targeting a single file, a directory rename that moves a subtree
      (asserting a descendant path changed), and a delete followed by a re-create at
      the same path, so the equality is earned on the hard cases, not a toy log.
- [ ] `410` exactness: conformance golden transcripts pin status `410`, the
      `Stream-Snapshot-Offset` header value, and the exact canonical-JSON body for
      catch-up, long-poll, and SSE reads below the compaction point, byte-identical
      across both stores; boundary cases `O-1` → 410, `O` → 200 (serving the event at
      `O` first, per the inclusive-start convention), and catch-up from `-1` → 410
      with `Stream-Snapshot-Offset: O` each have their own golden-transcript case — a
      status-class match passes nothing.
- [ ] Raw-client resume across the boundary: a committed test drives an E0-T08 client
      from a pre-compaction offset, asserts it observes the `410`, bootstraps, and that
      its final reduced-state digest equals the full-replay digest of the uncompacted
      reference; the seam is asserted exactly per the frozen boundary inclusivity
      convention: the client resumes by requesting `O + 1` (the header value plus
      one), the first tailed offset is exactly `O + 1`, and event `O` — already in the
      bootstrapped snapshot state — is neither re-delivered nor skipped.
- [ ] Corruption is loud: a committed test flips single bytes of
      `e1-t07-snapshot.bin` (at minimum the first byte, the last byte, and ≥16 interior
      positions drawn from a seeded PRNG with the seed recorded in the test source)
      and asserts each bootstrap throws `SnapshotIntegrityError` carrying
      expected and actual digests, with zero fs state exposed; the same for a truncated
      artifact. Any corrupt variant that yields a tree — right or wrong — fails.
- [ ] Retention leaves the log honest: refused (`410`) reads change nothing — stream
      dump digests before and after are identical; a stream with no snapshot event
      never answers `410` (committed conformance case); the newest snapshot event
      itself survives compaction and is present in
      `evidence/e1-t07-compacted-tail.jsonl`.
- [ ] Snapshotting is not compaction: a committed conformance golden asserts that after
      `createSnapshot` but **before** the compaction operation runs, catch-up `GET` at
      `-1` and at `O-1` both return `200` and replay the full log byte-identically to
      the pre-snapshot transcript, and that `410` first appears only after the
      compaction operation executes — on both stores. An implementation whose
      `createSnapshot` immediately turns below-`O` reads into `410` fails this case.
- [ ] Repeated snapshots: a committed test drives snapshot at `O1` → compact →
      snapshot at `O2` → compact on one stream, asserting at each stage: after the
      first compaction, offsets strictly below `O1` are `410` and `O1` is `200`; once
      the `O2` snapshot event exists — even before the second compaction — every `410`
      carries `Stream-Snapshot-Offset: O2` (the newest snapshot's `O`, regardless of
      compaction lag); after the second compaction, offsets strictly below `O2` are
      `410`, `O2` is `200`, the `O1` snapshot event (now strictly below `O2`, no
      retention privilege) is pruned while the `O2` snapshot event survives,
      `bootstrapRead` resolves the `O2` snapshot, and its digest equals the
      full-replay digest of the uncompacted reference.
- [ ] One mutation door: `createSnapshot` reaches the log only via dispatch/append,
      proven behaviorally — a committed test replays the post-snapshot log from `-1`
      (pre-compaction) reproducing the same head digest, proving the snapshot event is
      just an event and no store-internal write bypassed the append surface; the
      apparatus's sensitivity to a bypass is proven by sabotage (e) in the adversarial
      section, which must turn `make verify-E1-T07` red.
- [ ] E1-T05 watcher behavior on a compacted stream is typed: resuming a watcher from a
      checkpoint below the compaction point surfaces the gone/resume condition (with
      `snapshotOffset`) rather than emitting a gapped transcript; a committed test
      asserts the error carries the offset to bootstrap from.
- [ ] All standard gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0; E0-T09 conformance and the E1-T02/T03/T05
      suites pass unmodified except for the additive conformance cases this task
      contributes (additions only — zero edits to existing cases, transcripts, or
      corpus entries).
- [ ] Replay (browser layer): N/A (no browser surface until Epic 3); mitigation is the
      digest triple, golden transcripts, and corruption evidence above.

## Adversarial verification

Attack angles for the hostile critic. Run each with your own logs, offsets, seeds, and
byte flips — never the builder's — and invent at least one more.

1. **Your own log, differential.** Generate your own mutation sequences (seeded,
   seed recorded): heavy patch chains, directory renames moving subtrees, deletes with
   re-creates at the same path, patches landing immediately before and after the
   snapshot offset. For each: snapshot at a mid-log offset, compact, and compare
   `bootstrapRead`'s digest against `ef replay` from `-1` over the uncompacted
   reference you dumped **before** compacting. Any digest inequality refutes — do not
   let the committed golden be the only log ever bootstrapped.
2. **Snapshot-point sweep.** Script snapshots at every offset `k` across one of your
   logs (or a dense sample on a long one); for each `k`, bootstrap-plus-tail must
   digest-equal full replay. Pay special attention to `k` landing between a patch and
   the write it patches, and inside a rename's event neighborhood — the classic places
   a compactor drops or double-applies state. One bad `k` refutes.
3. **Boundary off-by-one hunt.** Against a compacted stream, request every offset in a
   window around `O`: strictly-below must be exactly `410` with the correct
   `Stream-Snapshot-Offset` value of exactly `O`, `O` and above must serve normally
   (a request at `O` delivers the event at `O` first, per the frozen inclusive-start
   convention). Then resume a client at the header's value plus one (`O + 1`) and
   byte-diff the tailed events against the uncompacted reference's suffix from `O + 1`
   — a re-delivered event `O`, a skipped event `O + 1`, or a header carrying anything
   but `O` refutes. Repeat over long-poll and SSE:
   a live request below the boundary that parks instead of answering `410` refutes.
4. **Corruption fuzz, beyond single flips.** Flip bytes at your own positions
   (hundreds, sampled across the artifact), truncate at random lengths, extend with
   trailing bytes, and — the important one — rewrite the artifact to a *valid encoding
   of a different tree*. Every variant must throw `SnapshotIntegrityError`; the
   different-but-valid tree is the refutation that matters, since it proves the check
   is against the log-anchored `stateDigest`, not mere parseability. Also tamper with
   the snapshot event's `contentRef` to point at the wrong artifact: bootstrap must
   fail the digest check, never load the wrong tree.
5. **Sensitivity proof of the apparatus (mandatory).** In a scratch worktree, sabotage
   the implementation five ways, one at a time: (a) `createSnapshot` silently skips
   tombstone removal (deleted files resurrect), (b) the reducer materializes only the
   last patch instead of the chain, (c) `bootstrapRead` skips the digest verification,
   (d) the server serves `404` instead of `410` below the boundary, (e) `createSnapshot`
   writes the snapshot record into store-internal state directly, bypassing
   dispatch/append. `make verify-E1-T07`
   must go red under each independently, naming the failing digest or transcript. Any
   sabotage that stays green refutes the measuring apparatus and voids the evidence.
6. **Retention greenwash hunt.** After compaction on the file store, inspect the data
   dir: pruned offsets must actually be unreachable through the protocol surface
   (catch-up from `-1` must NOT silently replay from zero and must NOT auto-forward —
   per the frozen contract it is exactly `410` with `Stream-Snapshot-Offset: O`,
   matching the committed conformance transcript; anything else refutes). Confirm
   refused reads leave dump digests
   unchanged, that compaction never prunes the newest snapshot event or anything ≥ `O`,
   and that the memory and file stores answer every case identically — store divergence
   refutes independent of which store is right. Also probe the
   snapshotted-but-not-yet-compacted state: after `createSnapshot` and **before** the
   compaction operation runs, catch-up `GET` at `-1` and at `O-1` must answer `200` and
   replay the full log byte-identically to the pre-snapshot transcript — a `410`
   appearing before compaction executes refutes (snapshotting and compaction are
   separate operations).
7. **Cold-clone + golden provenance.** Run only via `tools/verify/cold_clone.sh`.
   Regenerate `e1-t07-fs-log.jsonl`, the snapshot artifact, and the digest file from
   the committed writer script yourself, from scratch, and byte-diff against the
   committed evidence. A golden or artifact that cannot be re-derived from the
   committed script and the code refutes the evidence's provenance. Also confirm the
   tests cold-start their own servers (grep for fixed ports / warm-server baseURLs).
8. **Watcher and mutation-door probes.** Resume an E1-T05 watcher from a checkpoint you
   place below the compaction point: a transcript that silently continues (gapped) or
   an untyped crash refutes; the typed error must carry the true `snapshotOffset`.
   Then grep the snapshot and compaction paths for any store write bypassing the
   append/dispatch surface, and replay the pre-compaction log from `-1`: if the
   snapshot event's presence in the log does not reproduce the claimed head digest,
   the "snapshots are events" claim is refuted.
9. **Second-cycle lifecycle.** Drive snapshot → compact → snapshot → compact on your
   own log with your own offsets `O1 < O2`. At every stage, sweep the boundary window
   and check the header: after the first compaction, strictly-below-`O1` is `410` with
   `Stream-Snapshot-Offset: O1` and `O1` serves; once the `O2` snapshot event exists —
   even before the second compaction runs — every `410` must carry `O2`, not `O1`;
   after the second compaction, strictly-below-`O2` is `410` with `O2`, `O2` serves,
   the `O1` snapshot event is pruned (it lies strictly below `O2` and holds no
   retention privilege) while the `O2` event survives, and `bootstrapRead` resolves
   the `O2` snapshot to a digest equal to full replay of the uncompacted reference.
   A header stuck at `O1`, a stale `O1` snapshot event surviving as a retention
   exception, a boundary that fails to advance, or store divergence at any stage
   refutes.

Refutation currency: a digest pair (bootstrap vs full replay) with the log and offset
`ef bisect` pins, a transcript file + first-divergent-byte offset, a corrupt-artifact
variant + the tree it wrongly yielded, or a diff hunk showing a bypassed mutation door.
"Compaction seems to work" is not a finding.

## Verification log
