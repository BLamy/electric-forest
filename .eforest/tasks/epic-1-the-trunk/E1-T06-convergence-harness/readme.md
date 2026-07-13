---
id: E1-T06
epic: 1
title: "Convergence harness: ef materialize plus a two-client exact-diff verify target"
priority: 106
status: verified
depends_on: [E1-T04, E1-T05]
estimate: M
capstone: false
---

## Goal

The measuring apparatus every later merge and sync claim is judged with exists and is
standing. `packages/cli`'s `ef` binary ships
`ef materialize <dump.jsonl> --out <dir> [--at <offset>] [--reducer <module>]`: it
replays a dumped stream-fs event log through the `packages/stream-fs` reducer (E1-T01)
— truncated at `--at <offset>` inclusive when given, full log otherwise — and writes the
reduced tree into `--out` as a real directory tree, deterministically (sorted directory
traversal, exact content bytes, no timestamp/locale/umask/cwd dependence), printing the
E1-T01 canonical tree digest as exactly one lowercase-hex SHA-256 line on stdout, exit 0.
Alongside it, `tools/verify/convergence.sh` — wired as the standing Makefile target
`verify-E1-convergence` — boots a fresh file-backed stream server on an ephemeral port,
drives a scripted stream-fs scenario through `POST /streams/:id/dispatch`, and holds
**two independent client processes** against the one stream: client L **live-tails** the
metadata stream while the writer runs (the E1-T05 tailing path, including one mid-run
kill and resume from its persisted checkpoint), client C **cold-replays** the same
stream from offset `-1` after the writer finishes. Each client writes its
canonically-encoded reduced state (E0 canonical JSON) and materializes its tree into its
own scratch dir; the harness then exact-diffs both: canonical state files byte-compared,
trees `diff -r`'d, and tree digests three-way equal (L == C == `ef materialize` of the
server's own dump). Empty diffs and equal digests ⇒ exit 0; any divergence ⇒ exit
nonzero, the first divergent path printed by name, and the `ef bisect` (E0-T12) result
line pinning the first divergent offset between the two clients' event dumps.
`make verify-E1-convergence` and `make verify-E1-T06` pass from a cold clone with no
warm state.

## Context

AGENTS.md's critic charter is explicit: "claim about sync convergence → drive two
independent clients yourself, diff their reduced state canonically (exact), never
eyeball two UIs." Until now each E1 task did that ad hoc inside its own tests. This task
freezes the check into a reusable instrument, because everything downstream cites it:
E1-T09/T10's merge claims ("`replay(target)` equals the merged tree"), the E1-T11
capstone's digest-verify step, Epic 3's live-viewer parity, and Epic 4's
two-machines-one-branch capstone all reduce to "run this harness (or its parameterized
guts) and read the diff." The cold-vs-live pairing is deliberate: it is the strongest
cheap independence we can buy — two different code paths (E1-T05 live tail with a
kill/resume vs. a one-shot cold read) that must agree byte-for-byte, so a bug in either
path, or any live/cold semantic drift, turns the instrument red rather than hiding
inside a single client run twice. `ef materialize` is the other half: tree-equality
claims become `diff -r` on real directories plus digest comparison, and `--at <offset>`
makes "the tree as of offset k" a first-class artifact — E1-T08's fork-point trees,
E1-T09/T10's merge-base trees, and E7's time-travel scrubbing all read from this lens.
Epic 4's `ef checkout` will reuse the tree writer.

Contracts frozen here:

- **`ef materialize` output contract**: success prints exactly one lowercase-hex
  SHA-256 line (the E1-T01 canonical tree digest of the materialized tree) on stdout
  and nothing else on stdout; the digest for a full-log run byte-equals
  `ef replay <dump> --digest` with the stream-fs reducer — one replay core, two
  mouths, never a second implementation of truth. Malformed/truncated/
  envelope-violating dumps are rejected through the **same validation code path as
  `ef replay`** (E0-T04 — no second parser): exit nonzero, stdout exactly 0 bytes,
  diagnostic on stderr. `--at <offset>` must name an offset present in the dump
  (materializing the prefix up to and including it); an absent offset is refused
  nonzero. `--out` must name a nonexistent or empty directory; anything else is
  refused nonzero before any write. An event whose path would escape the out dir
  (absolute, `..` segment, symlink traversal) is refused nonzero with nothing written
  outside `--out` — regardless of exit code, no byte ever lands outside `--out`.
- **Harness verdict contract**: exit 0 **only** when the canonical reduced-state files
  are byte-identical to each other and each byte-identical to the committed
  `evidence/golden-state.json`, the two materialized trees are byte-identical
  (`diff -r` empty),
  and the three tree digests (client L, client C, `ef materialize` of the server dump)
  are equal. On any mismatch: exit nonzero, output names the first divergent path
  (state key or tree path), and includes the `ef bisect` result line for the two
  clients' event dumps. That line is the citation currency later Verification log
  entries carry.
- **The golden baseline is frozen committed data**: the scripted dispatch sequence —
  **including the E1-T04 refused stale write** — is committed as the scenario script
  embedded in `tools/verify/convergence.sh`; `evidence/golden-scenario.jsonl` is the
  server dump that results from running that script, and per E1-T04's frozen contract
  ("stale writes refused with the log untouched") it is **refusal-free by
  construction** — the refused attempt lives only in the script, never in the dump.
  `evidence/golden-scenario.jsonl`, `evidence/golden-tree/` (its materialized tree),
  `evidence/golden-tree.digest`, and `evidence/golden-state.json` (its canonical
  reduced state) are produced once and committed; no check that consumes them may
  regenerate them at check time.

The sabotage capability exists **only** as explicit harness flags used by the committed
red-path tests, never by the Makefile recipe: `--suppress-live <k>` drops the record at
1-based index k (matching E0-T12's bisect index) from client L's feed via a tee between
tail and reduce; `--corrupt-cold-byte <n>` flips one byte at offset n of client C's
canonical reduced-state file after reduction, before comparison. The recipe invokes the
harness with neither flag; E0-T02's recipe contract applies (real run, loud skip, or
red) and `tools/verify/self_check.sh` (`_v-meta`) polices the recipe text.

Builds on: E1-T05 (the live-tailing client and its checkpoint/resume contract — client
L is that machinery under test again, adversarially), E1-T04 (the scenario includes a
fenced stale write so "refused events leave no trace" is re-proven through the
instrument), E1-T01..T03 (envelope, directory ops, patches — the scenario exercises all
event types), E0-T04 (shared dump validation), E0-T12 (`ef bisect`), E0-T02 (verify
spine). Unblocks: E1-T09, E1-T11, and every future convergence claim.

Non-goals: no snapshots/branches/merges (E1-T07+), no server changes, no syncing a real
OS working directory (Epic 4's watcher daemon — here a "client" is a stream-reading
reducer process), no browser surface.

## Deliverables

- `packages/cli`: `ef materialize <dump.jsonl> --out <dir> [--at <offset>]
  [--reducer <module>]` per the frozen contract — shares E0-T04's dump-validation and
  reducer-loading code paths with `ef replay`, defaults to the `packages/stream-fs`
  reducer, writes files/dirs in sorted deterministic order with exact content bytes,
  prints the canonical tree digest. Covered by all standard gates.
- `tools/verify/convergence.sh`: creates its own scratch data dir and ephemeral port;
  boots the file-backed stream server; starts client L tailing live from offset `-1`
  (E1-T05 path), then the scripted writer dispatches the golden scenario (file
  creates, full writes, ≥2 patch appends, nested mkdir, file and directory rename,
  delete/tombstone, and one E1-T04 stale write that is refused — its content carrying
  a unique sentinel string, a fixed UUID-like literal appearing nowhere else in the
  scenario) through `/dispatch`;
  hard-kills client L once mid-run and resumes it from its persisted checkpoint,
  emitting exactly one `KILL client-L pid=<p> at-offset=<k>` line and exactly one
  `RESUME client-L from-checkpoint offset=<k>` line (0 <= k < head) in the transcript;
  after
  the writer finishes and L reaches head, spawns client C to cold-replay from `-1`.
  Both client command lines are echoed with frozen role prefixes — exactly one
  `CLIENT-L live-tail: <cmd>` line and exactly one `CLIENT-C cold-replay: <cmd>` line
  in the transcript, `<cmd>` being the actual command line executed for that client.
  Each client dumps its received event log,
  writes its canonical reduced state, and materializes its tree via `ef materialize`
  into its own scratch dir. Comparison step: byte-compare the two canonical state
  files against each other **and each against the committed
  `evidence/golden-state.json`**, `diff -r` the two trees, three-way digest check
  against `ef materialize` of
  the server dump; on mismatch, print the first divergent path and the `ef bisect`
  line over the two client dumps, exit nonzero. Sabotage flags `--suppress-live <k>`
  and `--corrupt-cold-byte <n>` as specified in Context.
- Makefile: `verify-E1-convergence` (the harness, no sabotage flags) and
  `verify-E1-T06` (standard `_v-fmt _v-lint _v-typecheck _v-test _v-build` plus
  `verify-E1-convergence` plus the materialize-golden check); both in `verify-all` and
  `make verify-list`, passing `tools/verify/self_check.sh`.
- Committed golden baseline in this task's `evidence/`: `golden-scenario.jsonl`,
  `golden-tree/`, `golden-tree.digest`, plus `golden-state.json` (the canonical
  reduced state) — produced once, committed, never regenerated by consuming checks.
- Committed tests (in `packages/cli` and/or a harness test suite), green under
  `pnpm test`:
  - Materialize determinism: two fresh-process `ef materialize` runs of
    `golden-scenario.jsonl` into two scratch dirs are byte-identical to each other and
    to `evidence/golden-tree/` (`diff -r` empty); printed digests equal
    `golden-tree.digest`.
  - Materialize agrees with replay: the printed digest equals
    `ef replay golden-scenario.jsonl --digest` with the stream-fs reducer.
  - `--at <offset>`: for ≥3 chosen offsets of the golden scenario (including the first
    event and head), the materialized prefix tree's digest equals the digest
    `ef replay` reports for the same truncated prefix; `--at` with an offset not in
    the dump exits nonzero with stdout 0 bytes.
  - Rejection: every E0-T04 `evidence/fuzz/` corpus file fed to `ef materialize` exits
    nonzero with stdout 0 bytes and leaves `--out` absent or empty; non-empty `--out`
    refused; path-escape events (absolute path, `..` segment) refused with no write
    outside the out dir.
  - Red-path sensitivity, suppression: harness with `--suppress-live <k>` for k = 1, a
    mid-log index, and the final index exits nonzero each time, names a divergent
    path, and emits an `ef bisect` line pinning exactly index k.
  - Red-path sensitivity, corruption: harness with `--corrupt-cold-byte <n>` exits
    nonzero and names the divergent state key/path — a one-byte state corruption the
    comparison cannot see refutes the instrument.
  - `--reducer` honesty: `ef materialize golden-scenario.jsonl --reducer <explicit
    stream-fs module path>` produces a tree and digest byte-identical to the default
    (flagless) run; `--reducer <nonexistent module>` exits nonzero with stdout exactly
    0 bytes and `--out` absent or empty — the same reducer-loading error path as
    `ef replay --reducer` (E0-T04).
  - Green path: harness with no flags exits 0 on the golden scenario; both clients'
    digests and the server-dump materialize digest equal `golden-tree.digest`, and
    both clients' canonical reduced-state files byte-equal the committed
    `evidence/golden-state.json`.

## Acceptance criteria

- [ ] From a cold clone via `tools/verify/cold_clone.sh` (scrubbed env:
      `NODE_OPTIONS`, `NODE_ENV`, `npm_config_*` unset), `make verify-E1-T06` exits 0
      and `make verify-E1-convergence` exits 0, and its transcript contains exactly
      one line matching the frozen prefix `CLIENT-L live-tail: <cmd>` and exactly one
      line matching `CLIENT-C cold-replay: <cmd>`, with the two `<cmd>` command lines
      not string-equal — both role and distinctness are a grep, no interpretation of
      flags required. Evidence: the critic reruns
      both from a cold clone — stream layer.
- [ ] Two-path honesty: the harness transcript contains exactly one
      `KILL client-L pid=<p> at-offset=<k>` line and exactly one
      `RESUME client-L from-checkpoint offset=<k>` line with `0 <= k < head`, the KILL
      line appearing after the writer-start line and the RESUME line before the
      comparison step — and the run still converges; a committed assertion checks the
      presence and ordering of both markers. Adversarial angle 2's sabotage (either
      client's reduction made to diverge) turns the target red — angle 2 is the
      binding definition of "two independent clients". Evidence: harness output + the
      critic's sabotage run.
- [ ] `ef materialize evidence/golden-scenario.jsonl --out <fresh-dir>` writes a tree
      such that `diff -r <fresh-dir> evidence/golden-tree/` is empty, prints exactly
      one stdout line equal to the contents of `evidence/golden-tree.digest`, and
      exits 0; two fresh-process runs into two dirs are byte-identical. Evidence:
      committed test.
- [ ] Materialize and replay agree: the digest printed by `ef materialize` on
      `golden-scenario.jsonl` byte-equals the digest printed by
      `ef replay evidence/golden-scenario.jsonl --digest` with the stream-fs reducer;
      the same equality holds at every `--at` prefix offset the test exercises (first
      event, ≥1 mid-log offset, head). Evidence: committed test comparing the process
      outputs.
- [ ] Hostile input handling: every E0-T04 fuzz-corpus file fed to `ef materialize`
      exits nonzero with stdout exactly 0 bytes and `--out` absent or empty; a
      non-empty `--out`, an absent `--at` offset, and a dump containing a
      path-escaping event are each refused nonzero with no filesystem write outside
      the out dir. Evidence: committed test iterating the corpus and edge cases.
- [ ] `--reducer` is real: `ef materialize evidence/golden-scenario.jsonl --reducer
      <explicit stream-fs module path>` produces a tree and printed digest
      byte-identical to the default (flagless) run, and
      `--reducer <nonexistent module>` exits nonzero with stdout exactly 0 bytes and
      `--out` absent or empty — the same reducer-loading error path as
      `ef replay --reducer` (E0-T04). Evidence: committed test.
- [ ] Suppression sensitivity: committed tests invoke the harness with
      `--suppress-live <k>` for k = 1, a mid-log index, and the final index; each run
      exits nonzero, names a divergent path, and its output contains an `ef bisect`
      result line whose index equals k exactly — off-by-one at either boundary fails.
      Evidence: committed test asserting exit code, named path, and parsed index.
- [ ] Corruption sensitivity: a committed test invokes the harness with
      `--corrupt-cold-byte <n>` (one byte of client C's canonical reduced state
      flipped) and asserts exit nonzero with the divergent key/path named. Evidence:
      committed test.
- [ ] Green baseline is frozen: the harness with no flags exits 0, all three
      digests equal the committed `evidence/golden-tree.digest`, and both clients'
      canonical reduced-state files are byte-compared against the committed
      `evidence/golden-state.json` by the harness comparison step and the green-path
      test — that byte-comparison is the named consumer of `golden-state.json`, so a
      wrong byte in the committed file turns those checks red. Deleting
      `evidence/golden-tree.digest`, `evidence/golden-tree/`, or
      `evidence/golden-state.json` makes the consuming checks fail red (because the
      byte-comparison has nothing to compare against — a bare file-exists check does
      not satisfy this), never
      regenerate-and-pass. Evidence: recipe text + adversarial angle 3.
- [ ] No warm state: `make verify-E1-convergence` twice back-to-back passes both
      times; the harness creates its own data dir, port, and scratch trees per run.
      Evidence: the critic's double run, per angle 7.
- [ ] The scenario's E1-T04 refused stale write leaves no trace in either client's
      dump, state, or tree: the refused write's content carries a unique sentinel
      string (a fixed UUID-like literal committed in the test that appears nowhere
      else in the scenario — no honest file content can collide with it); a committed
      assertion greps both client dumps **and both clients' canonical reduced-state
      files** for that sentinel and finds nothing, byte-compares each client's
      canonical state file against the committed `evidence/golden-state.json`, and
      checks all
      three digests byte-equal the committed `evidence/golden-tree.digest` (the
      committed scenario **script** in `tools/verify/convergence.sh` dispatches the
      refused attempt, while `evidence/golden-scenario.jsonl` — the resulting server
      dump — is refusal-free by construction per E1-T04, so the refusal-free tree is
      the golden tree). Evidence: committed test.
- [ ] `bash tools/verify/self_check.sh` (`make _v-meta`) exits 0 after the Makefile
      edits; `make verify-list` shows E1-T06 covered; all root gates
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
      exit 0. Evidence: the critic reruns the three commands from the cold clone —
      deterministic exit codes, stream layer.
- [ ] Replay (browser layer): N/A — CLI/harness task with no browser-reaching surface;
      mitigation is the stream-layer evidence above, declared explicitly in the claim.

## Adversarial verification

The claim under attack: "this instrument sees any divergence between two clients of one
stream, pins it to a path and an offset, and cannot be fooled by a warm machine or a
self-licking golden." Use your own scenarios, indices, and mutations — never only the
builder's; any single success refutes. Invent at least one more angle.

1. **Sensitivity of the apparatus (mandatory — a harness that stays green is itself
   refuted).** This target is what every later convergence claim cites; if it cannot
   see divergence, Epic 1's evidence economy is void. Beyond the builder's committed
   red paths, run your own: suppress records at indices you choose (including 1 and
   the final record), duplicate a record, swap two adjacent records, inject an extra
   trailing event into client L's feed; flip single bytes at offsets you choose in
   client C's canonical state file — including a byte inside a file-content value and
   a byte inside a path key. Refutation: any manipulation after which the harness
   exits 0, any red run that fails to name the divergent path, or an `ef bisect` line
   pinning any index other than your injection point. Then attack the tree comparison
   directly: after a green run, flip one byte of one file inside one client's
   materialized tree and rerun only the comparison step — it must go red; a comparison
   that samples or trusts digests without diffing bytes refutes.
2. **Two-client honesty.** Read `tools/verify/convergence.sh`: two client processes
   must genuinely take different paths. Sabotage in a scratch worktree: make client
   L's reduction skip one event type, then separately make client C's cold read
   truncate one record — each sabotage independently must turn the target red. If
   either stays green, one client's output was copied from the other and the harness
   is theater. Confirm client L really tails live during the writer's run (not a
   post-hoc file read): its dump must exist before the writer finishes (check
   timestamps/transcript ordering) and the frozen `KILL client-L pid=<p>
   at-offset=<k>` and `RESUME client-L from-checkpoint offset=<k>` marker lines must
   appear in the transcript in that order. Then sabotage checkpoint persistence and,
   separately, the resume read: after each sabotage the harness must exit nonzero OR
   the RESUME line must be absent from the transcript — a green run whose transcript
   still contains the RESUME line refutes.
3. **Self-licking golden.** Inspect the Makefile recipe, the tests, and git history:
   is `evidence/golden-tree.digest`, `evidence/golden-tree/`, or
   `evidence/golden-state.json` ever (re)computed by the code under test at check
   time? Delete each in turn and run the consuming checks — red, not
   regenerate-and-pass, or the baseline is a mirror. Then re-derive the golden
   yourself from `golden-scenario.jsonl`: `ef materialize` it and byte-diff against
   the committed tree, **and** run it through `ef replay`/the stream-fs reducer to
   produce the canonical reduced state and byte-diff that against the committed
   `evidence/golden-state.json` — a golden tree or golden state that cannot be
   re-derived from the committed dump
   refutes its provenance.
4. **Differential against replay, your own scenarios.** Generate your own valid
   stream-fs logs (patches interleaved with renames, delete-then-recreate at one path,
   fenced writes, deep directory moves) and compare `ef materialize`'s printed digest
   against `ef replay --digest` on the same dump — at head and at ≥3 `--at` prefix
   offsets of your choosing, and run both tools with the same explicit
   `--reducer <module>` (the digests must still agree; a `--reducer` that is ignored
   or hardcoded refutes). Any disagreement refutes the one-replay-core claim. Also
   hunt for a malformed dump that `ef replay` and `ef materialize` judge differently
   (one accepts, one rejects) — that refutes the shared-parser claim.
5. **Determinism and env hunt.** Run `ef materialize` and the full harness only via
   `tools/verify/cold_clone.sh`; repeat under `TZ=UTC` vs `TZ=Pacific/Kiritimati`,
   `LANG=C` vs `LANG=en_US.UTF-8`, different cwds, and a different umask; `diff -r`
   the resulting trees and compare digests. Any differing byte or digest refutes —
   the tree writer leaks machine state. Sweep the diff for `Date.now`,
   `toLocaleString`, `Intl`, mtimes feeding the digest, and iteration-order
   dependence.
6. **Hostile dumps at the tree writer.** Fuzz `ef materialize` beyond the E0-T04
   corpus: absolute paths, `..` segments, case-colliding paths, a file event where a
   directory exists (and vice versa), events for tombstoned paths, `--at` pointing at
   a refused/nonexistent offset, a symlink pre-planted in `--out`'s parent pointing
   elsewhere. Refutation: exit 0 on any invalid input, any stdout byte in an error
   case, or **any write landing outside the out dir** — the last refutes regardless
   of exit code.
7. **Warm-state hunt.** Run the harness twice back-to-back, then concurrently in two
   shells; grep it for fixed ports, fixed temp paths, or reuse of a development
   server's data dir. Refutation: a second or concurrent run failing — or passing
   only — because of leftover state. The instrument must be usable by every future
   critic without ritual.
8. **Sabotage the verdict machinery.** In a scratch worktree: make the digest
   comparison always-equal, drop the `ef bisect` call, swallow the `diff -r` exit
   code, and make the state-file comparison compare a file to itself — after each,
   run `pnpm test` and `make verify-E1-T06`; any sabotage that stays green refutes
   the suite. Sweep the diff for `.skip`/`.todo`/inline lint disables.
9. **Coverage.** Hold the claimed final run against the diff: both sabotage-flag
   paths, every `ef materialize` error class (corpus rejection, non-empty out dir,
   absent `--at`, path escape, nonexistent `--reducer` module), the `--at` prefix
   path, the explicit `--reducer <module>` path (both success and failure), the
   bisect-on-red path, the
   kill/resume of client L, and both clients' reduce-and-materialize paths must each
   have been executed by a committed test or the recorded run. Unexecuted diff is
   unproven or dead — the builder chooses which, you enforce it.

Refutation currency: a harness transcript + the manipulation that failed to turn it
red, an `ef bisect` line pinning the wrong offset, a digest pair that should match and
doesn't (or shouldn't and does), or a byte written outside `--out`. "The output is
verbose" is a note, not a finding.

## Verification log

### 2026-07-13 — critic — VERDICT: verified

- Source under audit: E1-T05 verified base `01e855e` through current HEAD
  `52725ed`; no production files were changed by this critic. The unrelated
  pre-existing `.eforest/tasks/epic-5-the-meadow/E5-T09-pr-ui-live/readme.md`
  modification was preserved.
- Stream-layer green proof: `CI=true make verify-E1-T06` passed the root gates,
  materialize tests, convergence target, and attack target. A direct rerun of
  `node tools/verify/convergence.mjs` converged 16 records after client-L kill
  and resume at offset
  `0000000000000000_0000000000000006`; client-L, client-C, and server
  materialization each produced
  `0f63b47e11ad5fe6561427e6b8b0cbb3aefec7dde5a450ca60446600a88db380`.
  The committed transcript is
  `evidence/e1-t06-transcript.txt`; the committed dump, state, tree, and digest
  are `evidence/golden-scenario.jsonl`, `evidence/golden-state.json`,
  `evidence/golden-tree/`, and `evidence/golden-tree.digest`.
- Adversarial suppression: `node tools/verify/convergence_attacks.mjs` made
  first, middle, and final suppression red at indices 1, 8, and 16, with the
  corresponding `ef bisect` index in each divergence report; one-byte cold
  state corruption was also red with a named `state.` path. The committed
  cold-clone evidence is `evidence/e1-t06-cold-clone.txt`; an independent
  `CI=true tools/verify/cold_clone.sh verify-E1-convergence` passed from a
  pristine clone.
- Materialize provenance and hostile inputs: replay and materialize of
  `evidence/golden-scenario.jsonl` independently re-derived the committed
  digest and `diff -r` was empty against `evidence/golden-tree/`. A malformed
  trailing-record dump and a valid-envelope `../` path escape both exited
  nonzero with zero stdout, no output tree, and no outside write; a valid
  middle `--at` prefix exited 0 with digest
  `808f0dcc40bf907fb8b9d19589c326fb15ab632d10caf34da0174f70f5fb50de`.
  A separate one-byte mutation of `golden-tree/src/final.txt` made the direct
  `diff -r` comparison exit 1 and identify that path, confirming tree-byte
  comparison sensitivity.
- Coverage review: changed materialize paths (full, `--at`, explicit/default
  reducer, malformed/rejection, and path safety), both independent clients,
  checkpoint resume, golden comparisons, and bisect-backed red paths were
  exercised by the committed tests/targets or the runs above. No `.skip`,
  `.todo`, or inline lint-disable bypass was found in the changed files.
- Replay: N/A (CLI/node-only task with no browser-reaching surface) + mitigation:
  cold-clone stream verification, canonical state/tree byte comparisons,
  materialize/replay digest parity, committed goldens, and adversarial red paths.

The recorded/committed stream evidence survives falsification and sufficiency
checks: the two client paths converge exactly, the refusal sentinel leaves no
trace, the materializer agrees with replay at exercised prefixes, and the
comparison apparatus turns hostile state/tree mutations red.

### 2026-07-13 — builder — implemented

- Source commit: `36d61d1f74047c8217044863b7aab8281fe80f9c`.
- Cold-clone command: `CI=true tools/verify/cold_clone.sh --keep verify-E1-T06`.
  The scrubbed pristine clone passed format, lint, typecheck, 22 test files / 129
  tests, build, the inherited E0-T01 through E1-T05 targets, `_v-meta`, and
  `verify-E1-T06`. The exact run summary is committed at
  `evidence/e1-t06-cold-clone.txt`.
- Stream evidence: `evidence/e1-t06-transcript.txt` records distinct live and cold
  client commands, client-L kill/resume at offset
  `0000000000000000_0000000000000006`, a 16-record head, and the refused-write
  sentinel absent from both client dumps. The committed goldens are
  `evidence/golden-scenario.jsonl`, `evidence/golden-state.json`,
  `evidence/golden-tree/`, and `evidence/golden-tree.digest`.
- Digest evidence: live, cold, and server `ef materialize` digests all equal
  `0f63b47e11ad5fe6561427e6b8b0cbb3aefec7dde5a450ca60446600a88db380`.
  `packages/cli/src/materialize.test.ts` covers full/head/mid/first `--at`,
  replay parity, reducer success/failure, malformed input, non-empty output, and
  path-escape refusal. The committed attack runner proves first/middle/final live
  suppression and one-byte cold-state corruption all turn the harness red.
- Replay: N/A (CLI, reducer, and node/file-backed convergence harness with no
  browser-reaching surface) + mitigation: the cold-clone stream-layer run,
  canonical state/tree byte comparisons, `ef materialize` digest parity, committed
  goldens, and red-path sensitivity checks are the evidence layer.

The final run demonstrates two independent client processes converging byte-for-byte
after a live tail is killed and resumed, while a cold replay and server materialization
produce the same canonical state, real tree bytes, and SHA-256 digest. The fresh clone
also proves the acceptance target does not depend on warm workspace state.
