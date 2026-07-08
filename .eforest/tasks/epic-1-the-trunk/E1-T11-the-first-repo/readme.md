---
id: E1-T11
epic: 1
title: "Capstone: the-first-repo — cold-start create, write a tree, fork at an offset, watch both branches live, merge, digest-verify via make verify-E1-*"
priority: 111
status: pending
depends_on: [E1-T07, E1-T10]
estimate: L
capstone: true
---

## Goal

ROADMAP's Epic-1 demo — **the-first-repo** — runs end-to-end from nothing, entirely as
`make verify-E1-*` targets, and its every claim is a digest. From a pristine clone
(`tools/verify/cold_clone.sh verify-E1-T11`, scrubbed env per the E0-T02 contract) with a
**fresh file-backed stream-server data dir created by the run itself**, the orchestrator
`tools/verify/e1-capstone/run.sh` executes a named sequence of steps: **create** a repo
backed by stream-fs (`createRepo("first-repo")` → metadata stream
`fs:first-repo:main:meta`, E1-T01); **write** a small committed source tree through the
dispatch door (files, nested dirs, ≥2 `fs/patch` events — every mutation via
`POST /streams/:id/dispatch`, nothing else); anchor an E1-T07 **snapshot** and record its
offset; **fork** `feature` from `main` at a recorded `forkOffset` (E1-T08
`fs.branch.fork`); **edit both sides** — patches on both branches, a rename on one, a
delete on the other, all non-overlapping by construction, plus one scripted stale-based
write that E1-T04 refuses with the log untouched — **while two independent live clients
watch `main` and `feature`** (E1-T05 `watch()` driven through the E1-T06 harness guts,
separate OS processes, tailing during the edits, not after); **merge**: a premature
fast-forward of `feature` into the advanced `main` is refused typed
`merge/ff-target-advanced` (E1-T09, head byte-identical before/after), a three-way merge
of `main` into `feature` (E1-T10) lands with **zero** `fs/merge-conflict` events, and the
now-superset `feature` fast-forwards into `main`, appending one `fs/merge` event; then
**digest-verify** via the T06 apparatus: `ef replay <main-dump> --digest`,
`ef materialize` of that dump, and both watchers' independently materialized converged
trees all print one identical tree digest equal to the frozen
`evidence/merged-tree.digest`. The run emits `evidence/digest-chain.txt` — the tree
digest of both branches at **every named step**, with the step's head offset — frozen as
a golden; an `ef bisect` run pins **divergence** (first divergent offset between the
resolved branch logs = the first post-fork edit) and **reconvergence** (equal head
digests after the merge, zero divergence between the server's `main` dump and watcher
A's received log) to exact offsets; and the whole orchestration executed **twice** from
two fresh data dirs reproduces byte-identical digest chains. Epic 1 is done when this
target cannot be distinguished from the ROADMAP capstone paragraph by any observable.

## Context

This is the Epic-1 capstone — the runnable milestone `QUEUE.md` gates Epic 2 on (ROADMAP
"Epic 1 — the-trunk", capstone **the-first-repo**). Per `.eforest/tasks/README.md`, a
capstone additionally requires its demo end-to-end **from a cold start**: fresh clone,
scrubbed env, fresh stream-server data dir, no state left over from development. Nothing
new is designed here; the task is pure composition and proof over the epic's verified
parts, reached through the dependency closure of E1-T07 and E1-T10:

- **E1-T01..T03** supply the frozen fs event envelope, `createRepo`, directory ops,
  text patches, and the canonical tree digest — the only tree-equality currency this
  task uses; a second hash anywhere is a finding.
- **E1-T04** supplies stale-write fencing; the demo dispatches one write with a stale
  base and proves the refusal left the branch head byte-identical — the capstone proves
  the fence, not just the pipe.
- **E1-T05/T06** supply the live-watching proof instrument: the two second clients are
  the convergence harness's independent tailing clients (echoed command lines, separate
  PIDs), trees compared by exact `diff -r` plus digest, divergence pinned by `ef bisect`
  (E0-T12) — never eyeballs.
- **E1-T07** supplies snapshots: the demo anchors one mid-scenario, a late-joining
  client `bootstrapRead`s from it to the same head digest, and a pre-anchor offset read
  after compaction answers exactly `410 Gone`.
- **E1-T08/T09/T10** supply fork-at-offset, the `fs/merge` fast-forward event with its
  `merge/ff-target-advanced` typed refusal, and the three-way merge on patches. The
  scripted scenario has **zero conflicts by construction** — conflict surfacing is
  E1-T10's own verified evidence, not re-proven here — but the FF **refusal** path is
  exercised live, because a merge door that refused nothing during the demo is unproven.

Anything the demo needs that a dependency failed to deliver is a finding against that
dependency, not a workaround absorbed here — a capstone that patches around its epic
refutes the epic. Contracts frozen here:

- **The scenario is committed fixture data**, not generated at run time by the code
  under test: the initial tree, both branches' scripted edit sequences (including the
  stale write and the fork point), and every golden (`digest-chain.txt`,
  `merged-tree/`, `merged-tree.digest`, both watcher transcripts) are produced once and
  committed; no consuming check may regenerate them at check time (E1-T06's
  frozen-golden rule applies verbatim).
- **The digest chain is the capstone's spine**: every named step
  (`created`, `tree-written`, `snapshot`, `forked`, `main-edited`, `feature-edited`,
  `ff-refused`, `merged-into-feature`, `ff-into-main`) records
  `(step, branch, head offset, tree digest)` in a canonical line format; the committed
  golden is the frozen history of the whole demo, and any drift at any step is a real
  regression pinned to a step name and an offset.
- **Repeatability is part of the claim**: `run.sh` twice, two fresh data dirs, must
  yield byte-identical digest chains and normalized watcher transcripts. A demo that
  only works once is not a milestone.

Replay browser layer: **N/A (no web app until Epic 3)**, declared per AGENTS.md;
mitigation is the two-client convergence diff plus the full stream-layer evidence set —
committed event-log dumps for both branches, the digest chain, watcher transcripts
byte-matched to goldens, and independent `ef replay` / `ef materialize` / `ef bisect`
reproduction.

Unblocks: the Epic-1 gate (`E1` as a bare-epic dependency resolves through this task),
therefore all of Epic 2.

## Deliverables

- `tools/verify/e1-capstone/` — the demo as code, runnable by anyone:
  - `scenario/` — committed fixtures: `initial-tree/` (the small source tree),
    `main-edits.jsonl` and `feature-edits.jsonl` (the scripted dispatch sequences —
    patches on both sides, a rename on `feature`, a delete on `main`, exactly one
    stale-based write on `main` expected to be refused per E1-T04), the committed
    **batch layout** assigning every scripted edit to one of ≥3 named dispatch
    batches with at least one dispatch to each branch per batch (a `batch` field per
    line or a `batches.txt` manifest — fixture data, not derived at run time), and
    `fork-point.txt` naming the scripted event the fork follows.
  - `run.sh` — the orchestrator: boots the file-backed stream server on an ephemeral
    port with a fresh data dir under the run's scratch space (path printed); creates
    the repo; writes the initial tree via dispatch; anchors the E1-T07 snapshot
    (`createSnapshot`, anchor offset recorded); forks `feature` at the current `main`
    head (`forkOffset` recorded, branch digest at `forkOffset` asserted equal to
    `main`'s at the same offset via `ef replay`); starts the two watcher clients (one
    per branch, separate OS processes, PIDs and command lines echoed) **before** the
    edit phase; replays both edit scripts through `/dispatch` in **at least 3 named
    batches** — a frozen part of this contract: every batch contains at least one
    dispatch to **each** branch, and `run.sh` logs each batch's name, its boundaries,
    and its first-dispatch timestamp in the transcript, timestamping every individual
    dispatch (the batch layout — which scripted edits belong to which batch — is
    committed alongside the edit scripts in `scenario/`, e.g. a `batch` field per
    line or a `batches.txt` manifest, so the layout cannot be redefined at run time);
    performs the merge legs in order (FF `feature`→`main` refused
    `merge/ff-target-advanced` → three-way `main`→`feature` with zero conflict events
    → FF `feature`→`main` appending `fs/merge`); waits for both watchers to drain to
    head; then runs the verdict: digest chain byte-diffed against
    `evidence/digest-chain.txt`, normalized watcher transcripts byte-diffed against
    goldens, `diff -r` of both watchers' materialized trees against
    `evidence/merged-tree/`, the four-way digest equality (`ef replay` on the `main`
    dump, `ef materialize` on it, watcher A's tree, watcher B's tree — all equal to
    `evidence/merged-tree.digest`), the divergence/reconvergence bisect (`ef bisect`
    over the resolved branch logs pins the first divergent offset to the first
    post-fork edit; `ef bisect` over the server's `main` dump vs watcher A's received
    log reports zero divergence; both branch head digests equal after the final
    merge), the snapshot leg (fresh client bootstraps from the anchor to the head
    digest; a pre-anchor offset GET after compaction returns `410 Gone`), and the
    refusal assertions (stale write and FF refusal each left their target head and
    digest byte-identical, statuses matching the E1-T04/E1-T09 contracts, refused
    payload absent from every dump). Any mismatch exits nonzero naming the failing
    comparison and, for tree/log divergence, the `ef bisect` result line.
  - Modes: `EF_CAPSTONE_FORK_AFTER=<n>` lets a critic pick their own fork point —
    `run.sh` announces **custom-fork mode** in the transcript and substitutes exactly
    the three committed-golden comparisons (digest chain, merged tree, watcher
    transcripts) with equality against expectations re-derived in-run via `ef replay`
    over the produced dumps; no other check is relaxed, so the four-way equality must
    hold at any valid fork point and an out-of-domain value must fail loudly.
    `run.sh --repeat` runs the full orchestration twice in fresh data dirs and
    byte-diffs the two runs' digest chains and normalized transcripts.
    `run.sh --check <main-dump> <tree-dir>` recomputes the dump's digest via
    `ef replay`/`ef materialize` and compares it to the tree, exit nonzero on
    mismatch — the equality apparatus standalone, usable against tampered copies.
- `Makefile`: `verify-E1-T11` composed per the E0-T02 recipe contract (standard
  `_v-fmt _v-lint _v-typecheck _v-test _v-build` gates plus `run.sh` and
  `run.sh --repeat`), joined to `verify-all`, visible in `make verify-list`, `.PHONY`
  updated, `tools/verify/self_check.sh` (`_v-meta`) still green.
- Committed evidence in this task's `evidence/`:
  - `main-log.jsonl`, `feature-log.jsonl` — the server's authoritative end-of-demo
    dumps of both branch metadata streams.
  - `digest-chain.txt` — the golden `(step, branch, offset, digest)` chain for every
    named step, plus the recorded snapshot anchor and `forkOffset`.
  - `merged-tree/` + `merged-tree.digest` — the expected final tree and its frozen
    canonical tree digest.
  - `watch-main-transcript.jsonl`, `watch-feature-transcript.jsonl` — both watchers'
    **normalized** `(event, path, offset)` transcripts (no run-specific fields), with
    committed goldens `golden-watch-main.jsonl` / `golden-watch-feature.jsonl`.
  - `watch-main-receipts.log`, `watch-feature-receipts.log` — run-specific
    **timestamped** receipt logs (one line per received event), never golden-compared;
    they exist so watcher receipt timestamps can be checked against the orchestrator's
    dispatch timestamps — the liveness artifact.
  - `bisect.txt` — the divergence/reconvergence transcript: the `ef bisect` line
    pinning first branch divergence to the first post-fork edit's offset, the equal
    post-merge head digests, and the zero-divergence line for server dump vs watcher
    log.
  - `ff-refusal.txt`, `stale-refusal.txt` — request/response, typed status, and
    head+digest byte-identical before/after for each refusal.
  - `snapshot-bootstrap.txt` — anchor offset, the late-joiner's bootstrap digest
    equal to the from-zero replay digest, and the `410 Gone` transcript.
  - `custom-fork.txt` — the custom-fork mode transcripts: one non-default valid
    `EF_CAPSTONE_FORK_AFTER` run green with the three golden comparisons substituted
    by in-run re-derived expectations, one out-of-domain value failing loudly.
  - `repeat-run.txt` — the double-run transcript: both digest chains byte-identical.
  - `sensitivity-tamper.txt` — the tamper drill on **copies**: one byte of one event
    flipped in a copy of `main-log.jsonl` → `run.sh --check` red and `ef bisect`
    naming the tampered offset; working tree clean afterward.
  - `cold-clone-capstone.txt` — `tools/verify/cold_clone.sh verify-E1-T11` transcript
    plus a `verify-all` transcript at the same SHA.
- Verification log entry (builder claim): commit hash, every command and exit code,
  the digest values and the fork/snapshot/merge offsets, evidence paths, and the
  explicit `Replay: N/A (no web app until Epic 3)` declaration naming the two-client
  convergence diff as mitigation.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E1-T11` exits 0 from pristine committed HEAD
      with scrubbed env, zero `SKIPPED:` lines; the transcript
      (`evidence/cold-clone-capstone.txt`) shows the server data dir created inside the
      run's scratch space (path printed) — never reused from the working tree, `/tmp`,
      or a running dev server.
- [ ] Four-way digest identity: the transcript shows the same lowercase-hex SHA-256
      printed by (a) `ef replay evidence/main-log.jsonl --digest` with the stream-fs
      reducer, (b) `ef materialize` of the same dump, (c) watcher A's materialized
      tree, (d) watcher B's materialized tree — all byte-equal to
      `evidence/merged-tree.digest`, with `diff -r` against `evidence/merged-tree/`
      empty; the equality step exits 0.
- [ ] The digest chain is complete and frozen: the run emits one
      `(step, branch, offset, digest)` line for every named step
      (`created` … `ff-into-main`) and the emitted chain byte-equals the committed
      `evidence/digest-chain.txt` (`diff` empty, exact command in the transcript); the
      chain shows `feature`'s digest at `forkOffset` equal to `main`'s at the same
      offset, and both branches' head digests equal after the final merge.
- [ ] Live watching is real: the transcript logs two distinct watcher PIDs and command
      lines started **before** the edit phase; the transcript shows the edit phase
      replayed in the **≥3 named dispatch batches frozen in `scenario/` and the
      `run.sh` contract** (each batch dispatching at least once to each branch, batch
      boundaries and each batch's first-dispatch timestamp logged); receipts
      **interleave** with dispatches — for **every** one of those batches, at least
      one receipt timestamp in **each** watcher's
      `evidence/watch-*-receipts.log` falls strictly after that batch's first dispatch
      timestamp and strictly before the next batch's first dispatch timestamp (for the
      last batch, before the merge legs begin), with the specific timestamp pairs
      quoted in the transcript and each comparison asserted exit-code-checked by
      `run.sh` — collapsing the edit phase into fewer than 3 batches, or a
      first-receipt-before-last-dispatch check alone, is insufficient and
      does not satisfy this criterion; both normalized
      `evidence/watch-*-transcript.jsonl` files byte-equal their committed goldens.
      Receipt logs are never golden-compared.
- [ ] Divergence and reconvergence are pinned: `evidence/bisect.txt` contains (1) an
      `ef bisect` line over the resolved branch logs whose first divergent offset
      equals the first post-fork edit's offset exactly, (2) the equal post-merge head
      digests, and (3) a zero-divergence `ef bisect` result between the server's
      `main` dump and watcher A's received log.
- [ ] Merge legs proven in order: `evidence/ff-refusal.txt` shows the premature
      fast-forward refused with exact code `merge/ff-target-advanced` and `main`'s
      head offset and digest byte-identical before/after; the three-way merge appends
      zero `fs/merge-conflict` events (count asserted over `feature-log.jsonl`); the
      final fast-forward appends exactly one `fs/merge` event to `main` (present in
      `main-log.jsonl`, offset recorded in the digest chain).
- [ ] Fencing proven inside the demo: `evidence/stale-refusal.txt` shows the scripted
      stale-based write refused with exactly HTTP `409`, `error.class`
      `validator-rejected`, `error.reason` `stale-base` per the E1-T04 contract
      (matching the literal style of the `merge/ff-target-advanced` criterion above);
      the refused payload (its
      exact path and content bytes as scripted in `scenario/main-edits.jsonl`) matches
      zero events in `evidence/main-log.jsonl` (exact command in the transcript,
      exit-code-checked by `run.sh`); `main`'s head offset and digest immediately
      before and after the refusal are byte-identical; the final digests were computed
      over that refusal-containing run.
- [ ] Snapshot leg: `evidence/snapshot-bootstrap.txt` shows a fresh client
      bootstrapping from the recorded anchor to the same head digest as the from-zero
      replay, and a GET at a pre-anchor offset after compaction answered exactly
      `410 Gone` per the E1-T07 retention contract.
- [ ] Custom-fork mode works and fails loudly: `run.sh` with
      `EF_CAPSTONE_FORK_AFTER=<a stated non-default valid offset>` exits 0, announces
      custom-fork mode in the transcript, and substitutes **exactly** the three
      committed-golden comparisons (digest chain, merged tree, watcher transcripts)
      with equality against expectations re-derived in-run via `ef replay` over the
      produced dumps — the four-way digest equality still asserted, no other check
      relaxed; `run.sh` with `EF_CAPSTONE_FORK_AFTER=<one past the last valid event>`
      exits nonzero naming the out-of-domain value; both transcripts committed as
      `evidence/custom-fork.txt`.
- [ ] Repeatable to identical digests: `run.sh --repeat` (part of the `verify-E1-T11`
      recipe) executes the full orchestration twice in fresh data dirs and byte-diffs
      the two digest chains and normalized transcripts — empty diffs, exit 0
      (`evidence/repeat-run.txt`).
- [ ] Sensitivity (mandatory): with one byte of one event flipped in a **copy** of
      `evidence/main-log.jsonl`, `run.sh --check <copy> evidence/merged-tree` exits
      nonzero AND `ef bisect` names exactly the tampered event's offset — exact
      commands and exit codes in `evidence/sensitivity-tamper.txt`; working tree clean
      of the plant afterward.
- [ ] Epic gate: every task E1-T01…E1-T10 is `verified` in frontmatter (no
      optional/stretch exemption is currently declared for Epic 1; any would have to
      be stated in both the exempt task's Context and this readme); after
      `python3 tools/build_queue.py`, `git diff --exit-code .eforest/tasks/QUEUE.md`
      passes and QUEUE.md lists no Epic-1 task as pending/in-progress/implemented
      except E1-T11 itself.
- [ ] `make verify-all` exits 0 at the claimed commit, running every `verify-E0-*` and
      `verify-E1-*` target (OK-line count equals the number of targets), and all five
      workspace gates (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
      && pnpm build`) exit 0 — each command and exit code in the Verification log.
- [ ] Replay (browser layer): N/A — no web app until Epic 3; declared in the claim
      with the two-client convergence diff and the stream-layer dumps/digests named as
      mitigation.

## Adversarial verification

This is a capstone: the claim is "the epic's machine works end-to-end from nothing, and
its whole history is a reproducible chain of digests." Attack *from nothing*,
*end-to-end*, and *reproducible* separately, with your own fork points, edit scripts,
and tamper offsets — never only the builder's. Any single success refutes. Invent at
least one more angle.

1. **Cold-start sabotage.** Run `tools/verify/cold_clone.sh verify-E1-T11` yourself,
   then again with a poisoned caller env (`NODE_OPTIONS`, `NODE_ENV=production`,
   `npm_config_registry` at a dead port) and a warm dev server deliberately left
   running on a likely port; kill your warm server mid-run — the capstone must not
   care. Grep `tools/verify/e1-capstone/` for fixed ports, absolute paths,
   `~/.`-anything, or reads of any data dir outside the run's scratch space. Any
   dependency on pre-existing state refutes the cold-start claim.
2. **Watcher theater.** The headline is two clients watching **live**. Verify the
   logged PIDs differ from the orchestrator's and each other's, and that each
   transcript is built from tailed events, not the server dump handed over post-hoc:
   (a) make `main-log.jsonl`'s eventual path unreadable to the watcher processes
   before the run — an honest watcher is unaffected; (b) in a scratch worktree,
   sabotage one watcher to replay the dump instead of tailing and confirm a committed
   check distinguishes it (receipt timestamps interleaved with dispatch timestamps, or
   a syscall trace showing no open of the dump); (c) delay one dispatch batch and
   confirm the receipt log shows arrival before run end, not one bulk flush. If no
   observable distinguishes tailing from post-hoc replay, "watch live" is theater and
   the task is refuted.
3. **Digest-chain integrity.** The chain is the spine — attack it. Re-derive every
   line yourself: `ef replay` each committed dump truncated at each step's recorded
   offset must reproduce that step's digest exactly; any line you cannot re-earn from
   the committed logs is fabricated evidence and refutes outright. Then check the
   chain is asserted, not decorative: in a scratch worktree, corrupt one mid-chain
   digest in the golden and run `verify-E1-T11` — red, naming the step; a green run
   refutes the comparison. Finally verify the chain's offsets are strictly consistent
   with the dumps (no step offset absent from its log).
4. **Fork-point sweep.** Re-run with your own `EF_CAPSTONE_FORK_AFTER` values: 0, 1,
   the last pre-fork event, and one past the end (must fail loudly, never silently
   pass). At each valid point assert yourself via `ef replay` that `feature` at
   `forkOffset` digests equal to `main` at the same offset, that the four-way equality
   holds against the re-derived expected digest, and that the transcript announces
   custom-fork mode with exactly the three committed-golden comparisons substituted —
   a run that still byte-diffs committed goldens at a non-default fork point, or that
   silently skips the equality, is a finding. Any mismatch: bisect it — the offset is
   your citation.
5. **Merge honesty.** The three-way leg is conflict-free by construction — verify it
   was not rigged trivial: `feature-log.jsonl` must contain real divergent edits on
   both sides after the fork (patches, the rename, the delete — not an empty side that
   makes every merge a fast-forward). Attack the refusal yourself: attempt your own
   FF into an advanced target and confirm `merge/ff-target-advanced` with head and
   digest untouched (dump+digest before/after). Then craft a genuinely conflicting
   edit pair in a scratch run: the three-way merge must surface an `fs/merge-conflict`
   event per E1-T10, never silently resolve — a demo pipeline that would have
   swallowed a conflict refutes the composition even though the golden scenario has
   none.
6. **Tamper drill, your offsets.** Repeat the sensitivity proof with your own
   mutations against copies of `main-log.jsonl`, `feature-log.jsonl`, and the watcher
   logs: flip a byte in the `fs/merge` event, in a post-fork feature-originated event,
   and in the first event; delete one event; duplicate one; swap two adjacent ones.
   Each must turn `run.sh --check` (or the digest comparison) red with `ef bisect`
   naming the exact first-divergent offset. Also flip one byte of one file inside a
   copy of `evidence/merged-tree/` and rerun only the comparison — red. Any tamper
   that stays green refutes the entire measuring apparatus and voids the epic's
   evidence.
7. **Repeatability, hostile conditions.** Run `run.sh --repeat` yourself, then run the
   orchestration under `TZ=UTC` vs `TZ=Pacific/Kiritimati`, `LANG=C` vs
   `LANG=en_US.UTF-8`, a different cwd and umask, and concurrently in two shells.
   Digest chains and normalized transcripts must be byte-identical across all runs;
   any differing byte is a determinism leak and refutes. Sweep the diff for
   `Date.now`/locale/iteration-order dependence feeding anything golden-compared.
8. **Refusal-leg and snapshot authenticity.** The refusals must have happened inside
   the recorded run: offsets/timestamps consistent with the committed logs, refused
   payloads absent from every dump, and re-running with the stale write's base
   corrected must change the refusal transcript — a refusal transcript that survives
   editing the fixture is decorative and refutes. For the snapshot: join your own
   fresh client from the anchor, digest-compare against a from-zero replay, request
   pre-anchor offsets (every one `410 Gone`), and confirm the bootstrapping client
   provably did not read pre-anchor events (trace or server access log). A bootstrap
   that quietly replays from zero refutes the leg.
9. **Evidence authenticity + epic-gate audit.** Re-earn every committed artifact:
   `ef replay` over `main-log.jsonl` prints `merged-tree.digest`'s content;
   `ef materialize` reproduces `merged-tree/` byte-for-byte; transcripts byte-match
   goldens; `ef bisect` over the committed logs is clean. A committed artifact you
   cannot reproduce from committed code is fabricated evidence. Then audit the gate:
   E1-T01…E1-T10 all `verified` with matching Verification-log entries; `verify-all`
   at the claimed SHA runs every E0 and E1 target green (count the OK lines); and no
   dependency was quietly patched inside this task's diff — any change to
   `packages/*` or pre-existing `tools/verify/` scripts beyond adding the capstone
   orchestration needs a stated reason or it is a finding against that dependency's
   verification.

Refutation currency: an event-log file + the first divergent offset (`ef bisect`
output), a digest-chain line that cannot be re-derived, a digest pair that should match
and doesn't (or should differ and doesn't), a transcript showing green where a contract
demands red, or a planted diff — each cited by file:line/offset.
`Replay: N/A (no web app until Epic 3)`; the two-client convergence diff plus the
stream-layer artifacts above are the whole currency, and their independent
reproducibility is the epic's exit exam.

## Verification log

(appended over time by builders and critics)
