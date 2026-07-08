---
id: E4-T11
epic: 4
title: "Conflict surfacing: the stream is the arbiter — local losers preserved byte-exact as offset-named conflict files, never silently dropped"
priority: 411
status: pending
depends_on: [E4-T09, E4-T10]
estimate: M
capstone: false
---

## Goal

`packages/cli` resolves every collision between a remote event and an unsynced local
edit by one frozen rule: **the stream wins the working-tree path, and the local loser is
preserved byte-exact on disk — never dispatched, never silently dropped**. Whenever the
downlink (E4-T07, live) or offline catch-up (E4-T10, on restart) is about to apply a
remote event to a path whose working-tree content diverges from the `.ef/` base ledger
and whose dirt is not the engine's own echo (E4-T08 provenance via the E4-T06 journal),
`packages/cli/src/sync/conflict.ts` first writes the current local bytes of that path,
verbatim, to the sibling **conflict file** `<path>.ef-conflict-<offset>` — `<offset>`
the winning remote event's opaque offset string echoed verbatim (never parsed,
reformatted, or numerically coerced — the E0-T03 opacity contract holds here too), so
the name is fully deterministic — flushes it durably, and only then lets the remote
event take the path.
The ledger's per-path base advances to the winning offset, so the path itself
classifies `clean`; the conflict is carried entirely by the conflict file.
`ef status --json` reports it: `STATUS_JSON_VERSION` is bumped **1 → 2** here (the loud,
deliberate event E4-T04 requires), adding `paths.conflicted` — a UTF-8-byte-order-sorted
array of `{ "path": ..., "conflictFile": ..., "offset": ... }` objects — with `clean`
true iff all four `paths` arrays are empty. The name pattern `*.ef-conflict-*`
is a **reserved namespace frozen here**: the E4-T06 uplink exclusion table gains this
pattern, so a conflict file never produces a dispatch and the loser's bytes never appear
in any event on the stream — resolution is the human deleting (accept stream) or
renaming (recover local) the conflict file, at which point normal E4-T04/E4-T06
machinery takes over. Under the E4-T09 two-machine harness, the three partition
scenarios — offline-remote-only, offline-local-only, true conflict — each converge to
byte-identical `ef tree-digest` on both machines equal to `ef replay <dump> --digest
--reducer` of the branch; the true-conflict run additionally leaves exactly one conflict
file byte-identical to the pre-collision local content on the losing machine, and the
dumped event log contains no event carrying the loser's bytes.

## Context

This is the last non-capstone piece of the Epic 4 watcher (ROADMAP.md, "Epic 4 —
the-roots": "conflict surfacing (the stream is the arbiter; local losers are preserved
as conflict files)"). E4-T06 deliberately stopped at *detecting* divergence — a 409
`stale-base` refusal is journaled as a typed `refused` record and the engine keeps
running, with "resolution is E4-T11's job, silence is nobody's." E4-T07's downlink and
E4-T10's catch-up can each arrive at the same cliff from the other side: a remote event
targeting a path the local user has edited but not yet (or unsuccessfully) uplinked.
This task closes all of those paths with one component and freezes the conventions the
E4-T12 capstone demos: the capstone's "survive a partition with a surfaced conflict"
leg is exactly this machinery under the E4-T09 harness.

Contracts frozen here (E4-T12 and the web app's later conflict rendering parse these;
changing them invalidates the goldens below):

- **Conflict file naming**: `<path>.ef-conflict-<offset>`, a sibling in the same
  directory, `<offset>` the winning remote event's opaque offset string **echoed
  verbatim** — E0-T03 freezes offsets as opaque strings that clients must never parse
  or fabricate, only compare and echo, and this name honors that: no numeric coercion,
  no padding removal, no reformatting. Filesystem-safety escaping rule, pinned here:
  any byte of the offset outside `[A-Za-z0-9._-]` is percent-encoded as `%XX`
  (uppercase hex); bytes inside that set pass through unchanged. The rule is
  deterministic and injective, so the name stays a pure function of the offset. (The
  offsets this repo's server actually issues — e.g. AGENTS.md's
  `0000000000000000_0000000000004821` — contain only `[0-9_]` and pass through
  untouched.) Pure function `conflictFileName(path, offset)` exported; deterministic —
  the same collision surfaced twice (crash + re-apply) targets the same name.
- **Loser-safety write ordering**: the conflict file is written and durably flushed
  **before** the working-tree path is overwritten or removed. At no instant do the
  loser's bytes exist in neither place; the reverse order is forbidden. Surfacing is
  idempotent: re-applying the same winning event with the conflict file already present
  and byte-identical is a no-op; a same-named conflict file with **different** bytes is
  a hard error (exit nonzero, nothing touched) — it can only mean corruption or a
  colliding user file, and clobbering it would drop bytes.
- **Collision rule table** (each row a committed test):
  - remote content event vs local unsynced **modify** → stream bytes take the path,
    local bytes → conflict file;
  - remote content event vs local unsynced **add** at the same path (add/add) → same;
  - remote **delete** vs local unsynced modify → path removed, local bytes →
    conflict file (the conflict file remains as the only trace);
  - remote content event vs local unsynced **delete** → remote content materializes
    the path; there is no local byte payload to preserve, so **no** conflict file and
    the path is not `conflicted` — pinned and documented, not an accident;
  - remote content event **byte-identical** to the local unsynced dirt at the same
    path (both sides independently arrived at the same bytes) → **no** conflict file:
    the ledger's per-path base advances to the winning offset, the path classifies
    `clean`, and nothing is surfaced — pinned and documented, not an accident; a
    conflict file whose bytes equal the winner would be pure noise and trains users
    to ignore conflict files;
  - type collision (remote file where local has an unsynced directory, or vice versa)
    → every displaced local file is preserved under its own
    `<path>.ef-conflict-<offset>` per the rows above, one file per loser.
  - **Echo is not conflict**: dirt whose bytes the engine's own journal accounts for
    (E4-T08 suppression) never surfaces a conflict file.
- **Reserved namespace**: paths matching `*.ef-conflict-*` (any path containing the
  `.ef-conflict-` infix followed by at least one character — deliberately broader than
  the names this task emits, so the exclusion never needs to parse or pattern-match the
  offset alphabet) are excluded from
  uplink (documented amendment to E4-T06's frozen exclusion table, with the E4-T06
  exclusion tests extended), excluded from `paths.added/modified/deleted`
  classification, and reported only via `paths.conflicted`. A pre-existing user file
  that happens to match the pattern is therefore never synced — documented loudly in
  the package README as the cost of the reservation.
- **`STATUS_JSON_VERSION = 2`**: the schema quoted in E4-T04's Context plus
  `paths.conflicted` (sorted array of `{path, conflictFile, offset}`, canonical JSON);
  `clean` iff all four arrays empty; version bump performed per E4-T04's invalidation
  rule — **every** status golden in the repo regenerated in this task's diff, no
  consumer left reading `v: 1`.

Non-goals: merge of any kind — no three-way text merge, no conflict markers inside
files (the stream is the arbiter, full stop); automatic resolution or retry of E4-T06
`refused` dispatches (the winning remote event arriving via downlink/catch-up is what
converts a refusal into a surfaced conflict — the engine never re-bases and re-sends
the loser); any web-app UI for conflicts (later epic); rename detection (a rename is
delete + create per E4-T04/T06, and each side collides independently).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T11-conflict-surfacing/`.

- `packages/cli/src/sync/conflict.ts` — `conflictFileName(path, offset)` (pure) and
  `surfaceConflict({workspaceRoot, path, winningOffset, localBytes})` implementing the
  loser-safety ordering and idempotence contract; plus the pure collision classifier
  `classifyCollision(remoteEvent, ledgerEntry, workingBytes, journalView)` → row of the
  frozen rule table (or `echo` / `no-conflict`), unit-testable without a filesystem or
  server.
- Integration into both arrival paths: the E4-T07 downlink apply loop and the E4-T10
  catch-up reconciler both route every remote application through the classifier and
  `surfaceConflict` before touching the working tree; the E4-T06 journal's `refused`
  records are consumed so a fenced-out local edit surfaces exactly once when its winner
  lands.
- `STATUS_JSON_VERSION = 2` in `packages/cli` with `paths.conflicted`; every committed
  status golden regenerated; package README schema section updated verbatim.
- E4-T06 exclusion table amended with `*.ef-conflict-*` (README table + the
  exclusion tests extended to prove a conflict file, and an edit to a conflict file,
  produce zero dispatches).
- Package README section "Conflict surfacing" documenting the frozen name pattern, the
  write ordering, the full rule table, the reserved-namespace cost, and the resolution
  story (delete = accept stream, rename = recover local).
- `packages/cli/test/conflict.test.ts` — the pure classifier and `conflictFileName`
  against every rule-table row, echo-vs-conflict discrimination, idempotence, and the
  differing-bytes hard error.
- `packages/cli/test/conflict.integration.test.ts` — real server on an ephemeral port:
  (a) **live** collision — watcher running, foreign writer advances a locally-dirty
  path, the winning event arrives via downlink, conflict surfaced, digests converge;
  (b) **catch-up** collision — watcher stopped, both sides edit, restart reconciles
  (E4-T10) and surfaces; (c) delete/edit both directions and add/add; each asserting
  conflict-file byte identity against pre-captured local bytes, ledger advance,
  `ef status --json` (`v: 2`) reporting the exact `conflicted` triple, and dump
  neutrality (no event carries loser bytes).
- E4-T09 harness scenarios promoted: the three partition scenarios
  (offline-remote-only, offline-local-only, true-conflict) added to the harness's
  scripted scenario set and to `make verify-E4-sync`, each asserting both machines'
  `ef tree-digest` byte-equal to `ef replay --digest --reducer` of a fresh dump; the
  true-conflict scenario additionally asserts exactly one conflict file with the
  expected name and bytes, and that the non-losing machine has **no** conflict file.
- Crash-safety check: fault injection (or SIGKILL harness) between conflict-file flush
  and working-tree overwrite — restart must find the loser's bytes on disk, re-apply
  idempotently, and converge; committed as a test.
- `Makefile`: `verify-E4-T11` per the E0-T02 per-task contract — the test files, the
  harness partition scenarios, replay of the committed dump to its committed digest,
  and the sensitivity sabotage steps (below), each printing `EXPECTED-FAIL OK` only
  after observing red; joins `verify-all`; `tools/verify/self_check.sh` still passes.
- `evidence/` — `e4-t11-scenarios.txt` (harness transcript of all three partition
  scenarios with both machines' digests and the replay digest per scenario),
  `e4-t11-branch-log.jsonl` (dumped branch log from the true-conflict run),
  `e4-t11-loser.bin` + `e4-t11-conflict-file.bin` (the pre-collision local bytes
  captured before the partition heals, and the resulting conflict file — byte-identical,
  SHA-256 of both recorded in `e4-t11-digests.txt` alongside the convergence digests),
  `e4-t11-status.json` (the losing machine's `ef status --json` v2 line showing
  `conflicted`), and `e4-t11-sensitivity.md` (the sabotage transcript).

## Acceptance criteria

- [ ] `make verify-E4-T11` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (scrubbed env, fresh server data dir, ephemeral
      port), zero skips — evidence:
      `make verify-E4-T11 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Three-scenario convergence: each harness partition scenario ends with machine A's
      `ef tree-digest`, machine B's `ef tree-digest`, and `ef replay <fresh dump>
      --digest --reducer` all byte-identical (three independent instruments, never one
      value echoed), recorded per scenario in `evidence/e4-t11-scenarios.txt` and
      re-asserted by `verify-E4-sync`. Offline-remote-only and offline-local-only end
      with **zero** conflict files on either machine — a conflict file in a
      non-conflicting scenario is a false positive and fails the run.
- [ ] Loser preserved byte-exact: in the true-conflict scenario, the conflict file's
      bytes equal the pre-collision local content captured **before** the partition
      healed — `cmp evidence/e4-t11-loser.bin evidence/e4-t11-conflict-file.bin` exits
      0, SHA-256 pair in `evidence/e4-t11-digests.txt`, and the committed integration
      test re-asserts byte identity (not just digest) on every run.
- [ ] Deterministic name, frozen: the conflict file is exactly
      `<path>.ef-conflict-<offset>` where `<offset>` is the winning event's offset
      string as found in the committed dump, **echoed verbatim** (plus the pinned
      percent-escaping rule for any byte outside `[A-Za-z0-9._-]`) — a committed test
      computes the expected name from the dump independently of `conflictFileName` by
      string concatenation/escaping of the dump's offset field, never by parsing or
      numerically interpreting it, and compares by string equality; the harness
      true-conflict scenario asserts the literal filename.
- [ ] Never dispatched: a committed test walks `evidence/e4-t11-branch-log.jsonl` (and
      the fresh dump on every run) and proves no event contains the loser's bytes —
      neither as a full write nor reconstructible as a patch (apply every content event
      for the contested path via E1-T03 and byte-compare each resulting revision
      against the loser) — and the E4-T06 journal bijection shows no `accepted` record
      for the conflict-file path, ever, including after the conflict file is itself
      edited on disk while the watcher runs.
- [ ] `ef status` reports it: on the losing machine the `--json` line has `"v": 2`,
      `paths.conflicted` equal to the exact expected `{path, conflictFile, offset}`
      triple, `clean: false`, and the contested path absent from
      `added/modified/deleted`; deleting the conflict file flips the report to
      `clean: true` with `workingTreeDigest === baseTreeDigest` — both states committed
      as test assertions, the former captured in `evidence/e4-t11-status.json`.
- [ ] Version bump done loudly: `STATUS_JSON_VERSION === 2` and every status golden in
      the repo regenerated in this task's diff. Evidence, in canonical-JSON form (the
      frozen encoding has no whitespace, so the token is `"v":1`, not `"v": 1`):
      negative — `git grep '"v":1' -- '**/golden-status/**' '**/fixtures/**'` prints
      nothing; positive — `git grep -l '"v":2' -- '**/golden-status/**'` lists every
      committed status golden (an empty grep on unregenerated goldens must not pass
      as success). Consumers checked separately: `git grep -nE 'STATUS_JSON_VERSION|"v":1'
      -- 'packages/**'` shows no code branching on or accepting status version 1, and
      the E4-T04 suite plus every other status-JSON consumer fails loudly when fed a
      `"v":1` document (committed as a test); E4-T04's suite re-runs green against the
      regenerated goldens.
- [ ] Rule table fully exercised: `conflict.test.ts` covers every row including
      local-delete-vs-remote-edit (no conflict file — asserted, not skipped), the
      equal-bytes row (remote winner byte-identical to local dirt → no conflict file,
      ledger advances, path clean — asserted, not skipped), type
      collisions (one conflict file per displaced loser), echo discrimination (journal-
      attributable dirt surfaces nothing), idempotent re-surface, and the
      differing-bytes hard error (nonzero exit, working tree untouched — asserted by
      before/after `ef tree-digest`).
- [ ] Crash-safe, loser never lost: the fault-injection test kills between conflict-file
      flush and working-tree write; after restart and catch-up the loser's bytes exist
      at the conflict-file name, the path holds the stream bytes, digests converge, and
      exactly one conflict file exists (no `.ef-conflict-` duplicates or partial temp
      artifacts).
- [ ] Sensitivity: `verify-E4-T11`'s sabotage step runs the suite in a scratch worktree
      under each of: (a) conflict-file write disabled (loser dropped), (b) write
      ordering inverted (tree first, conflict file second — the fault-injection test
      must catch it), (c) uplink exclusion for `*.ef-conflict-*` removed (loser leaks
      onto the stream — the dump-neutrality test must catch it), (d) `conflictFileName`
      offset off by one (the dump-derived name check must catch it), (e) echo
      discrimination disabled (every downlink apply of the machine's own echoed edit
      surfaces a bogus conflict — the clean-scenario zero-conflict-file assertion must
      catch it) — each observed red before `EXPECTED-FAIL OK`; evidence:
      `make verify-E4-T11 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 5, transcript in
      `evidence/e4-t11-sensitivity.md`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `make verify-list` maps
      `verify-E4-T11` to this task; `verify-all` and `verify-E4-sync` green; the
      E4-T04, E4-T06, E4-T07, E4-T09, and E4-T10 suites re-run green (E4-T04's against
      regenerated goldens, all others unmodified).

## Adversarial verification

The claim under attack: "whenever the stream and an unsynced local edit disagree, the
stream takes the path, the local bytes survive verbatim under a deterministic
offset-derived name, the loser never reaches the stream — and nothing is ever surfaced
that wasn't a real conflict." Use your own directories, edit payloads, seeds, and
partition timing throughout; invent at least one angle this list lacks. Any single
success refutes.

1. **Your own partitions, differential (mandatory).** Ignore the builder's scenarios.
   Under the E4-T09 harness with your own seeds, run many randomized partition rounds:
   both machines editing overlapping and disjoint path sets while partitioned, then
   heal. For every round: three-way digest agreement (both trees vs fresh-dump replay)
   or refuted; **exactly** the overlapping dirty paths produce conflict files, on the
   losing side only — a missing conflict file where both sides touched a path refutes
   preservation; a conflict file on a path only one side touched, or on the winning
   machine, refutes the classifier (false positives are angle-5's silent-drop twin:
   they teach users to ignore conflict files).
2. **Byte forensics on the loser.** Before healing, snapshot the losing machine's
   contested files yourself (`cp` + `shasum`, outside the tooling). After surfacing,
   `cmp` your snapshot against the conflict file — any byte difference, including
   trailing-newline or encoding normalization, refutes "byte-exact." Use hostile
   payloads: binary with NUL bytes, CRLF, invalid UTF-8, an empty file, a multi-MB
   file, and a payload byte-identical to the remote winner: the rule table pins the
   equal-bytes row as **no conflict file, ledger advances, path classifies clean** —
   attack that row specifically (a surfaced conflict file whose bytes equal the winner
   refutes the pinned row; so does a path left dirty or a ledger base that fails to
   advance to the winning offset).
3. **Stream pollution hunt.** Dump the branch after your rounds and hunt for the loser:
   grep for distinctive marker bytes you planted in the losing content; reconstruct
   every revision of every contested path via E1-T03 patch application and byte-compare
   each against your snapshots; audit the E4-T06 journal for any `accepted` record
   whose path matches `*.ef-conflict-*`. Then edit a conflict file directly while the
   watcher runs, and create your own decoy `real-file.ef-conflict-42` before any
   conflict exists — any dispatch from the reserved namespace refutes exclusion; the
   decoy silently never syncing must be documented in the README (undocumented =
   refuted; documented = the pinned cost).
4. **Name determinism, dump-derived.** Compute the expected conflict-file name yourself
   from your dump's winning-event offset string — echo it verbatim through the pinned
   escaping rule, never through `conflictFileName`, and never by parsing or numerically
   coercing the offset (E0-T03/E0-T09 forbid that; a check that only passes after
   stripping padding or converting to a number is itself a finding). A mismatch
   refutes. Then engineer two successive conflicts on the same path (surface, leave the
   conflict file in place, conflict again at a later offset): two distinct
   offset-named files must coexist, neither clobbered. Engineer a re-delivery (restart
   the watcher so E4-T10 re-walks the winning event): a duplicate, renamed, or
   clobbered conflict file refutes idempotence.
5. **Kill it at the cliff.** SIGKILL the watcher/catch-up repeatedly around the
   surfacing instant (tight loop, random jitter — don't trust the builder's injection
   points). After every kill, before restarting, audit the disk: if the contested
   path already holds stream bytes and no conflict file (or a torn/partial one) holds
   the loser, the ordering contract is refuted — the loser's bytes existed nowhere.
   Then restart and require convergence plus exactly one intact conflict file.
6. **Echo and refusal plumbing.** Run a single machine with `ef watch` (E4-T08) and
   hammer local edits — every downlinked echo of its own uplink must surface nothing
   (a machine that conflicts with itself refutes discrimination). Then force an E4-T06
   `refused` record (foreign writer wins the fence) and let the winner arrive: exactly
   one conflict file, and the engine never re-dispatches the refused content — a
   rebased retry of the loser appearing in the dump refutes "the stream is the
   arbiter."
7. **Status honesty.** Validate the v2 JSON against the pinned schema on your own runs:
   `conflicted` sorted by UTF-8 byte order, the triple's `offset` matching the dump,
   the contested path absent from the other three arrays, `clean` false. Delete the
   conflict file → `clean: true`; rename it to a normal name → the rename uplinks as a
   normal add and the recovered bytes land on the stream (this is the documented
   resolution story — if recovery-by-rename doesn't actually sync, the story is
   refuted). Hunt for any remaining `"v":1` golden or consumer in the repo (canonical
   JSON has no space after the colon — grep for the token that can actually occur).
8. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed five:
   (a) make surfacing write the conflict file from the ledger's base bytes instead of
   the live working-tree bytes (a plausible bug that preserves the *wrong* loser),
   (b) make the classifier treat `added` dirt as echo, (c) surface into `/tmp` instead
   of the sibling path. `make verify-E4-T11` must go red under each — any sabotage
   that stays green refutes the apparatus for that property.
9. **Cold clone + evidence provenance.** Run only via `tools/verify/cold_clone.sh`.
   Re-derive the true-conflict evidence yourself from the committed harness scenario:
   fresh server, fresh clones, run the scenario, and check your conflict file's bytes
   and name shape against the committed `e4-t11-conflict-file.bin` and dump. Committed
   evidence that cannot be regenerated from the committed scenario and code refutes
   its provenance. Hold the diff against the tests: every changed hunk in
   `conflict.ts`, the downlink/catch-up integration points, and the status v2 path
   executed somewhere, or classified needs-evidence/dead per AGENTS.md.

Refutation currency: a `cmp` diff between your pre-collision snapshot and the conflict
file, a dump offset whose event reconstructs the loser's bytes, a post-kill disk state
where the loser exists nowhere, a conflict file on the wrong machine or a clean-scenario
machine, a status line whose `conflicted` triple contradicts the dump, or a sabotage run
that stays green. "The conflict file name is ugly" is a note, not a finding.

## Verification log
