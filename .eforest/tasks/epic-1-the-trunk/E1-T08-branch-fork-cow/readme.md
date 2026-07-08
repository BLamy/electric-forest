---
id: E1-T08
epic: 1
title: "Branch streams: fork at an offset with copy-on-write metadata and independent divergence"
priority: 108
status: pending
depends_on: [E1-T02, E1-T03, E1-T05] # E1-T05: adversarial angles 3 and 6 mandate live tailing of branch/parent streams during divergence and refusals
estimate: L
capstone: false
---

## Goal

`@eforest/streamfs` (`packages/streamfs`, the E1-T01 package) grows **branches as forks
of the log, never copies of the tree**. `createBranch(repo, branch, { at })` is O(1)
regardless of tree size: it creates exactly one new metadata stream
`fs:<repo>:<branch>:meta` whose **first and only mandatory event** is the frozen fork
record `fs.branch.fork { v: 1, parentStreamId, forkOffset }`, and appends **zero events
to the parent** — the parent stream's head offset and `ef replay --digest` dump digest
are byte-identical before and after the fork. Branch state is defined by pure
resolution, not duplication: `replay(branch) = replay(parent events at offset ≤
forkOffset) ++ replay(branch's own events after the fork record)`, so reads below the
fork resolve through the parent — including E1-T02 renames and tombstones that happened
pre-fork — and this holds recursively for a branch forked from a branch. Content is
copy-on-write at file granularity: the first branch-side write to a file inherited from
the parent — a full `fs.file.write` **or an E1-T03 `fs.file.patch` whose declared base
is parent-authored, pre-fork content** — mints a fresh content stream
`fs:<repo>:<branch>:file:<fileId>` and a new `contentStreamId` in the branch's reduced
tree; a cross-boundary patch first materializes the inherited content by resolution,
applies deterministically per E1-T03's frozen grammar, and writes the result only into
the branch-owned stream. Symmetrically, the first post-fork parent-side write to a
shared file touches only parent-owned streams; no operation on either side ever
appends to, deletes, or creates a stream in the other side's namespace. The proof is
**three digest claims on a committed golden two-branch log**: (1) fork identity —
`treeDigest(replay(branch at forkOffset)) === treeDigest(replay(parent at forkOffset))`
at the moment of fork; (2) divergence independence — post-fork edits on either side,
including patch events crossing the fork boundary, leave the **other** side's digest
byte-unchanged; (3) exact divergence — `ef bisect` (E0-T12) over the resolved branch
log vs. the parent log reports `kind: divergence` with 1-based `index` **exactly
`N + 1`**, where `N` is the count of parent events at offsets ≤ `forkOffset` per
E0-T03's `compareOffsets` — equivalently, the divergent offset is the offset of the
first post-fork (branch-authored) event in the resolved log; the `fs.branch.fork`
record itself is **excluded** from resolution output (see the Contract's resolution
semantics), so index `N + 1` is always the first branch-authored edit, never the fork
record. (Offsets are frozen by
E0-T03 as opaque strings whose only guaranteed property is lexicographic ordering; no
`±1` arithmetic on offset *values* is defined anywhere in this task. All "N + 1" claims
below are about E0-T12's 1-based record index, never about offset strings.) `ef replay`
gains `--parent <dump>` to resolve a branch dump against its parent dump purely (no
server), keeping the single evidence instrument. Invalid forks — unknown parent stream,
a `forkOffset` outside the valid domain (see the Contract's frozen domain: the `-1`
sentinel, an offset lexicographically greater than the parent's head, or a mid-gap
offset that no parent event carries), branch-name collision, a branch name outside the
Contract's frozen branch-name grammar, a second `fs.branch.fork` on an existing branch — are refused before append through
E0-T11's validator (`validator-rejected`, 409, frozen `reason` codes) with both parent
and branch logs untouched.

## Context

This is one of the two capabilities the reference stream-fs lacks that make Epic 1 a
VCS (ROADMAP.md, "Epic 1 — the-trunk": "branch streams — fork at offset with
copy-on-write metadata"). Everything merge-shaped stands on it: E1-T09's fast-forward
merge is "the target has not advanced past the fork," E1-T10's three-way merge needs
the fork offset as the base, and the E1-T11 capstone ("the-first-repo") forks `feature`
from `main` at an offset, edits both sides, watches both live, and digest-verifies the
merge. E1-T02 deliberately kept tombstones in reduced state "on branch-fork grounds" —
this task is where that debt is collected: a path tombstoned in the parent pre-fork
must stay dead on the branch, and a pre-fork rename must resolve to the moved path, all
without copying anything. E1-T03 is a dependency because patches are where
copy-on-write is easiest to get wrong: a branch-side patch declares a base that lives
in a **parent-owned** content stream below the fork, so the apply path must resolve the
inherited content, apply per the frozen patch grammar, and land the result in a
branch-minted stream — never append the patch to the parent's content stream, and never
fall back to a silent full-write divergence. E1-T09/T10 will replay exactly these
cross-boundary patch events; if their semantics wobble here, merge is unbuildable.

Builds on: E1-T01 (frozen fs envelope, metadata/content stream split, `treeDigest`,
`fs:<name>:main:*` stream naming — `main` is retroactively just the branch with no
parent), E1-T02 (directory ops, tombstones, renames, `listTree`, the `fs/*` refusal
reason-code style), E1-T03 (patch event grammar, deterministic apply, digest parity
against full writes — reused verbatim, not re-frozen), E0-T11 (validated dispatch),
E0-T04/T12 (`ef replay`, `ef bisect` as the citation tools). E1-T07 (snapshots) is
deliberately **not** a dependency: resolution is specified against raw logs; a branch
whose parent has been compacted below `forkOffset` surfaces E1-T07's `410 Gone`
semantics and is out of scope here beyond a documented error path.

Contract frozen here, versioned with the fs envelope (`FS_EVENT_VERSION` history
updated; additive — no existing event shape changes, including E1-T03's patch shape):

- `fs.branch.fork { v: 1, parentStreamId, forkOffset }` — must be the first event of a
  branch metadata stream, must never appear at any other position or on `main`, and is
  immutable: there is no re-fork, re-parent, or fork-offset edit event.
- **Resolution semantics**: the branch's reduced state at any offset is a pure function
  of (parent log ≤ `forkOffset`, branch log ≤ that offset), recursively through fork
  chains. Parent events at offsets > `forkOffset` are invisible to the branch forever —
  a historical fork is a frozen view, not a moving one. The `fs.branch.fork` record is
  a **resolution directive, not a resolved event**: `resolveBranchLog` consumes it and
  excludes it from its output, so the resolved branch log is exactly (parent events at
  offsets ≤ `forkOffset`) followed by the branch-authored events after the fork
  record, and the fs reducer never receives `fs.branch.fork` as input. Consequently,
  every "`N + 1`" claim in this task means: with `N` = the count of parent events at
  offsets ≤ `forkOffset`, 1-based record index `N + 1` in the resolved branch log is
  the **first branch-authored edit event** — never the fork record.
- **Copy-on-write ownership**: content streams are owned by the branch that minted
  them. A branch reads inherited content from parent-owned content streams; the first
  branch-side write (full write **or** E1-T03 patch) to an inherited path mints a
  branch-owned content stream and repoints `contentStreamId` in the branch's tree only.
  A cross-boundary patch (branch-side patch whose base is inherited, parent-authored
  content) resolves the base through the parent at ≤ `forkOffset`, applies per E1-T03's
  frozen grammar, and appends only to the branch-owned stream; base mismatch refuses
  with E1-T03's existing patch refusal codes, both logs untouched. Deleting an
  inherited file on the branch appends a tombstone to the branch log only.
- **Valid `forkOffset` domain (frozen)**: exactly the set of offsets carried by events
  actually present in the parent log, head included. Everything else is invalid and is
  refused with `fs/fork-offset-out-of-range` — that one code covers all three invalid
  shapes: (i) the `OFFSET_BEFORE_FIRST` `-1` sentinel (forking an empty prefix is not
  a thing; there is no event to fork at), (ii) any offset comparing greater than the
  parent's head under E0-T03's `compareOffsets`, and (iii) any mid-gap offset that no
  parent event carries. Validity is decided by membership and `compareOffsets`, never
  by numeric parsing of offset strings.
- **Valid branch name (frozen)**: exactly the strings matching the regex
  `^[a-z0-9][a-z0-9-]{0,63}$` (so `:`, whitespace, uppercase, and the empty string are
  impossible by construction), **minus** the reserved names `main` (the parentless
  branch), `meta`, and `file` (the namespace segments of `fs:<repo>:<branch>:meta` and
  `fs:<repo>:<branch>:file:<fileId>` — a branch named after them, or containing `:`,
  would corrupt parsing of the `fs:<repo>:<branch>:*` namespace that the CoW-ownership
  and parent-forensics evidence depends on). Anything else — empty string, a name
  containing `:` or any character outside the grammar, a name longer than 64
  characters, or a reserved name — is refused with `fs/invalid-branch-name`. Validity
  is decided against this grammar literally; there is no normalization or trimming.
- **Refusal reason codes** (all `validator-rejected`, HTTP 409, `error.reason` set):
  `fs/branch-exists`, `fs/parent-not-found`, `fs/fork-offset-out-of-range`,
  `fs/invalid-branch-name`, `fs/fork-not-first-event`. Documented in the package README
  next to E1-T02's reason table.
- `ef replay <branch-dump> --parent <parent-dump> [--parent <grandparent-dump> ...]
  [--until <offset>] --digest` — pure offline resolution ordered leaf→root; digests
  produced this way are the citation currency for every branch claim in the repo.
  `--until <offset>` is a **segment-aware prefix cut** on the resolved record
  sequence — never a scan for the first record whose offset compares greater than
  `<offset>`, because the resolved sequence concatenates records from different
  streams and offset comparison is **never performed across two streams' offset
  spaces** (E0-T03 offsets are opaque per-stream strings; a branch's offsets can
  compare arbitrarily low or high against a parent's). The resolved sequence is a
  concatenation of per-stream segments, root-most parent first, leaf branch last;
  the cut is decided per segment, always with E0-T03's `compareOffsets` applied
  within that segment's own offset space: within a parent segment, emit exactly the
  records whose offsets compare ≤ `<offset>` in that segment's space; a branch
  segment contributes **zero records** whenever `<offset>` compares ≤ that link's
  `forkOffset` (the cut lands in or before the parent prefix), and otherwise is
  itself cut by `compareOffsets` in its own offset space. With `--parent`,
  `--until <forkOffset>` therefore yields exactly the parent prefix of the
  resolution, and without `--parent` it truncates a single log the same way (one
  segment, one offset space).

Non-goals: merge of any kind (E1-T09 fast-forward, E1-T10 three-way), snapshots and
compaction interplay beyond the documented `410` error path (E1-T07), `watch()` on
branches beyond what E1-T05's tailing already gives per-stream (capstone wiring is
E1-T11), branch deletion/GC, and any server-side "list branches" index (registry work
is Epic 2's `__registry__` promotion).

## Deliverables

- `packages/streamfs/src/events.ts` (extended) — `fs.branch.fork` payload schema plus
  runtime guards (first-event-only, exact fields, no extras); fs envelope version
  history records the additive extension.
- `packages/streamfs/src/branch.ts` — `createBranch(repo, branch, { at }): Promise<{
  streamId, forkOffset }>` (O(1): one stream create + one fork-record append, zero
  parent appends; `at` defaults to the parent's current head) and
  `resolveBranch(state)` helpers exposing `{ parentStreamId, forkOffset }` from reduced
  state.
- `packages/streamfs/src/resolve.ts` — pure `resolveBranchLog(dumps: Dump[]): Event[]`
  implementing the frozen resolution semantics (leaf→root fork-chain walk, parent
  truncation at each `forkOffset`, `fs.branch.fork` records consumed and excluded
  from the output per the Contract), used identically by the reducer path and by
  `ef replay --parent`; no second implementation anywhere.
- Copy-on-write write path — branch-side `fs.file.write`, `fs.file.patch` (E1-T03),
  create/delete, and E1-T02 directory ops mint and touch **only**
  `fs:<repo>:<branch>:*` streams; the cross-boundary patch path (inherited base →
  resolve through parent → apply → branch-minted stream) is a named function with its
  own tests; parent namespace writes from a branch context are impossible by
  construction and asserted in tests by forensic diff, not by trusting the code.
- Dispatch-door validators for the five frozen reason codes, registered via E0-T11's
  extension point; refusals leave both parent and branch logs byte-identical.
- `packages/ef/` (or wherever E0-T04 put it) — `ef replay --parent` flag, repeatable
  for fork chains, with digest output format unchanged; and `ef replay --until
  <offset>`, the prefix-cut truncation instrument with exactly the Contract's frozen
  semantics — this flag is the *only* sanctioned way the acceptance criteria compute
  "digest at `forkOffset`" for either side; and `ef replay ... [--parent ...]
  [--until ...] --emit-log <path>`, which writes the resolved record sequence
  (exactly `resolveBranchLog`'s output: fork record excluded, parent prefix spliced
  in) to `<path>` in dump format — the *only* sanctioned instrument for
  materializing a resolved log as a file so `ef bisect` can consume it; every
  bisect-shaped criterion below cites it by name.
- `packages/streamfs/fixtures/` — committed golden logs with sibling
  `*.expected.json` (`{fsEnvelopeVersion, chain: [{parentStreamId, forkOffset,
  parentDigestAtFork, branchDigestAtFork, firstDivergentIndex,
  firstDivergentOffset}, ...]` ordered root-most link first,
  `finalParentDigest, finalBranchDigest}`; each link's
  `firstDivergentIndex`/`firstDivergentOffset` is defined against exactly one pair —
  that link's branch resolved log vs. its **immediate** parent's resolved log — so a
  multi-link golden commits one divergence pair per link; single-level goldens have a
  one-element `chain`):
  (a) **fork-at-head, two-branch divergence** — the headline golden: build a tree on
  `main` (including at least one pre-fork rename, one tombstone, and one file whose
  last pre-fork content event is an E1-T03 patch), fork `feature` at head, then
  diverge both sides — the branch's first edit to one inherited file is a
  **cross-boundary patch** against parent-authored base content, and the parent
  patches a different shared file post-fork;
  (b) **fork-at-historical-offset** — fork at an offset strictly below the parent's
  head, so parent events above the fork exist and must be invisible to the branch;
  (c) **fork-of-a-fork** — fork `feature` from `main`, edit `feature` (including one
  patch), fork `nested` from `feature` at an offset of `feature`'s own, edit all
  three sides; its `expected.json` `chain` carries both links' `forkOffset`s,
  per-link digests, and per-link
  `firstDivergentIndex`/`firstDivergentOffset` (link 1: `feature`'s resolved log vs.
  `main`'s log; link 2: `nested`'s resolved log vs. `feature`'s resolved log).
- `packages/streamfs/test/branch-fork.test.ts` — over real HTTP through `/dispatch`:
  fork identity digest at `forkOffset`; O(1) fork (event-count delta on parent is
  exactly zero, branch log is exactly one event); pre-fork rename and tombstone
  resolution through the fork; CoW forensics (parent content-stream ids and head
  offsets recorded before branch edits, asserted identical after) triggered separately
  by a full write **and** by a cross-boundary patch; cross-boundary patch result
  digest-equal to the same edit expressed as a full write (E1-T03 parity, now across
  the fork); divergence independence (edits on both sides, neither log gains the
  other's events, each side's digest recorded before the other side's edits and
  asserted byte-identical after); a fork-of-a-fork resolving through a two-deep chain;
  each refusal reason code with before/after head-offset + digest byte-equality on
  both streams.
- `packages/streamfs/test/branch-fork.fuzz.test.ts` — seeded (seeds committed):
  random parent histories (≥ 200 ops incl. renames, tombstones, and E1-T03 patches),
  fork offsets drawn randomly from the offsets of actual parent events, plus per seed
  at least one invalid-offset probe (a mid-gap offset no parent event carries, an
  offset past head, or the `-1` sentinel) asserted to 409 with
  `fs/fork-offset-out-of-range` leaving both logs byte-identical, random divergent op
  interleavings on both sides mixing full writes and patches — including at least one
  cross-boundary patch per seed (≥ 5 seeds); after each run assert (1) branch digest
  at `forkOffset` equals parent digest at `forkOffset`, (2) `ef bisect` — over logs
  materialized with `ef replay ... --emit-log`, the resolved branch log as **log A**
  and the parent log as **log B** — reports `kind: divergence` with 1-based
  `index` exactly `N + 1` (`N` = count of parent events at offsets ≤ `forkOffset`;
  the fork record is excluded from the resolved log per the Contract, so index
  `N + 1` is the first branch-authored edit) and `aOffset` equal to the
  offset of the first branch-authored event in the resolved log, (3) parent digest at `forkOffset` is byte-identical to its
  pre-fork recording and each side's post-fork digest is unaffected by the other
  side's ops, (4) the branch's final tree equals an independent model (a plain
  in-memory model applying parent ops ≤ fork then branch ops, with its own diff-apply
  — a differential oracle, not the reducer checking itself), cross-checked in two
  separate node processes.
- `evidence/` — fork-identity digest pairs (`e1-t08-fork-identity.txt`), the
  divergence-independence transcript — each side's digest before/after the other
  side's post-fork edits, cross-boundary patches called out
  (`e1-t08-independence.txt`), bisect transcripts pinning the `N + 1`
  first-divergence index and the `aOffset === firstDivergentOffset` assertion, one
  bisect per chain link, each side materialized via `ef replay ... --emit-log`
  (resolved branch log as log A, immediate parent's resolved log as log B)
  (`e1-t08-bisect.txt`), the golden (c) chain-identity transcript — run-invariant
  fields only per the fork-chains criterion: per-link `parentStreamId`,
  `forkOffset`, and fork-identity digest pair, plus the two-`--parent` resolution
  digest; no pids, timestamps, or paths (`e1-t08-chain.txt`), parent-immutability byte-diffs
  (`e1-t08-parent-forensics.txt`), fuzz seeds + digests (`e1-t08-fuzz.txt`),
  sensitivity transcripts (`e1-t08-sensitivity.md`).
- `Makefile`: `verify-E1-T08` per the E0-T02 target contract — golden replays (two
  processes each, `--parent` resolution), the three digest claims over golden (a),
  fuzz run, refusal neutrality, sensitivity proof, plus re-runs of `verify-E1-T01`,
  `verify-E1-T02`, and `verify-E1-T03` proving the extension is additive.

## Acceptance criteria

- [ ] `make verify-E1-T08` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] **Digest claim 1 — fork identity**: for every golden, `ef replay <branch-dump>
      --parent <parent-dump> --until <forkOffset> --digest` equals
      `ef replay <parent-dump> --until <forkOffset> --digest`, byte-identical, in
      two separate node processes (distinct pids printed; harness fails on equal
      pids); digests match the committed `branchDigestAtFork`/`parentDigestAtFork`
      (which are equal).
- [ ] Fork is O(1) and parent-silent — evidence: the test records the parent's head
      offset and full-dump digest immediately before and after `createBranch`; both
      byte-identical; the branch metadata stream contains exactly one event
      (`fs.branch.fork`) before any branch edit; and no `fs:<repo>:<branch>:*` content
      stream exists at fork time — observed by a named instrument: this check runs the
      server with E0-T07's file store (`--data-dir` into a scratch dir) and lists
      `<data-dir>/streams/` immediately before and after `createBranch`; the listing
      delta is exactly the one branch metadata stream and nothing else.
- [ ] Pre-fork history resolves through the parent: in golden (a), a file renamed
      pre-fork is readable on the branch at its **new** path with its original
      `contentStreamId`, a path tombstoned pre-fork is absent from the branch's
      `listTree` with its tombstone record present in branch reduced state, and a file
      whose last pre-fork content event was an E1-T03 patch reads on the branch as the
      patched content — all asserted literally.
- [ ] **Digest claim 2 — divergence independence**: in golden (a), the parent's dump
      digest recorded immediately before the branch's post-fork edits (which include a
      cross-boundary patch) is byte-identical to its digest after them, and the
      branch's resolved digest recorded immediately before the parent's post-fork
      edits (which include a patch to a shared file) is byte-identical to its digest
      after them — transcript committed to `evidence/e1-t08-independence.txt`.
- [ ] Cross-boundary patch parity: the branch-side patch against a parent-authored,
      pre-fork base produces a branch tree digest byte-identical to the same edit
      expressed as a forced full write on a control branch forked at the same offset —
      E1-T03's parity property, proven across the fork boundary; and the patch
      appended zero events to any parent-owned stream (forensic diff).
- [ ] Historical fork is a frozen view: in golden (b), parent events above
      `forkOffset` (present in the parent dump) affect neither the branch's `listTree`
      nor its digest — asserted by comparing against the control
      `ef replay <parent-dump> --until <forkOffset> --digest`.
- [ ] Copy-on-write forensics: after branch-side edits to inherited files — one via
      full write, one via cross-boundary patch — the branch tree's `contentStreamId`
      for each path differs from the parent's, the new streams live in the
      `fs:<repo>:<branch>:file:*` namespace, and every parent content stream's id and
      head offset recorded pre-fork is string- and offset-identical post-divergence
      (zero appends attributable to any branch op); committed to
      `evidence/e1-t08-parent-forensics.txt`.
- [ ] **Digest claim 3 — exact divergence**: after divergent edits on both sides,
      for **each chain link in each golden** (golden (c) has two: `feature` vs.
      `main`, and `nested` vs. `feature`'s resolved log), both sides of the pair are
      materialized to files with `ef replay ... --emit-log` — the link's resolved
      branch log, and its immediate parent's log (itself resolved via `--parent`
      where the parent is a branch, as in golden (c) link 2) — and `ef bisect` is
      run **with the link's resolved branch log as log A and its immediate parent's
      resolved log as log B**; it reports `kind: divergence` with 1-based `index`
      exactly `N + 1`, where `N` is the count of parent events at offsets ≤ that
      link's `forkOffset` per `compareOffsets` (the fork record is excluded from the
      resolved log per the Contract, so index `N + 1` is the first branch-authored
      edit event), and the literal field assertion is
      `aOffset === firstDivergentOffset` — asserted against the per-link
      `firstDivergentIndex` and `firstDivergentOffset` committed in the `chain`
      array, not "some offset after the fork" (`bOffset` is the parent's first
      post-fork offset and is **not** the committed value); transcript committed to
      `evidence/e1-t08-bisect.txt`.
- [ ] Fork chains: the committed golden (c) two-deep chain replays via two `--parent`
      flags to a digest equal both to the equivalent flat log's digest and to the
      committed `finalBranchDigest`; each link's fork-identity check holds at that
      link's own `forkOffset` against the per-link digests committed in the `chain`
      array; and the run's chain transcript matches the committed
      `evidence/e1-t08-chain.txt` byte-for-byte. The chain transcript contains
      **run-invariant fields only**: per-link `parentStreamId`, `forkOffset`, and
      fork-identity digest pair, plus the final two-`--parent` resolution digest —
      no pids, timestamps, hostnames, or filesystem paths (the distinct-pid printing
      required by Digest claim 1 goes to the harness's own log, never into this
      transcript). `evidence/e1-t08-chain.txt` is a frozen committed artifact that
      the verify run compares its freshly produced transcript **against**; the run
      must never write or regenerate the committed file.
- [ ] Refusal neutrality per reason code: for each of the five frozen `reason` codes,
      head offset and dump digest of **both** the parent and the (attempted) branch
      stream are byte-identical before and after the refused dispatch; each refusal is
      HTTP 409 with `error.class: 'validator-rejected'` and the exact spec-stated
      `error.reason` (literal assertions). `fs/fork-offset-out-of-range` must fire
      separately for each of its three frozen invalid shapes — the `-1` sentinel, an
      offset comparing greater than the parent's head under `compareOffsets`, and a
      mid-gap offset that no parent event carries — each with its own before/after
      byte-equality check. Likewise `fs/invalid-branch-name` must fire separately for
      each of these four invalid shapes from the Contract's frozen branch-name
      grammar — the empty string, the reserved name `main`, a name containing `:`,
      and the reserved namespace segment `file` — each with its own before/after
      byte-equality check.
- [ ] Fuzz survival + differential oracle: all committed seeds complete with zero 5xx,
      zero crashes, fork-identity and the `N + 1` bisect index holding on every run
      (bisect run over `--emit-log`-materialized logs, resolved branch log as log A,
      with `aOffset` equal to the first branch-authored event's offset),
      every per-seed invalid-offset probe refused with `fs/fork-offset-out-of-range`
      and zero bytes moved, parent digests never moving, cross-boundary patches
      landing only branch-side, and branch final trees equal to the independent model;
      seeds and digests committed in `evidence/e1-t08-fuzz.txt`.
- [ ] Sensitivity proof runs inside `make verify-E1-T08`: (a) one byte flipped in a
      copy of a golden branch dump flips the resolved digest or fails the parse;
      (b) in a scratch worktree, making resolution include parent events **above**
      `forkOffset`, separately making a branch write append to the parent's content
      stream, separately making the cross-boundary patch path apply against the
      parent's **head** content instead of its content at ≤ `forkOffset`, and
      separately making `ef replay --emit-log` silently include the `fs.branch.fork`
      record or a parent event above `forkOffset` in its emitted output, each turn
      the suite red; transcripts committed as `evidence/e1-t08-sensitivity.md`. Any
      sabotage the target stays green on fails this criterion.
- [ ] No regression: `verify-E1-T01`, `verify-E1-T02`, and `verify-E1-T03` re-run
      green against this tree (additive envelope extension only), and all root gates
      pass (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm
      build`).
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with fork-identity digests, independence transcripts, bisect
      transcripts, and parent forensics as the stream-layer evidence currency.

## Adversarial verification

The claim under attack: "a branch is a metadata pointer, not a copy — fork costs one
event, the parent is inviolate, pre-fork history (including patched content) resolves
through the parent exactly, edits on either side — including patches whose base
crosses the fork boundary — never move the other side's digest, and divergence begins
at precisely the first branch-authored event (E0-T12 bisect index `N + 1`, `N` =
parent events at offsets ≤ `forkOffset`)." Use your own inputs throughout; invent at
least one more angle.

1. **Your own fork, cold, with your own arithmetic.** From a cold clone, build your own
   parent history (≥ 50 events including at least one rename chain, one
   delete-recreate from E1-T02, and one E1-T03 patch chain), fork at three offsets of
   your choosing (head, the offset of the event immediately before head in the log,
   and somewhere early), and for each compute the fork-identity digest **without**
   `resolveBranchLog`: truncate the parent dump yourself with a from-scratch script
   that never imports `@eforest/streamfs`, replay it, and compare against the branch's
   resolved digest at `forkOffset`. Any pair that differs refutes the resolution
   semantics; any fork whose branch stream contains more than the single
   `fs.branch.fork` event refutes O(1).
2. **Parent forensics, byte-level.** Dump the parent's metadata stream and every
   parent content stream before the fork. Then hammer the branch: creates, writes,
   renames, recursive deletes, and E1-T03 patches — make several of the patches
   cross-boundary (declared base = parent-authored pre-fork content), since the patch
   apply path is the likeliest to reach for the parent's content stream. Re-dump
   everything parent-side and diff byte-for-byte — any changed byte anywhere in the
   parent namespace (metadata or content, including head offsets and stream
   existence) refutes copy-on-write. Also check stream *creation*, with a named
   instrument: run the server on E0-T07's file store (`--data-dir` into a scratch
   dir) and list `<data-dir>/streams/` before and after the hammering; if you must
   attack the default in-memory store instead, probe the finite set of predictable
   stream names — every `contentStreamId` in the parent's reduced tree, its
   `fs:<repo>:main:*` metadata/content names, and their `fs:<repo>:<branch>:*`
   counterparts — via `GET` and record exists/404 for each, before and after. Any new
   stream outside `fs:<repo>:<branch>:*` refutes ownership.
3. **The frozen-view hunt.** Fork at a historical offset, then keep writing to the
   parent — including a parent-side patch to a file the branch also inherited. Read
   the branch repeatedly, replay it, tail it live (E1-T05/E0-T06): any parent event
   above `forkOffset` leaking into the branch's tree, digest, or emitted frames
   refutes the frozen view. Then invert it: write and patch on the branch and confirm
   the parent's tail emits nothing and its digest is byte-unchanged.
4. **Cross-boundary patch interrogation.** Pre-fork, build a file through a chain of
   E1-T03 patches. Fork. On the branch, patch it again with a base declaring the
   parent's pre-fork content. Verify three ways: (i) the branch's resolved content
   equals applying your **own** independent diff-apply (not the package's) to the
   parent's content at ≤ `forkOffset`; (ii) the same edit as a forced full write on a
   control branch forked at the same offset digest-matches; (iii) now patch the
   **parent** post-fork so its head content no longer matches the branch's declared
   base, re-run the branch patch on a fresh fork at the same historical offset — it
   must still apply against the ≤-`forkOffset` content, not the parent's head. A
   branch patch that applies against parent head content, lands bytes parent-side, or
   digest-diverges from the full-write control refutes the CoW patch path. Also send
   a branch patch whose declared base matches nothing (neither ≤-fork parent content
   nor branch content) — anything but E1-T03's typed refusal with both logs untouched
   is a refutation.
5. **Tombstone and rename resurrection through the fork.** Pre-fork: create a file,
   delete it (tombstone), recreate it (fresh identity per E1-T02), rename a directory
   over it if you can. Fork. On the branch: the tombstoned-then-recreated path must
   carry the *fresh* content-stream id, never the dead one; deleting the inherited
   file on the branch and reading the parent must still show it alive. Any dead
   content-stream id reachable from any branch reduced state at any offset, or any
   branch delete visible parent-side, is a refutation. Cite via `ef bisect` + offset.
6. **Fork-offset fuzzing at the door.** Probe `createBranch`/dispatch, partitioning
   your probes up front and predicting each outcome before sending it.
   Must **succeed** (offsets carried by actual parent events): the parent's head
   offset, the offset of the parent's first event, and one mid-history event offset.
   Must **409 with exactly `fs/fork-offset-out-of-range`**: the `-1`
   (`OFFSET_BEFORE_FIRST`) sentinel, an offset lexicographically greater than the
   parent's head (`compareOffsets(o, head) === 1`), and a mid-gap offset that no
   parent event carries (if the store's offsets happen to be dense, manufacture one
   by string surgery — a value that sorts between two real offsets). Must **409 with
   the named code**: a parent id in the branch namespace (`fs/parent-not-found`); a
   branch name that is empty, equal to `main`, containing `:`, equal to the reserved
   segment `file`, or otherwise outside the Contract's frozen branch-name grammar
   (`fs/invalid-branch-name`); an
   existing branch name (`fs/branch-exists`); a second `fs.branch.fork` appended to
   an existing branch mid-stream, and a fork record hand-crafted as a raw `/dispatch`
   action bypassing `createBranch` (`fs/fork-not-first-event`). Every must-409 case
   must return the exact frozen reason code and leave both logs byte-identical
   (dump-diff, and tail live during the refusal — any emitted frame refutes
   neutrality). Any accepted invalid fork, any wrong code, or any refusal that leaves
   a trace, is a refutation.
7. **Chain-depth and cycle sabotage.** Build a three-deep fork chain and verify each
   link's fork-identity digest independently. Then attack resolution: hand-craft a
   dump pair where the "parent" itself claims a fork record pointing back at the leaf
   (a cycle) and feed it to `ef replay --parent` — anything other than a loud typed
   failure (hang, stack overflow, silent wrong digest) refutes the resolver. Also feed
   `--parent` dumps in the wrong order and a `--parent` that is not the recorded
   `parentStreamId`; silent success on a mismatched parent refutes the citation tool.
8. **Your own fuzz, your own oracle.** Fresh seeds, fresh generator, your own
   independent model with its own diff-apply (do not reuse the builder's). Interleave
   parent-side and branch-side ops — full writes and patches, at least one
   cross-boundary patch per run — from two concurrent dispatch clients and check both
   directions: branch tree vs. model, parent tree vs. model. Verify on every run that
   `ef bisect` reports 1-based `index` exactly `N + 1` (`N` = count of parent events
   at offsets ≤ the fork offset; per the Contract the fork record is excluded from
   the resolved log, so `N + 1` must be the first branch-authored edit) — an index
   of `N` or lower (the shared prefix itself
   diverging, i.e. fork identity broken) or of `N + 2` or higher (a masked first
   divergence: the first branch-authored event silently indistinguishable from a
   parent event) each refute the divergence claim in different ways; distinguish
   which.
9. **Apparatus sabotage.** Do not reuse the builder's committed sabotages. Your own:
   make `resolveBranchLog` off-by-one (include the first parent event whose offset
   compares greater than `forkOffset`) and confirm `verify-E1-T08` goes red; make
   branch writes silently reuse the parent's `contentStreamId` in the branch tree
   without minting a stream and confirm red; make the cross-boundary patch path
   resolve its base from the parent's head instead of ≤ `forkOffset` and confirm red.
   A green run under any of these refutes the measuring apparatus, which refutes
   every other piece of evidence in this task.

Refutation currency: a dump pair + offset where fork-identity, independence, or bisect
lies (cite via `ef bisect`), a parent-side byte that moved, a branch patch applied
against the wrong base content, a dead content-stream id reachable from a branch
state, or a refused fork that left a record. "Fork should also copy watch
subscriptions" is a design note, not a finding. No refutation → promote your best
fuzz-found fork scenario into the golden corpus and your independent truncation script
into a committed test.

## Verification log
