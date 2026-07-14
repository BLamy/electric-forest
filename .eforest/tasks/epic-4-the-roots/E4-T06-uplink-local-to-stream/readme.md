---
id: E4-T06
epic: 4
title: "Uplink sync engine: local file changes flow onto the branch stream as fenced, journaled dispatch events — visible live in the web app"
priority: 406
status: pending
depends_on: [E4-T02, E4-T04]
estimate: L
capstone: false
---

## Goal

`packages/cli` ships the **uplink sync engine** — `UplinkEngine` in
`packages/cli/src/sync/uplink.ts`, runnable standalone as `ef watch --up` from an
adopted working directory (an E4-T02 `.ef/` workspace on a branch checkout). A real
**chokidar** watcher observes the working tree (the `.ef/` directory itself always
excluded), and every local mutation — create, edit, rename, delete, mkdir, rmdir — is
**debounced and coalesced** per a pinned rule table, then dispatched onto the branch's
metadata stream (`fs:<org>/<repo>:<branch>:meta`, the frozen E4-T02/E1 prefix
contract) through authenticated
`POST /api/dispatch` (E2-T05 CLI token) as the frozen stream-fs actions: text
edits go up as E1-T03 **patches** computed against the base bytes recorded in the
`.ef/` ledger (full-write fallback per E1-T03 for binary/undiffable content), and every
content event declares its **`base`** from that ledger per E1-T04's stale-write
fencing contract — the engine never fetches head to fabricate a base. Every **accepted**
dispatch is recorded, before the ledger advances, as one canonical-JSON line in the
**append-only sync journal** `.ef/journal.jsonl` — `{seq, action, path, base, offset}`
where `offset` is the append offset the dispatch returned — and only then does the
ledger's per-path base advance to that offset (so E4-T04 `ef status` re-classifies the
path clean). A dispatch refused by fencing (409 `stale-base`) is journaled as a typed
`refused` record carrying the 409's `error.conflict` body and **no offset** (nothing was
appended); the path stays dirty in the ledger and the engine keeps running — resolution
is E4-T11's job, silence is nobody's. `ef watch --up --quiesce` exits deterministically:
0 when the debounce window has drained, every pending dispatch is acked and journaled,
and `ef status --json` reports the tree clean against the advanced ledger; exit code 3
when quiescent but with ≥ 1 journaled refusal (printed to stderr). At quiescence after
any scripted local edit sequence, the server's `ef replay <dump> --digest --reducer`
canonical tree digest **byte-equals** the local `ef tree-digest` (E4-T01) of the working
tree, and the branch is live in the browser: the E3-T06 tree route
(`apps/web`, `/:org/:repo/tree/:branch`) already open on the same branch updates in
place, no reload, as local files change on disk — its `[data-ef-stream]` region's
`data-ef-offset` (the frozen E3-T02 DOM contract) advancing to the dispatched offsets.

## Context

This is the "up" half of the Epic 4 watcher and the first time bytes flow from a plain
local filesystem onto a branch stream continuously rather than once (E4-T02's initial
upload). E4-T02 gave us the adopted directory and the `.ef/` workspace format (E4-T01);
E4-T04 gave us the classifier that says what is dirty against the ledger; E1-T03/E1-T04
gave us the patch action and the fence that makes patching safe; E1-T05 pinned the
chokidar dialect on the *read* side. This task closes the loop in the other direction
and is consumed directly by E4-T07 (downlink shares the journal and ledger discipline),
E4-T08 (`ef watch` composes both engines and needs the journal's offsets for echo
suppression — every event this engine appends must be attributable via its journal
line), E4-T10 (offline catch-up replays the journal against the log to find where it
left off), and the E4-T12 capstone (two uplinks on one branch are exactly the fencing
race this task's refusal path handles).

Contracts frozen here (E4-T07/T08/T10/T11 parse these; renaming invalidates them):

- **The journal format**: `.ef/journal.jsonl`, append-only, one canonical-JSON line per
  dispatch outcome. Accepted: `{seq, kind: "accepted", action, path, base, offset}`
  (`seq` a strictly monotonic local integer, `offset` the returned append offset).
  Refused: `{seq, kind: "refused", action, path, base, conflict}` with `conflict` the
  literal E1-T04 `{path, expectedBase, actualBase}` object, and no `offset` key.
- **Write ordering**: journal line flushed to disk **before** the ledger's per-path base
  advances. A crash between the two leaves a journaled-but-not-ledgered entry, which
  E4-T10 reconciles; the reverse order would lose provenance and is forbidden.
- **Coalescing rules** (pinned in the package README, each with a committed test):
  N rapid writes to one path within the debounce window → one dispatch whose patch spans
  ledger base to final bytes; create-then-delete of a path that has no stream history →
  no dispatch at all; write-then-delete of an existing path → one delete; a local rename
  is dispatched as **delete + create (full write)** — no rename inference from
  chokidar's unlink/add pair, documented as such (a stream-level `rename` op from a
  local move is a possible later optimization, not silently half-done here).
- **Flush order**: within one coalesced flush, dispatches are issued in E1-T02's frozen
  segment-wise path order (dirs before their contents where both are pending), so a
  scripted, phase-gated edit sequence produces a deterministic event **shape**.
- **Exclusions**: `.ef/**` and the pinned temp-file patterns (editor atomic-save
  artifacts) never produce a dispatch; the package README lists the exact patterns.

Non-goals: the downlink direction (E4-T07 — nothing in this task tails the stream into
the working tree), echo suppression (E4-T08 — with no downlink there is no echo yet),
automatic rebase/retry after a `stale-base` refusal and conflict-file surfacing
(E4-T11 — this engine detects, journals, and reports; it never resolves), offline
catch-up on startup (E4-T10 — this engine assumes it starts from a clean E4-T04
classification and its startup behavior on a dirty tree is: classify via E4-T04 and
uplink the dirty set as its first flush, pinned and tested, but partition semantics
belong to T10), and any web-app code changes (the E3-T06 tree route is consumed as-is
per its frozen E3-T02 DOM contract; the browser evidence proves the *stream* went live,
not new UI. A dedicated file viewer is planned for epic 3 but has no task folder yet —
this task deliberately does not bind to it; if it lands before verification, the
recording may additionally show it, but the acceptance check binds only to the E3-T06
route and E3-T02 attributes).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T06-uplink-local-to-stream/`.

- `packages/cli/src/sync/uplink.ts` — `UplinkEngine` (constructor takes the workspace
  root, resolved branch stream id, and auth token source; exposes `start()`, `flush()`,
  `quiesce()`, `close()`, and an event surface reporting each journal record as it is
  written) built on real chokidar over the working tree, the debouncer/coalescer as a
  **pure, separately exported function** `coalesce(pendingFsEvents, ledgerView)` →
  ordered dispatch plan, unit-testable without a filesystem or server.
- `packages/cli/src/sync/journal.ts` — the journal writer/reader: append-only
  canonical-JSON lines, per-line flush, monotonic `seq` enforcement, and a
  `readJournal()` used by tests (and later E4-T07/T10).
- `ef watch --up [--quiesce] [--debounce <ms>]` wired into the `ef` binary: runs the
  engine until SIGINT, or with `--quiesce` exits 0/3 per the Goal's contract, printing
  each journal record to stdout as it lands (one canonical-JSON line, mirroring the
  journal) so scripts can gate on it.
- Package README section "Uplink sync" documenting the frozen journal format, write
  ordering, coalescing rule table, flush order, exclusion patterns, and the
  dirty-at-startup rule.
- `packages/cli/test/uplink.test.ts` — integration against a real server on an
  ephemeral port (spawned by the test): init a workspace (E4-T02 path), run the engine,
  drive scripted phase-gated local edits with plain `fs` calls (create nested dirs,
  write, ≥ 3 rapid successive writes to one file that must coalesce to one patch, a
  rename, a delete, a unicode path, a create-then-delete flap that must produce
  nothing), quiesce, then assert: server digest parity, journal completeness (bijection
  between accepted journal entries and the dump's events at the cited offsets), and
  `ef status --json` clean. Also home to the `--debounce` differential and the
  stdout-mirrors-journal assertion (acceptance criteria below).
- `packages/cli/test/uplink.fencing.test.ts` — the stale path: while the engine runs, a
  **foreign writer** (test actor using the E0-T08 client directly) advances a contested
  path on the stream; a subsequent local edit to that path dispatches with the now-stale
  ledger base and must be refused: exactly one `refused` journal record with the literal
  409 conflict body, head offset + event count + `ef replay --digest` tree digest
  byte-identical immediately before and after the refusal, engine still live (a
  different path edited afterwards still uplinks), `--quiesce` exit code 3.
- `packages/cli/test/coalesce.test.ts` — the pure coalescer against the pinned rule
  table, including flush ordering and exclusion patterns; plus a seeded randomized
  sequence (seed committed) whose coalesced plan, applied to a scratch state, equals the
  final local tree.
- Browser evidence run: with the built E3 web app serving the E3-T06 tree route
  (`/:org/:repo/tree/:branch`) open on the branch, `ef watch --up` running, and a script
  editing files on disk — recorded under Replay Chromium via
  `tools/replay/record-run.sh -o e4-t06-final`: the tree updates live (no reload, no
  document navigation — rows appear/disappear as files are created/deleted), the
  region's `data-ef-offset` (E3-T02 contract) advances to the dispatch offsets that the
  journal cites, zero console errors. URL cited in the Verification log.
- `Makefile`: `verify-E4-T06` per the E0-T02 per-task contract — the three test files,
  the golden-shape comparison (below), replay of the committed branch log to its
  committed digest, and a sensitivity step that must observe red before printing
  `EXPECTED-FAIL OK` (see acceptance criteria); joins `verify-all`;
  `tools/verify/self_check.sh` still passes.
- `evidence/` — `e4-t06-edit-script.ts` (the scripted, phase-gated local edit sequence),
  `e4-t06-branch-log.jsonl` (the dumped branch metadata log from the recorded final
  run), `e4-t06-golden-shape.jsonl` (the committed golden: each event of the dump
  projected to `{type, path}` — no offsets, bases, timestamps, or content bytes — one
  canonical-JSON line each), `e4-t06-journal.jsonl` (the journal from the same run),
  `e4-t06-digests.txt` (local `ef tree-digest` and server `ef replay --digest` at
  quiescence, byte-equal, plus SHA-256 of the dump), `e4-t06-stale-refusal.txt` (the
  full fencing transcript: foreign write, refused dispatch, before/after head offset +
  event count + tree digest, the journal's `refused` line), and
  `e4-t06-sensitivity.md` (the sabotage transcript).

## Acceptance criteria

- [ ] `make verify-E4-T06` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (scrubbed env, fresh server data dir, ephemeral
      port), with zero skips — evidence:
      `make verify-E4-T06 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Digest convergence: after the committed edit script runs against a live engine
      and `ef watch --up --quiesce` exits 0, the local `ef tree-digest` of the working
      tree and `ef replay <fresh dump> --digest --reducer` of the branch stream are
      byte-identical — the pair is recorded in `evidence/e4-t06-digests.txt` and
      re-asserted by the committed test. The two digests must come from the two
      independent instruments (E4-T01's local walker vs the stream replay), never one
      value printed twice.
- [ ] Golden shape: projecting every event of `evidence/e4-t06-branch-log.jsonl` to
      `{type, path}` reproduces `evidence/e4-t06-golden-shape.jsonl` byte-for-byte
      (`diff` exits 0), and `verify-E4-T06` re-runs the projection on every invocation.
      The shape proves coalescing: it contains exactly **one** content event for the
      triple-written file, a delete + create pair (not a rename op) for the renamed
      path, and **zero** events for the create-then-delete flap and for any `.ef/` or
      temp path.
- [ ] Journal completeness, both directions: a committed test builds the bijection —
      every `accepted` journal record's `offset` resolves in an independently fetched
      dump to an event whose action type and path match the record, and every event in
      the dump appended during the session is cited by exactly one journal record.
      `seq` is strictly monotonic with no gaps. A journal offset that resolves to
      nothing, to the wrong path, or an uncited appended event fails the test.
- [ ] Journal prefix immutability: a committed test in `uplink.test.ts`, run by
      `verify-E4-T06`, captures the journal file's exact byte prefix mid-run (after N
      records have landed) and asserts at quiescence that the first N records' bytes
      are unchanged — append-only means the prefix is immutable. A mid-run rewrite of
      an earlier line that preserves `seq` monotonicity and offset validity (which the
      bijection test cannot catch) fails this test.
- [ ] Journal-before-ledger ordering: a committed fault-injection test hooks the
      engine's **real dispatch path at the ledger-advance call site** (not a bespoke
      test-only path that presupposes the order) — the hook asserts the corresponding
      journal line is already durable on disk (flushed, parseable, citing the dispatch)
      at the moment the ledger write is about to occur, then kills/aborts before the
      advance; after the crash the journal contains the entry and the ledger does not.
      An injection point defined as "between journal flush and ledger advance" is
      vacuous — the hook must sit on the production ledger-advance code so a reversed
      write order is caught deterministically, and sabotage (e) below proves the
      apparatus is sensitive to exactly that reversal. Restart-side reconciliation is
      out of scope (E4-T10) but the ordering itself is asserted here.
- [ ] Fencing honored, log-neutral: the fencing test's stale dispatch returns exactly
      HTTP 409 with `error.class: 'validator-rejected'`, `error.reason: 'stale-base'`;
      head offset, event count, and `ef replay --digest` tree digest captured
      immediately before and after are byte-identical; the journal gains exactly one
      `refused` record whose `conflict` object equals the response body's; the engine
      subsequently uplinks an edit to an unrelated path successfully; `--quiesce` exits
      3 — transcript committed as `evidence/e4-t06-stale-refusal.txt`.
- [ ] Base honesty: every content event in the committed dump declares a `base` equal
      to the offset its journal predecessor for that path established (or `BASE_NONE`
      for the path's first content event) — a committed test walks the dump per-path
      and asserts the base chain; the engine's source contains no head-fetch on the
      dispatch path (the base must come from the ledger — asserted by the sensitivity
      sabotage below, not by grep alone).
- [ ] Coalescing rule table fully exercised: `coalesce.test.ts` covers every row of the
      pinned table plus the seeded randomized sequence, and the exclusion patterns
      (`.ef/**`, temp artifacts) produce no plan entries.
- [ ] `--debounce` is load-bearing, not decorative: a committed test runs the same
      rapid-burst edit sequence (fixed inter-write gap) under two `--debounce` values —
      one smaller than the inter-write gap (e.g. a gap of 200ms with `--debounce 50`)
      and one larger than the whole burst — and asserts, per the pinned coalescing
      rules, that the resulting dump/journal event counts **differ**: the small window
      yields one dispatch per write, the large window coalesces the burst to exactly
      one. A build that parses the flag but ignores it fails this test.
- [ ] Event surface and stdout mirror are exact: during the committed integration run,
      the captured `ef watch --up` stdout, filtered to its journal lines, byte-equals
      `.ef/journal.jsonl` (`diff` exits 0 — same lines, same order, same canonical
      JSON); and a committed unit test subscribes to the `UplinkEngine` event surface
      and asserts exactly one event per journal record (accepted and refused alike),
      each event's payload canonical-JSON-identical to the corresponding journal line.
      Zero events, duplicate events, or a stdout line diverging from the journal by
      even one byte fails.
- [ ] Live in the browser: the cited Replay recording shows the E3-T06 tree route
      (`/:org/:repo/tree/:branch`), already open, updating within the session as
      on-disk files are edited — no reload, no document navigation, zero console
      errors — and the `data-ef-offset` attribute the route's `[data-ef-stream]`
      region exposes (frozen E3-T02 DOM contract) advances to offsets that appear as
      `accepted` records in `evidence/e4-t06-journal.jsonl`. URL cited in the
      Verification log.
- [ ] Sensitivity: `verify-E4-T06`'s sabotage step runs the suite in a scratch worktree
      under each of: (a) journal writes disabled, (b) base taken from a live head fetch
      instead of the ledger, (c) coalescer dropping the final write of a rapid burst,
      (d) `.ef/` exclusion removed, (e) journal/ledger write order reversed (ledger
      advanced before the journal line flushes) — each must go red (the fencing test
      must catch (b): an always-current base never yields the required 409; the
      fault-injection ordering test must catch (e)), printing
      `EXPECTED-FAIL OK` only after observing the failure — evidence:
      `make verify-E4-T06 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 5, transcript in
      `evidence/e4-t06-sensitivity.md`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `make verify-list` maps
      `verify-E4-T06` to this task; `verify-all` still green; E4-T02/E4-T04 and
      E1-T03/E1-T04 suites re-run unmodified and green.

## Adversarial verification

The claim under attack: "everything that changes on local disk lands on the stream
exactly once, correctly based, fully journaled — and nothing else lands at all." Use
your own directories, edit sequences, seeds, and timing throughout; invent at least one
angle this list lacks. Any single success refutes.

1. **Your own edit storm, differential (mandatory).** Ignore the builder's script.
   Generate a seeded random edit sequence (record the seed): hundreds of writes across
   dozens of paths, interleaved creates/deletes/renames, rapid same-file bursts faster
   than the debounce window, editor-style atomic saves (write temp, rename over),
   unicode and ordering-adversarial names (`a/b` vs `a!`), a file recreated at a
   deleted path. Quiesce, then compare three ways: `ef tree-digest` vs
   `ef replay --digest` on your own fresh dump (byte-equal or refuted); **materialize**
   the stream state into a scratch dir and byte-diff every file against the working
   tree (digest agreement with byte divergence would refute the digest apparatus
   itself); and count content events per path in the dump against the coalescing rules
   — a doubled event, a dropped final write, or a missing delete refutes.
2. **Journal audit, hostile.** Take the journal and the dump from your own run and
   attack the bijection from both sides: an appended event no journal line cites
   refutes provenance (E4-T08's echo suppression dies here); a journal `offset` that
   resolves to a different path/action, a non-monotonic or gapped `seq`, or a rewritten
   earlier line (capture the journal file's byte prefix mid-run and re-compare at the
   end — append-only means the prefix is immutable) refutes the journal contract.
   Also kill the engine (SIGKILL) mid-run several times: any journal line citing an
   offset the server never assigned, or a torn/non-canonical JSON line, refutes.
3. **Fence bypass hunt.** Race the engine with your own foreign writer on contested
   paths, repeatedly and with adversarial timing (land the foreign write inside the
   debounce window, just before flush). Then walk the dump per path and verify the
   E1-T04 base chain: every content event's `base` must be the offset of that path's
   previous content event. Any event whose base is not the immediately-preceding
   revision — especially one whose base equals the head the engine could have fetched —
   refutes base honesty and reveals silent clobbering. Byte-compare full dumps before
   and after each refusal (`cmp`, not digest): any appended record around a 409 refutes
   log neutrality.
4. **Leak hunt.** Grep your own dump for `.ef/`, journal, ledger, temp-save, and
   swap-file paths; run the engine while touching files inside `.ef/` directly. Any
   dispatch produced by workspace-internal or excluded paths refutes the exclusion
   contract. Then the inverse: create a file the exclusion patterns might overmatch
   (e.g. a real project file whose name resembles a temp pattern) — a silently
   never-uploaded real file refutes completeness; the pinned pattern list must be exact
   both ways.
5. **Patch honesty.** Capture a dispatched patch event from your dump, apply it
   yourself with the E1-T03 apply function to the base revision's bytes (materialized
   independently), and byte-compare with the local file at that journal point. A patch
   that only works because the server was forgiving, or a full write where the README's
   rules promised a patch (and vice versa) without the documented fallback reason,
   refutes.
6. **Quiescence honesty.** `--quiesce` exiting 0 while `ef status --json` still reports
   dirt, while a dispatch is un-acked, or while the last debounce window has pending
   events refutes the exit contract — probe it by timing edits to land exactly as
   quiescence is being evaluated. Exit 3 semantics: force a refusal and confirm the
   code and the stderr refusal report; a 0 exit hiding a journaled refusal refutes.
7. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed four:
   (a) make the journal record offsets off by one, (b) make the coalescer emit the
   delete+create rename pair in the wrong order, (c) journal `accepted` for a dispatch
   that was refused. `make verify-E4-T06` must go red under each — any sabotage that
   stays green refutes the apparatus for that property.
8. **Replay interrogation + coverage.** Open the cited recording via the Replay MCP:
   confirm the tree region's `data-ef-offset` advances during the session to offsets present in
   the committed journal, confirm zero console errors and zero document navigations
   across the edit phase, and pull the network activity to confirm the updates arrived
   over the live tail, not a reload/refetch loop. Then hold the diff against the tests
   and recording: every changed hunk in `uplink.ts`/`journal.ts`/`coalesce` executed
   somewhere, or classified needs-evidence/dead per AGENTS.md.
9. **Cold clone + golden provenance.** Run only via `tools/verify/cold_clone.sh`.
   Re-derive the golden shape yourself: run `evidence/e4-t06-edit-script.ts` from
   scratch against a fresh server, project your dump, and diff against the committed
   `e4-t06-golden-shape.jsonl`. A golden that cannot be re-derived from the committed
   script and the code refutes its provenance; a shape that only matches with the
   builder's timing (i.e. the phase gating is fake) refutes determinism.

Refutation currency: a dump + offset where an event violates its base chain or lacks a
journal citation, a byte diff between materialized stream state and the working tree, a
journal file whose earlier bytes changed, an exit-0 quiescence over a dirty tree, or a
Replay point link showing a reload where "live" was claimed. "The debounce felt slow"
is a note, not a finding.

## Verification log
