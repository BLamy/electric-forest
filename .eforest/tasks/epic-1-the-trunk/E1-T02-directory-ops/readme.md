---
id: E1-T02
epic: 1
title: "Directory operations: mkdir, rmdir, rename/move, tombstones, deterministic tree listing"
priority: 102
status: in-progress
depends_on: [E1-T01]
estimate: M
capstone: false
---

## Goal

`@eforest/streamfs` (`packages/streamfs`, the E1-T01 package) speaks full directory
semantics through the same single dispatch door: three new metadata event types —
`fs.dir.create` (mkdir), `fs.dir.remove` (rmdir, **empty-only**, typed refusal
otherwise), and `fs.rename` (files and directories alike) — plus revised
`fs.file.delete` semantics that leave a **tombstone** recording the retired
`contentStreamId`. A directory rename is **one event** whose replay re-keys every
descendant path in the reduced tree while each descendant keeps its file identity
byte-for-byte — no content stream is created, appended to, copied, or deleted by any
rename. A create at a tombstoned path replaces the tombstone and mints a **fresh**
content-stream identity; the old content stream is never resurrected. The canonical tree
state becomes v2 — `{ files, dirs, tombstones }`, each a lexicographically key-sorted
map — and `treeDigest(state)` remains exactly `stateDigest(state)` from
`@eforest/protocol`, never a second hashing implementation. `listTree(state)` (exported
from `@eforest/streamfs`) returns every dir and file entry in one frozen canonical
order, derived **purely from reduced state** (no log access, no I/O), byte-stable across
replays, processes, and environments. Because tombstones and directory entities change
the frozen tree-state shape, this task performs the **first deliberate contract
revision** under E1-T01's documented invalidation rule: `FS_EVENT_VERSION` bumps 1 → 2,
`v: 1` events are refused at dispatch and red at replay, and every fs golden in the repo
is regenerated with the reason stated in this task's Verification log. All directory-op
refusals — non-empty rmdir, rename into own descendant, missing sources, occupied
destinations, missing parents, malformed paths — happen **before append**: after every
refusal the metadata stream's head offset is byte-identical and the stream stays usable.

## Context

E1-T01 gave stream-fs files; this task gives it a filesystem. Everything downstream
leans on directory semantics being *replay-defined*: `watch()` (E1-T05) derives
chokidar-compatible `addDir`/`unlinkDir` events from these metadata events; branch
forking (E1-T08) stays cheap only because a directory move is one event, not N content
rewrites; three-way merge (E1-T10) needs delete-vs-never-existed to be distinguishable
in reduced state — which is exactly what tombstones are for (E1-T01 deferred them here
"on branch-fork grounds"); and the E1-T11 capstone writes a *source tree*, not a flat
bag of paths. The reference stream-fs implementation (read-only prior art per AGENTS.md)
has metadata + content streams but no VCS-grade directory semantics — these are ours to
define, and they are defined the only way this repo accepts: as frozen events whose
replay is the specification, provable by `ef replay --digest` (E0-T04) and localizable
by `ef bisect` (E0-T12).

**Contract revision, performed here exactly as E1-T01 prescribed.** E1-T01 froze the fs
envelope and tree-digest recipe under `FS_EVENT_VERSION = 1` with the rule: any change
requires a version bump plus regeneration of every fs golden — a loud, deliberate event.
This task triggers that rule (delete semantics change; tree state gains `dirs` and
`tombstones`), so it executes the ritual in full and in the open:

- `FS_EVENT_VERSION = 2`. Every fs payload (all six types) carries `v: 2`. A `v: 1`
  event is refused by dispatch (log untouched) and makes `ef replay` exit nonzero with a
  diagnostic naming the 1-based line — old logs are corrupt under v2 by design, never
  silently reinterpreted.
- `evidence/golden-fs.jsonl` + `.digest` in E1-T01's folder are regenerated as v2 (with
  the mkdirs the strict-parent rule below now requires) and `verify-E1-T01` must be
  green against the regenerated pair. The regeneration reason is written into **both**
  tasks' Verification logs — a blessed golden without a stated reason is a standing
  critic red flag (AGENTS.md, ORIENT).
- The package readme codifies the **additive extension rule** going forward, so E1-T03+
  do not re-bump: adding a new `fs.*` event type under the current version does not
  invalidate goldens (old logs contain no such events and replay identically); changing
  an existing payload schema, a reducer semantic, or the tree-state/digest recipe does.

**Contract frozen here (v2), verbatim in the package readme:**

- Event payloads (extending E1-T01's envelope; path rules unchanged from E1-T01):
  - `fs.dir.create` — `{ v: 2, path }`
  - `fs.dir.remove` — `{ v: 2, path }` — refused unless `path` is an existing dir with
    no file or dir entry strictly under it (tombstones do **not** block rmdir; they are
    records, not entries, and keep their full path keys after their ancestor dirs go)
  - `fs.rename` — `{ v: 2, from, to }` — `from` an existing file or dir; refused when
    `from` is missing, `to` (or any entry at `to`) exists, `to` equals `from`, `to` is
    a strict descendant of `from` (dir into itself), or `to`'s parent dir is missing.
    A tombstone at `to` does **not** block the rename (tombstones are records, not
    entries) and is **cleared** by it: after the rename, `tombstones[to]` is absent and
    `files[to]`/`dirs[to]` carries the moved entry's existing identity — the retired
    content stream is never resurrected by a rename any more than by a create
  - `fs.file.create` / `fs.file.write` — schemas as E1-T01 but `v: 2`; **strict
    parents**: every non-top-level create (file or dir) requires its parent to exist in
    `dirs`; top-level entries have the implicit root as parent
  - `fs.file.delete` — `{ v: 2, path }` — removes the file entry and writes
    `tombstones[path] = { contentStreamId }` (the retired identity)
- Canonical tree state v2 — `{ files: { [path]: { contentStreamId, contentSha256,
  size } }, dirs: { [path]: {} }, tombstones: { [path]: { contentStreamId } } }`. All
  three maps always present (empty maps included); a path is in at most one of
  `files`/`dirs`/`tombstones` at a time — a live entry and a tombstone never coexist at
  the same path. Any event that installs an entry at a tombstoned path deletes the
  tombstone entry: `fs.file.create` (which also mints a fresh `contentStreamId`),
  `fs.dir.create` (dirs have no content stream; the tombstone is simply removed), and
  `fs.rename` with that path as `to` (the moved entry keeps its existing identity).
  `fs.rename` re-keys entries with identities
  intact and writes **no** tombstone (only deletes do). `treeDigest` is
  `stateDigest(state)` over this shape — canonical-JSON key sorting supplies the
  digest's determinism exactly as in E1-T01.
- `listTree(state)` canonical order — exactly one rule: entries (dirs and files
  together, each row `D <path>` or `F <path> <contentSha256> <size>`) sort by
  **segment-wise** full-path comparison: split on `/`, compare corresponding segments
  left-to-right as raw UTF-16 code-unit strings, first unequal segment decides, shorter
  path (the ancestor) first. Worked example, normative: `a/b` sorts **before** `a!`
  (segments `a` < `a!`), even though naive whole-string comparison would reverse them
  (`!` 0x21 < `/` 0x2F). This guarantees every dir precedes its descendants. This is
  the *listing* order only; the digest keeps canonical-JSON key order — the two rules
  are frozen independently and documented side by side.

Reducer-level errors follow E1-T01's rule: any dispatch-refused precondition appearing
in a raw log (rmdir non-empty, rename onto an occupied path, orphaned create, `v: 1`)
is corruption — `ef replay` exits nonzero at that line, never skips.

Non-goals: text patches (E1-T03), stale-write fencing (E1-T04) — directory ops here are
last-write-wins like E1-T01 file writes; `watch()` events (E1-T05); snapshots (E1-T07);
branches (E1-T08); any merge semantics over tombstones (E1-T09/T10 consume them).

## Deliverables

- `packages/streamfs/src/version.ts` — `FS_EVENT_VERSION = 2`; package readme updated
  with the v2 envelope, tree-state shape, tombstone semantics, strict-parent rule, the
  `listTree` order with worked examples, and the additive extension rule.
- `packages/streamfs/src/events.ts` — the three new payload types plus runtime guards
  extending E1-T01's validators (missing/extra/wrong-typed fields, path-rule
  violations, `v !== 2` refused).
- `packages/streamfs/src/reducer.ts` — `fsReducer` extended: mkdir/rmdir/rename/
  tombstone semantics as frozen above, still pure (E1-T01's purity grep must stay
  clean), still shipped as the standalone `ef replay --reducer` module.
- `packages/streamfs/src/tree.ts` — tree-state v2 type, `emptyTree()`, `listTree(state)`
  returning the frozen-order rows; implemented against reduced state only.
- `packages/streamfs/src/fs.ts` — `StreamFs` gains `mkdir(path)`, `rmdir(path)`,
  `rename(from, to)`, `list()` (the `listTree` rows at head); all metadata mutation
  still exclusively via `/dispatch` (the E1-T01 one-door grep check must keep passing
  over the grown surface).
- Server-side: dispatch validation for the new types and preconditions in the E0-T11
  stage order, on the registered `fs-meta` reducer version.
- Regenerated E1-T01 goldens (see Context) with reasons logged in both Verification
  logs; `verify-E1-T01` green against them.
- Committed golden fixture: `evidence/golden-dirs.jsonl` — a v2 metadata dump
  exercising nested mkdir, files at multiple depths, a deep directory rename (≥ 2
  levels, ≥ 3 descendants including a unicode path) whose `to` is a clean,
  never-tombstoned path, a file rename whose `to` **is** a tombstoned path (tombstone
  cleared, moved entry's identity carried — this file rename, not the deep rename, is
  the fixture's only rename onto a tombstoned destination), deletes producing
  tombstones, rmdir of an emptied dir, rmdir of a dir containing only tombstones,
  re-create at a tombstoned path, and an `fs.dir.create` at a tombstoned path
  (tombstone cleared) — plus `evidence/golden-dirs.digest` (frozen once,
  never regenerated by any check that consumes it) and `evidence/golden-dirs.listing`
  (the frozen `listTree` output, one row per line).
- Hand-frozen rename fixture: `evidence/rename-expected-tree.json` — the complete
  expected v2 tree state **after** the golden's deep rename, authored by hand from the
  spec (not dumped from the implementation; its derivation is described in a comment
  block or sibling note), plus a committed test folding `golden-dirs.jsonl` to just
  before the rename event, applying it, and requiring (a) deep equality with the
  hand-frozen tree, (b) the set of changed keys vs the pre-rename fold is exactly the
  renamed subtree's keys plus, if the destination was tombstoned, that one tombstone's
  key (the deep rename's destination is clean, so for it the set is exactly the
  subtree's keys), (c) every moved entry's `contentStreamId`/`contentSha256`/`size`
  byte-identical to its pre-rename value, and (d) for the golden's file rename onto the
  tombstoned path (the fixture's only tombstone-destination rename), the same test
  folds to just before that event, applies it, and requires that `tombstones` key
  absent post-rename with the moved entry's identity intact.
- Refusal corpus: `evidence/fuzz/` — dispatch bodies that must be refused with the log
  untouched: rmdir non-empty (file child; dir child), rmdir missing/on-a-file, mkdir
  existing (as dir; as file), mkdir with missing parent, orphaned file create, rename
  from-missing, rename onto existing file/dir, rename dir into its own descendant,
  rename onto itself, rename with missing target parent, `v: 1` payloads of every
  type, unknown `fs.dir.*` type, every E1-T01 path-rule violation class against the
  new fields. Each case asserts expected status + error class and byte-identical head
  offset before/after, and that a valid dispatch afterwards succeeds.
- Integration tests (`packages/streamfs/test/`) against a real server: the golden
  session end-to-end via `StreamFs`, the refusal corpus, tombstone re-create (fresh
  `contentStreamId`, old stream unread), rename content-stream immutability (per-file
  content stream head offsets captured before/after a deep rename, all unchanged, no
  stream created or deleted), and the E1-T01 differential triangle (`GET /state` +
  `treeDigest`, `ef replay --reducer` on the dump, in-process `replay()`) agreeing on a
  directory-heavy session.
- `Makefile`: `verify-E1-T02` in the marker section composing the frozen helper recipes
  plus: replay `evidence/golden-dirs.jsonl` through `ef replay --digest --reducer`
  **twice as separate `ef` invocations**, compare both to each other and to
  `evidence/golden-dirs.digest`; emit `listTree` from the replayed state twice in fresh
  processes and byte-diff both against `evidence/golden-dirs.listing`; then the
  sensitivity proof — flip one byte of one event in a temp copy, assert nonzero exit or
  digest change, printing `MUTATION fixture=golden-dirs byte=<offset> digest-mismatch
  EXPECTED-FAIL OK` only after observing it. Joins `verify-all`;
  `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E1-T02` exits 0 with zero skips — evidence:
      `make verify-E1-T02 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] `ef replay evidence/golden-dirs.jsonl --digest --reducer <path>` — where `<path>`
      is the standalone reducer module path stated in `packages/streamfs/README.md`
      (the E1-T01 `ef replay --reducer` module, rebuilt here) — prints
      exactly one lowercase-hex SHA-256 matching `evidence/golden-dirs.digest` and exits
      0; two fresh-process runs are byte-identical, and the Makefile step performs them
      as two separate `ef` invocations.
- [ ] Listing byte-stability: `listTree` output from two independent replays of the
      golden, in fresh processes, under default env and under
      `TZ=Pacific/Kiritimati LANG=C`, is byte-identical to
      `evidence/golden-dirs.listing` (`diff` empty, all pairs); the golden's paths
      include a pair ordered differently by segment-wise vs whole-string comparison
      (e.g. `a/b` vs `a!`) so the frozen rule — not an accidental substitute — is what
      the fixture pins. Evidence: committed test + the Makefile byte-diff step.
- [ ] Rename surgery: the committed test against
      `evidence/rename-expected-tree.json` passes — post-rename fold deep-equal to the
      hand-frozen tree; the set of changed keys vs the pre-rename fold is exactly the
      renamed subtree's keys plus, if the destination was tombstoned, that one
      tombstone's key (the golden's deep rename lands on a clean path, so its
      changed-key set is exactly the subtree's keys; the tombstone-destination case is
      the golden's separate file rename); every moved entry's identity fields
      byte-identical — evidence: the test green under `pnpm test`, fixture committed
      with its hand-derivation note.
- [ ] Rename moves pointers, not bytes: after the deep rename in a live integration
      session, every affected file's content stream has a byte-identical head offset to
      before, and no content stream was created or deleted — evidence: committed
      integration test printing the offset table.
- [ ] Tombstones: deleting a file puts `{ contentStreamId }` at its path in
      `tombstones`; re-creating that path removes the tombstone, mints a fresh
      `contentStreamId` differing from the retired one, and `readFile` returns the new
      bytes only; renaming an entry onto a tombstoned path clears the tombstone with
      the moved entry's identity intact; `fs.dir.create` at a tombstoned path clears
      the tombstone; rmdir succeeds on a dir whose only remaining records are
      tombstones — evidence: committed tests, green.
- [ ] Refusal matrix: every `evidence/fuzz/` case dispatched to a live metadata stream
      is refused with its expected status + error class, head offset byte-identical
      before/after, and a subsequent valid dispatch to the same stream succeeds
      (asserted per corpus case) — evidence: committed integration test iterating
      the corpus.
- [ ] Corrupt-log rule: a dump containing any dispatch-refusable directory event (rmdir
      non-empty, rename onto occupied, orphaned create) or any `v: 1` event makes
      `ef replay` exit nonzero naming the 1-based line — evidence: committed CLI test
      cases in the fuzz corpus.
- [ ] Version ritual: `FS_EVENT_VERSION` is 2; `v: 1` dispatch refused with the log
      untouched; every fs golden in the repo is v2; `verify-E1-T01` is green against
      the regenerated E1-T01 golden; the regeneration reason appears in both tasks'
      Verification logs — evidence: the committed files and logs, plus
      `make verify-E1-T01 verify-E1-T02` exit 0.
- [ ] One-door and purity checks from E1-T01 still pass over the grown surface: the
      append-surface grep check and the reducer purity grep both return clean with the
      new modules inside their scanned sets — evidence: the committed checks green.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E1-T02` to this task; `verify-all` (every E0
      target, E0-T09 transcripts, `verify-E1-T01`) green.
- [ ] Replay browser layer: N/A (library + server + CLI surface; no browser-reaching
      surface until Epic 3) — declared explicitly in the Verification log per
      AGENTS.md; stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that directory semantics are replay-defined and that the
listing and digest are deterministic instruments. Use your own inputs, never the
builder's. Any single success refutes.

1. **Rename surgery, your own tree (mandatory).** Ignore the builder's fixture. Build
   your own session: nested dirs, ≥ 5 files, unicode names, then one deep rename. Fold
   the log yourself to before and after the rename and diff the two states: the changed
   keys must be exactly the renamed subtree's (in `files` and `dirs`), every moved
   entry's `contentStreamId`/`contentSha256`/`size` byte-identical, `tombstones`
   untouched. One extra changed key, one mutated identity field, or one tombstone
   written by a rename refutes. Then probe every affected content stream directly: any
   head offset moved, any stream created or deleted during the rename, refutes
   "re-points, not copies" regardless of what the tree says.
2. **Containment and collision fuzz.** Dispatch your own hostile renames: dir into its
   own descendant (`a` → `a/b/c`), onto itself, onto an existing file, onto an existing
   dir, `from` missing, `to` under a missing parent, `from` a prefix-but-not-ancestor of
   `to` (`ab` → `a/x` must be legal — a prefix check that isn't segment-aware refutes),
   NFD form of an existing NFC path, 1k-deep source dir. Every refusal must leave the
   head offset byte-identical (probe before/after) and the stream usable. Any accepted
   violation, or any refusal that appended anyway, refutes. Then raw-append (E0-T05
   door) a *schema-valid but precondition-violating* dir event — rename onto an occupied
   path — and confirm `ef replay` and `GET /state` go red at that line rather than fold
   it: dispatch preconditions must be replay invariants, not HTTP-time courtesy.
3. **Tombstone resurrection.** Delete a file, re-create the path, and try to reach the
   old bytes: read the new path, enumerate content streams, forge a dump whose
   re-create reuses the retired `contentStreamId`. Refutation: the fresh file ever
   serves the retired stream's bytes, the retired and fresh ids collide, or the forged
   dump replays green (the reducer must refuse or the digest must differ — the docs say
   which; silence is a refutation of the docs). Also check the ledger: delete → verify
   the tombstone is present in `/state`, in `ef replay` output state, and absent from
   `listTree` rows; re-create → tombstone gone. Run the same ledger check with the
   other two carriers: rename an existing entry onto the tombstoned path (tombstone
   gone, moved entry's identity intact, retired bytes unreachable) and `fs.dir.create`
   at the tombstoned path (tombstone gone). A tombstone coexisting with a live
   `files`/`dirs` entry at the same path, on any surface, refutes; any of the three
   surfaces disagreeing refutes.
4. **Listing order, adversarially named.** Create your own paths that separate the
   candidate orderings: `a/b` vs `a!` vs `a"b`, combining characters vs precomposed,
   astral-plane names, a dir named with a character above `/` and below `0`. Replay
   twice in fresh processes, plus under `TZ=Pacific/Kiritimati LANG=C` and a different
   cwd; byte-diff listings. Any difference refutes. Then verify the order matches the
   *frozen rule by hand* for your names — an order that is stable but violates the
   documented segment-wise rule refutes the spec claim, not just determinism. Read
   `listTree`'s implementation and its import closure: any access to the log, the
   client, a locale-sensitive collator (`localeCompare`, `Intl`), or env refutes
   "derived purely from reduced state".
5. **Sensitivity, your own bytes.** Sweep your own single-byte mutations over a copy of
   `evidence/golden-dirs.jsonl` — inside a rename `to`, a dir path, a tombstoned
   path, a `v` field; swap a mkdir past a create that needs it; delete the rmdir line;
   duplicate the rename. Contract per E1-T01: each must exit nonzero, change the
   digest, or be provably state-preserving under your own independent fold of the
   mutated log (never merely golden-vs-digest). A mutation whose fold provably differs
   yet replays green to the golden digest refutes the measuring apparatus — file that
   as a task refutation. Confirm the carve-out classes are enumerated in the package
   readme, not discovered ad hoc.
6. **The version ritual, audited.** Dispatch a `v: 1` event of every type — all must be
   refused, log untouched; plant one in a dump — replay must exit nonzero at its line.
   Then audit git history: the E1-T01 golden regeneration must be one deliberate commit
   with the reason in both Verification logs; a golden that changed without a stated
   reason, or a check anywhere that recomputes a committed digest at check time
   (delete `evidence/golden-dirs.digest` and run the target — it must fail red, not
   regenerate-and-pass), refutes. Derive the golden digest independently (parse the
   jsonl, fold the documented v2 semantics by hand, canonical-JSON + `shasum -a 256`);
   disagreement refutes; a digest only the package's own code can reproduce is
   needs-evidence.
7. **Sabotage the suite.** In a scratch worktree, break the implementation four ways:
   (a) make rmdir accept non-empty dirs, (b) make rename deep-copy — mint fresh
   contentStreamIds for moved files, (c) make `fs.file.delete` drop the path without a
   tombstone, (d) sort `listTree` by naive whole-string code units. For each:
   `pnpm test` **and** `make verify-E1-T02` must go red — (d) in particular must be
   caught by the committed listing fixture, proving the golden's names actually
   separate the orderings. Any sabotage that stays green refutes whichever gate it
   slipped past. Check the diff for `.skip`/`.todo`/inline lint disables while there.
8. **Strict parents and entity collisions.** mkdir under a missing parent, create a
   file where a dir lives and vice versa, mkdir twice, rmdir a file, delete a dir via
   `fs.file.delete` — each refused, head untouched. Then the ordering trap: a log where
   a file create precedes its parent's mkdir must be red at replay. Any implicit-parent
   leniency that the docs don't state refutes the frozen strict-parent rule.
9. **Coverage.** Hold the claimed final run and committed tests against the diff: every
   new event type, every refusal class in the corpus, the tombstone re-create path, the
   content-stream immutability check, and the listing fixture must each have been
   executed by a committed test or a cited transcript. Unexecuted diff is unproven or
   dead — the builder picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your independent digest derivation, your adversarially-named
listing fixture, and any fuzz case that reached interesting surface into the refusal
corpus.

## Verification log
