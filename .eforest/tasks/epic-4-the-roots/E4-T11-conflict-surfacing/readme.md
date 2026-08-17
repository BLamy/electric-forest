---
id: E4-T11
epic: 4
title: "Conflict surfacing: the stream is the arbiter — local losers preserved byte-exact as offset-named conflict files, never silently dropped"
priority: 411
status: in-progress
depends_on: [E4-T10]
estimate: M
capstone: false
---

## Goal

`packages/cli` resolves every collision between a stream event and an unsynced local
edit by one frozen rule: **the stream wins the working-tree path; the local loser is
preserved byte-exact as a deterministic, offset-named conflict file; and the condition
is announced by a conflict event on the branch stream — never silently dropped, never
merged.** Whenever offline catch-up (E4-T10's reconcile — the journaled `refused`
records plus downlink collisions) or the live downlink (E4-T07's divergence halt) finds
a path changed both locally and on the stream,
`packages/cli/src/sync/conflict.ts::surfaceConflict` (1) writes the local loser's bytes,
verbatim, to the sibling conflict file `<path>.conflict-<offset>` — `<offset>` the
winning stream event's opaque offset string echoed verbatim per the E0-T03 opacity
contract (never parsed, reformatted, or numerically coerced; bytes outside
`[A-Za-z0-9._-]` percent-encoded `%XX` uppercase) — and durably flushes it; (2) only
then lets the winning event take the working-tree path, advancing the `.ef/` ledger to
the winning offset; (3) uplinks the conflict file **as a normal file** through the
fenced, journaled E4-T06 door, so it syncs to every machine on the branch like any file
(the E4-T12 capstone's verdict — both trees byte-identical, conflict file included —
depends on this); and (4) dispatches one `sync/conflict` event onto the branch stream,
payload `{path, conflictFile, winningOffset, loserSha256}` in canonical JSON, frozen
here — **tree-neutral** in the reducer (the fs-tree digest is byte-unchanged across it)
but visible at a citable offset in the event log, in the E3 history view, and in
`ef status --json`, whose `STATUS_JSON_VERSION` is bumped **1 → 2** (the loud,
deliberate event E4-T04 requires) to add `paths.conflicted`. Non-conflicting offline
edits in the same catch-up still uplink normally per E4-T10, untouched by this
machinery. End state, provable under the E4-T09 harness: overlapping-edit partition
runs converge to byte-identical trees on both machines equal to `ef replay <fresh dump>
--digest --reducer`, the conflict file's SHA-256 equals the pre-restart local content
hash exactly, the `sync/conflict` event appears at a citable offset in the dump, and a
total pre/post byte audit finds zero lost bytes.

## Context

This is the last non-capstone piece of the Epic 4 watcher (ROADMAP.md, "Epic 4 —
the-roots": "conflict surfacing (the stream is the arbiter; local losers are preserved
as conflict files)"). Every prior task stopped deliberately at this cliff: E4-T06
detects divergence and journals a typed `refused` record ("resolution is E4-T11's job,
silence is nobody's"); E4-T07 halts rather than clobber unsynced local dirt ("turning
this halt into conflict-file surfacing is E4-T11's"); E4-T10 guarantees the loser's
bytes survive inside the journaled `refused` record (or the content-addressed blob it
names) precisely so this task can recover them byte-exact. This task closes all of
those seams with one component and freezes the contract the E4-T12 capstone demos: its
"survive a partition with a surfaced conflict" leg — exactly one conflict file, named
per this task's offset contract, present in **both** trees, dossier-verified — is this
machinery under the E4-T09 harness.

Contracts frozen here (E4-T12 and the web app's later conflict rendering parse these;
changing them invalidates the goldens below):

- **Conflict file naming**: `<path>.conflict-<offset>`, a sibling in the same
  directory; `<offset>` is the winning stream event's opaque offset string **echoed
  verbatim** — E0-T03 freezes offsets as opaque strings clients may only compare and
  echo, and this name honors that: no numeric coercion, no padding removal, no
  reformatting. Filesystem-safety escaping, pinned: any byte outside `[A-Za-z0-9._-]`
  is percent-encoded `%XX` (uppercase hex); bytes inside pass through unchanged —
  deterministic and injective, so the name is a pure function of `(path, offset)`.
  Exported as `conflictFileName(path, offset)`; the same collision surfaced twice
  (crash + re-apply, or re-delivery on restart) targets the same name.
- **Temp-write staging, pinned**: every durable-flush staging file this machinery
  writes (conflict file, working-tree overwrite, ledger update) lives under
  `.ef/tmp/` and nowhere else — never as a sibling in the working tree, never under
  any other name. The pattern is frozen so "no partial temp artifacts" is a glob
  assertion, not a judgment call: after any clean exit or post-kill restart,
  `.ef/tmp/` is empty, and zero workspace files match `.ef/tmp/*`.
- **Loser-safety write ordering**: conflict file written and durably flushed **before**
  the working-tree path is overwritten or removed. At no instant do the loser's bytes
  exist in neither place; the reverse order is forbidden. Surfacing is idempotent:
  re-applying the same winning event with the conflict file already present and
  byte-identical is a no-op; a same-named file with **different** bytes is a hard error
  (exit nonzero, nothing touched) — clobbering it would drop bytes.
- **The conflict file is a normal file.** It uplinks through E4-T06 (fenced,
  journaled), downlinks to every other machine, is ledger-tracked, and counts in tree
  digests — so `replay(branch)` and both working trees agree byte-for-byte, conflict
  file included (E4-T12's `diff -r` verdict). Resolution is ordinary file work: delete
  it (accept the stream) or copy its bytes back over the path (recover local); either
  syncs like any edit.
- **`sync/conflict` event**: one per surfaced collision, dispatched through the same
  E1-T02/E4-T06 append door after the conflict-file uplink is accepted, journaled so a
  crash cannot double-dispatch — exactly one per `(path, winningOffset)`, ever, across
  restarts and re-deliveries. Payload frozen: canonical-JSON
  `{path, conflictFile, winningOffset, loserSha256}`, where `loserSha256` is the
  SHA-256 of the loser's bytes (binding the event to the conflict file's content event)
  and `winningOffset` is echoed verbatim. **Tree-neutral**: the fs reducer ignores it —
  `ef replay --digest --reducer` over a log prefix ending just before vs. just after a
  `sync/conflict` event yields byte-identical digests. It exists to make the condition
  citable: event log, E3 history view, web app.
- **Collision rule table** (each row a committed test):
  - stream content event vs local unsynced **modify** → stream bytes take the path,
    local bytes → conflict file;
  - stream content event vs local unsynced **add** at the same path (add/add) → same;
  - stream **delete** vs local unsynced modify → path removed, local bytes → conflict
    file (the conflict file remains as the only trace);
  - stream content event vs local unsynced **delete** → stream content materializes
    the path; no local byte payload exists to preserve, so **no** conflict file and no
    `sync/conflict` event — pinned and documented, not an accident;
  - stream **delete** vs local unsynced **delete** (both sides deleted) → both agree
    the path is gone and no local byte payload exists to preserve: **no** conflict
    file, no `sync/conflict` event, ledger advances to the winning offset and the path
    classifies clean — pinned like the equal-bytes row, not an accident;
  - stream **delete** vs local unsynced **add** → path removed, local bytes → conflict
    file (the conflict file remains as the only trace) — same treatment as
    delete-vs-modify: the loser has real bytes, so they are preserved and one
    `sync/conflict` event is dispatched;
  - stream content event **byte-identical** to the local unsynced dirt (both sides
    independently wrote the same bytes) → **no** conflict file, no event: the ledger
    advances to the winning offset and the path classifies clean — a conflict file
    equal to the winner is noise that trains users to ignore conflict files;
  - type collision (stream file where local has an unsynced directory, or vice versa)
    → every displaced local file preserved under its own `<path>.conflict-<offset>`
    per the rows above, one file and one event per loser;
  - **echo is not conflict**: dirt the engine's own journal accounts for (E4-T08
    suppression) never surfaces anything.
- **`STATUS_JSON_VERSION = 2`**: the E4-T04 schema plus `paths.conflicted` — a UTF-8
  byte-order-sorted array of `{path, conflictFile, offset}` derived deterministically
  from working-tree files matching the frozen name pattern; `clean` iff all **four**
  `paths` arrays are empty. Version bump performed per E4-T04's invalidation rule:
  **every** status golden in the repo regenerated in this task's diff, no consumer left
  accepting `"v":1`.

Non-goals: merge of any kind — no three-way text merge, no conflict markers inside
files (the stream is the arbiter, full stop); automatic re-base/retry of E4-T06
`refused` dispatches (the winner arriving via downlink/catch-up converts the refusal
into a surfaced conflict; the engine never re-sends the loser to the contested path);
web-app conflict *UI* beyond the event appearing in the existing E3 history view (a
dedicated conflict surface is a later epic); rename detection (a rename is delete +
create per E4-T04/T06; each side collides independently).

Browser layer: the `sync/conflict` event reaches the browser through the frozen E3
history/event-log view — the builder's claim must cite a Replay recording of that view
showing the event at its offset (AGENTS.md 3a; `Replay: N/A` is not available to this
task).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T11-conflict-surfacing/`.

- `packages/cli/src/sync/conflict.ts` — `conflictFileName(path, offset)` (pure),
  `surfaceConflict({workspaceRoot, path, winningOffset, loserBytes})` implementing the
  frozen ordering, idempotence, and hard-error contract, and the pure classifier
  `classifyCollision(remoteEvent, ledgerEntry, workingBytes, journalView)` → rule-table
  row (or `echo` / `no-conflict`), unit-testable without a filesystem or server.
- Integration into both arrival paths: E4-T10's reconciler consumes each journaled
  `refused` record when its winner lands (recovering the loser's bytes from the record
  or its content-addressed blob) and routes it through `surfaceConflict`; E4-T07's
  divergence halt is replaced by the same call in the live downlink. Both paths then
  uplink the conflict file and dispatch the journaled `sync/conflict` event.
- `sync/conflict` event type registered in the shared event envelope types with the
  frozen payload schema; the fs reducer provably ignores it (tree-neutrality test).
- `STATUS_JSON_VERSION = 2` in `packages/cli` with `paths.conflicted`; every committed
  status golden regenerated; package README schema section updated verbatim.
- Package README section "Conflict surfacing": the frozen name pattern and escaping
  rule, the write ordering, the full rule table, the event payload, and the resolution
  story (delete = accept stream, copy-back = recover local — both just sync).
- `packages/cli/test/conflict.test.ts` — `conflictFileName` (including hostile offsets
  needing escaping) and the pure classifier against every rule-table row, echo
  discrimination, idempotent re-surface, and the differing-bytes hard error.
- `packages/cli/test/conflict.integration.test.ts` — real server on an ephemeral port:
  (a) **catch-up** collision — watcher stopped, same path edited both sides plus
  disjoint non-conflicting local edits, restart reconciles (E4-T10), surfaces exactly
  one conflict, and uplinks the non-conflicting edits normally; (b) **live** collision
  — watcher running, foreign writer advances a locally-dirty path; (c) delete/edit both
  directions, add/add, and equal-bytes; each asserting conflict-file byte identity
  (`cmp`, not just digest) against pre-captured local bytes, ledger advance, exactly
  one `sync/conflict` event per collision in a fresh dump with `loserSha256` matching,
  tree-neutrality of that event, `ef status --json` (`"v":2`) reporting the exact
  `conflicted` triple, and conflict-file propagation to a second cloned workspace.
- E4-T09 harness scenarios promoted into the scripted set and `make verify-E4-sync`:
  **offline-remote-only**, **offline-local-only**, **true-conflict**, and **mixed**
  (conflicting + non-conflicting offline edits in one catch-up); each asserts both
  machines' `ef tree-digest` byte-equal to `ef replay --digest --reducer` of a fresh
  dump; true-conflict and mixed additionally assert the exact conflict-file name and
  bytes on both machines, exactly one `sync/conflict` event, and zero conflict files in
  the non-conflicting scenarios.
- **Byte audit**: a harness assertion that computes, per run, the SHA-256 set of every
  file version present on either machine at partition end, and proves each is
  accounted for at convergence — at its working path, in a conflict file, or as a
  superseded revision reconstructible from the dump (E1-T03). Zero lost bytes, total.
- Crash-safety test: fault injection / SIGKILL between conflict-file flush and
  working-tree overwrite, and between conflict-file uplink and `sync/conflict`
  dispatch — restart must find the loser on disk, re-apply idempotently, converge, and
  end with exactly one conflict file and exactly one `sync/conflict` event.
- Replay recording (tools/replay/) of the E3 history view on the true-conflict branch
  showing the `sync/conflict` event at its offset; URL + interrogation notes committed.
- `Makefile`: `verify-E4-T11` per the E0-T02 per-task contract — the test files, the
  harness scenarios, replay of the committed dump to its committed digest, and the
  sensitivity sabotage steps (below), each printing `EXPECTED-FAIL OK` only after
  observing red; joins `verify-all`; `tools/verify/self_check.sh` still passes.
- `evidence/` — `e4-t11-scenarios.txt` (harness transcript, all four scenarios, both
  machines' digests + replay digest per scenario), `e4-t11-branch-log.jsonl` (dump from
  the true-conflict run), `e4-t11-loser.bin` + `e4-t11-conflict-file.bin` (pre-restart
  local bytes captured before healing, and the resulting conflict file — byte-identical;
  SHA-256 pair in `e4-t11-digests.txt` alongside convergence digests),
  `e4-t11-conflict-event.json` (the `sync/conflict` event with its offset, extracted
  from the dump), `e4-t11-status.json` (the losing machine's `--json` v2 line),
  `e4-t11-byte-audit.txt` (the zero-lost-bytes accounting), `e4-t11-replay.md` (the
  Replay recording URL + what it shows), and `e4-t11-sensitivity.md` (sabotage
  transcript).

## Acceptance criteria

- [ ] `make verify-E4-T11` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (scrubbed env, fresh server data dir, ephemeral
      port), zero skips — evidence:
      `make verify-E4-T11 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Four-scenario convergence: each harness scenario ends with machine A's
      `ef tree-digest`, machine B's `ef tree-digest`, and `ef replay <fresh dump>
      --digest --reducer` all byte-identical (three independent instruments, never one
      value echoed), recorded per scenario in `evidence/e4-t11-scenarios.txt` and
      re-asserted by `verify-E4-sync`. Offline-remote-only and offline-local-only end
      with **zero** conflict files and **zero** `sync/conflict` events — a false
      positive fails the run.
- [ ] Loser preserved byte-exact: in the true-conflict scenario the conflict file's
      SHA-256 equals the pre-restart local content hash exactly, and
      `cmp evidence/e4-t11-loser.bin evidence/e4-t11-conflict-file.bin` exits 0 — pair
      in `evidence/e4-t11-digests.txt`; the committed integration test re-asserts byte
      identity (`cmp`, not digest) on every run, including for a binary payload with
      NUL bytes and an empty file.
- [ ] Deterministic name, frozen: the conflict file is exactly
      `<path>.conflict-<offset>` with the winning event's offset string as found in the
      committed dump, echoed verbatim through the pinned escaping rule — a committed
      test computes the expected name from the dump independently of
      `conflictFileName` (string concatenation + escaping only, never parsing or
      numerically interpreting the offset) and compares by string equality; the harness
      asserts the literal filename on **both** machines (it synced).
- [ ] Conflict event citable and honest: the fresh dump contains exactly one
      `sync/conflict` event per surfaced collision, at an offset recorded in
      `evidence/e4-t11-conflict-event.json`, payload matching the frozen schema with
      `loserSha256` equal to the conflict file's SHA-256 and `winningOffset` equal to
      the offset in the conflict file's name; a committed test proves tree-neutrality —
      `ef replay --digest --reducer` over the log truncated just before vs. just after
      that event is byte-identical.
- [ ] Visible in the web app: a Replay recording (URL in `evidence/e4-t11-replay.md`)
      shows the E3 history view rendering the `sync/conflict` event on the branch, and
      MCP interrogation confirms the DOM's replayed-offset marker at or past the
      event's offset.
- [ ] Non-conflicting edits unharmed: in the mixed scenario, every non-conflicting
      offline local edit lands on the stream as exactly one normal event (E4-T10
      journal/dump bijection re-asserted across the same run) — a lost or duplicated
      non-conflicting edit fails; zero lost bytes total per
      `evidence/e4-t11-byte-audit.txt`, re-computed by the committed harness assertion
      on every run.
- [ ] `ef status` reports it: on the losing machine the `--json` line has `"v":2`,
      `paths.conflicted` equal to the exact `{path, conflictFile, offset}` triple,
      `clean: false`, and the contested path absent from `added/modified/deleted`;
      after resolution-by-deletion syncs, the report returns to `clean: true` — both
      states committed as test assertions, the former captured in
      `evidence/e4-t11-status.json`.
- [ ] Version bump done loudly: `STATUS_JSON_VERSION === 2`; every status golden
      regenerated in this task's diff — negative: `git grep '"v":1' --
      '**/golden-status/**' '**/fixtures/**'` prints nothing (canonical JSON has no
      space after the colon); positive: `git grep -l '"v":2' -- '**/golden-status/**'`
      lists every committed status golden; no code branches on or accepts version 1 —
      two mechanical checks, no judgment: (a) `git grep '"v":1' -- 'packages/**'`
      prints nothing, and (b) a committed test feeds a `"v":1` status line to every
      status-JSON parse site and asserts each rejects `v !== 2` with a hard error;
      the E4-T04 suite re-runs green against the regenerated goldens.
- [ ] Rule table fully exercised: `conflict.test.ts` covers every row including
      local-delete-vs-stream-edit, delete-vs-delete, and equal-bytes (all three
      asserted as no-conflict-file/no-event with ledger advanced, not skipped),
      stream-delete-vs-local-add (local bytes to conflict file, path removed, one
      event), type collisions (one file + one event per displaced loser), echo
      discrimination, idempotent re-surface, and the differing-bytes hard error
      (nonzero exit, working tree untouched — asserted by before/after
      `ef tree-digest`).
- [ ] Crash-safe, loser never lost, event never doubled: the fault-injection tests
      kill at both seams; after restart the loser's bytes exist at the conflict-file
      name, the path holds stream bytes, digests converge, and the dump contains
      exactly one conflict-file content event and exactly one `sync/conflict` event —
      no duplicates; no partial temp artifacts, mechanically: after the post-kill
      restart the pinned staging directory `.ef/tmp/` contains zero entries, asserted
      by glob over the whole workspace **including** `.ef/` (tree digests exclude
      `.ef/`, so this assertion is the only instrument that sees it).
- [ ] Sensitivity: `verify-E4-T11`'s sabotage step runs the suite in a scratch worktree
      under each of: (a) conflict-file write disabled (loser dropped — byte audit must
      catch it), (b) write ordering inverted (tree first — fault injection must catch
      it), (c) `sync/conflict` dispatch disabled (event-count and Replay-cited
      visibility assertions must catch it), (d) `conflictFileName` offset mangled
      (dump-derived name check must catch it), (e) echo discrimination disabled
      (clean-scenario zero-conflict assertions must catch it), (f) `sync/conflict`
      made tree-mutating in the reducer (tree-neutrality digest pair must catch it) —
      each observed red before `EXPECTED-FAIL OK`; evidence:
      `make verify-E4-T11 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 6, transcript in
      `evidence/e4-t11-sensitivity.md`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `make verify-list` maps
      `verify-E4-T11` to this task; `verify-all` and `verify-E4-sync` green; the
      E4-T04, E4-T06, E4-T07, E4-T09, and E4-T10 suites re-run green (E4-T04's against
      regenerated goldens; E4-T07's divergence-halt test updated to expect surfacing is
      the only permitted modification, called out in the diff).

## Adversarial verification

The claim under attack: "whenever the stream and an unsynced local edit disagree, the
stream takes the path, the local bytes survive verbatim under a deterministic
offset-derived name that syncs everywhere, one citable `sync/conflict` event marks the
condition, non-conflicting edits flow normally — and nothing is ever surfaced that
wasn't a real conflict." Use your own directories, payloads, seeds, and partition
timing throughout; invent at least one angle this list lacks. Any single success
refutes.

1. **Your own partitions, differential (mandatory).** Ignore the builder's scenarios.
   Under the E4-T09 harness with your own seeds, run many randomized partition rounds:
   both machines editing overlapping and disjoint path sets while partitioned, then
   heal. Per round: three-way digest agreement (both trees vs fresh-dump replay) or
   refuted. The oracle is the frozen rule table, not "both sides touched it": derive
   the expected conflict-file set as the overlapping paths **minus** the pinned
   no-conflict rows (local unsynced delete losing to stream content; delete/delete;
   byte-identical equal-bytes writes) — you know per path what each side did, so this
   set is computable without the code under test. A missing conflict file for a path
   in that derived set refutes preservation; a conflict file or `sync/conflict` event
   on a path outside it — a path only one side touched, or one landing on a pinned
   no-conflict row — refutes the classifier (false positives are the silent drop's
   twin: they teach users to ignore conflict files); and per round the conflict-file
   count, the `sync/conflict` event count, and the derived set's size must all be
   equal — any pairwise mismatch refutes the binding.
2. **Byte forensics on the loser.** Before healing, snapshot the losing machine's
   contested files yourself (`cp` + `shasum`, outside the tooling). After surfacing,
   `cmp` your snapshot against the conflict file — any byte difference, including
   trailing-newline or encoding normalization, refutes "byte-exact." Hostile payloads:
   binary with NUL bytes, CRLF, invalid UTF-8, an empty file, a multi-MB file, and a
   payload byte-identical to the stream winner — the equal-bytes row pins **no**
   conflict file, no event, ledger advanced, path clean; a surfaced no-op conflict, a
   dirty path, or a stale ledger base refutes the pinned row.
3. **Total accounting, your ledger not theirs.** Re-derive the zero-lost-bytes audit
   independently: hash every file version on both machines at partition end, then hunt
   each hash at convergence — working path, conflict file, or a dump-reconstructible
   revision (E1-T03 patch application). One unaccounted hash refutes "never silently
   dropped." Then check the other direction: every conflict file at convergence maps to
   a real pre-heal loser — an orphan conflict file refutes precision.
4. **Name and event determinism, dump-derived.** Compute the expected conflict-file
   name yourself from your dump's winning-event offset string — echo it verbatim
   through the pinned escaping rule, never through `conflictFileName`, never by parsing
   or numerically coercing the offset (E0-T03 forbids it; a check that only passes
   after stripping padding is itself a finding). Mismatch refutes. Verify the
   `sync/conflict` payload against the same dump: `winningOffset` resolves to a real
   event on the contested path, `loserSha256` equals your snapshot's hash, `conflictFile`
   equals the on-disk name. Engineer two successive conflicts on the same path (leave
   the first conflict file in place): two distinct offset-named files must coexist,
   neither clobbered, two events. Restart the watcher so E4-T10 re-walks the winner: a
   duplicate, renamed, or clobbered conflict file — or a second `sync/conflict` event
   for the same `(path, winningOffset)` — refutes idempotence.
5. **Kill it at the cliff.** SIGKILL the watcher/catch-up repeatedly around both seams
   (before tree overwrite; between conflict-file uplink and event dispatch) — tight
   loop, random jitter, not the builder's injection points. After every kill, before
   restarting, audit the disk: if the contested path already holds stream bytes and no
   intact conflict file holds the loser, the ordering contract is refuted — the bytes
   existed nowhere. Restart, require convergence, exactly one conflict file, exactly
   one event.
6. **Echo, refusal, and self-conflict.** Run one machine under `ef watch` and hammer
   local edits: every downlinked echo of its own uplink must surface nothing (a machine
   that conflicts with itself refutes discrimination) — including the conflict file's
   own uplink echoing back (a conflict file spawning a conflict file, or `.conflict-`
   names nesting, refutes termination). Force an E4-T06 `refused` record and let the
   winner land: exactly one conflict file, and the loser's bytes never appear as a
   content event **on the contested path** in the dump (they appear exactly once, as
   the conflict file's own add — anything else refutes "the stream is the arbiter").
7. **Propagation and status honesty.** After a true conflict, `ef clone` a third fresh
   workspace: the conflict file must materialize there byte-exact (E4-T12 depends on
   this; absence refutes "it syncs like any file"). Validate v2 JSON on your own runs:
   `conflicted` sorted by UTF-8 byte order, the triple matching the dump, the contested
   path absent from the other three arrays, `clean: false`. Delete the conflict file on
   one machine → the deletion syncs and every machine returns to `clean: true`;
   copy-back → the recovered bytes land on the stream as a normal edit. If either
   documented resolution story doesn't actually sync, it's refuted. Hunt any surviving
   `"v":1` golden or consumer (grep the canonical no-space token).
8. **Watch it in the browser.** Open the E3 history view on your own conflict run (not
   the builder's recording): the `sync/conflict` event must render at its offset, live,
   without reload. Interrogate the builder's cited Replay recording via the Replay MCP:
   a recording that doesn't actually show the event, or shows a different branch/offset
   than the committed dump, refutes the evidence.
9. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed six:
   (a) surface the ledger's base bytes instead of the live working-tree bytes (preserves
   the *wrong* loser — byte forensics must catch it), (b) classify `added` dirt as
   echo, (c) dispatch the `sync/conflict` event before the conflict-file uplink is
   accepted. `make verify-E4-T11` must go red under each — any sabotage that stays
   green refutes the apparatus for that property.
10. **Cold clone + evidence provenance.** Run only via `tools/verify/cold_clone.sh`.
    Re-derive the true-conflict evidence from the committed harness scenario: fresh
    server, fresh clones, run it, check your conflict file's bytes and name shape and
    your dump's `sync/conflict` event against the committed
    `e4-t11-conflict-file.bin` / `e4-t11-conflict-event.json`. Evidence that cannot be
    regenerated from the committed scenario and code refutes its provenance. Hold the
    diff against the tests: every changed hunk in `conflict.ts`, both integration
    seams, the reducer registration, and the status v2 path executed somewhere, or
    classified needs-evidence/dead per AGENTS.md.

Refutation currency: a `cmp` diff between your pre-heal snapshot and the conflict file,
an unaccounted hash in your own byte audit, a post-kill disk state where the loser
exists nowhere, a conflict file or event on a non-conflicting path or machine, a
conflict-file/event count mismatch, a status triple contradicting the dump, a third
clone missing the conflict file, or a sabotage run that stays green. "The conflict file
name is ugly" is a note, not a finding.

## Verification log

### 2026-08-17 — builder progress — not submitted for critic verification

- Foundational, live-downlink, reconcile, status, event, and real-server two-machine
  conflict tests are implemented on commits through `84d89c8c`.
- Focused stream evidence passes: `pnpm exec vitest run --maxWorkers=1
  packages/cli/test/conflict.test.ts packages/cli/test/conflict.integration.test.ts
  packages/cli/test/downlink.test.ts packages/cli/test/watch-duplex.test.ts
  packages/cli/src/status.test.ts packages/streamfs/test/conflict-event.test.ts`.
- Replay Chromium history proof passes with `sync/conflict-known=true`,
  `humanized-summary-visible=true`, `console-errors=0`, and `page-errors=0`; the
  refreshed transcript is `E3-T09/evidence/e3-t09-browser.txt`. The durable Replay
  upload URL and interrogation notes are still outstanding, so this is not a claim of
  completion and the task remains `in-progress`.
- `make verify-E4-T11` was started from this checkout and reached the full Vitest phase,
  but the broad suite produced no completion within the bounded run and was interrupted;
  no full-gate pass is claimed.
- A subsequent full run completed the inherited suite twice: 64 files and 595 tests
  passed on each run. It then exposed a deterministic E4-T04 golden mismatch caused by
  the new `paths.conflicted` key order; `ca590453` regenerates all seven affected
  goldens, and the E4-T04 golden script now passes. The complete T11 target still needs
  one final rerun after this repair.

### 2026-08-17 — fresh critic — VERDICT: needs-evidence

- The fresh critic confirmed the core naming, preservation, event schema, status-v2,
  and one genuine two-machine offline collision path, but refuted the task as a whole
  because the required T11 evidence directory, four-scenario harness, byte audit,
  conflict-specific crash seams, cold-clone target, sabotage checks, and durable Replay
  URL are absent.
- The critic also identified three implementation gaps to rework: reconcile does not
  consume refused losers directly, downlink can surface during planning before the
  enclosing plan is committed, and arbitrary user-created `.conflict-*` names are
  classified as conflicts without provenance.
- T11 remains `in-progress`; no verification promotion is claimed. The next builder
  run must address these findings and produce a new claim before another critic pass.
