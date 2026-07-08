---
id: E0-T02
epic: 0
title: Verify spine frozen and proven sensitive — composed verify recipes, self-check, cold-clone, per-task target contract
priority: 2
status: in-progress
depends_on: [E0-T01]
estimate: M
capstone: false
---

## Goal

The verification spine reaches its frozen Epic-0 contract and is **proven sensitive,
not merely present**. The `Makefile` verify section (between the marker comments
`# --- Adversarial-verification tooling ---` and `# --- end verify section ---`)
carries real per-task targets `verify-E0-T01` and `verify-E0-T02`, each composed by
name from the shared `_v-*` recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build
_v-meta` …), and both are prerequisites of `verify-all`. `make verify-list`
(via `tools/verify/list.sh`) prints the target↔task map across all epics and exits
nonzero when any task with frontmatter `status: implemented` or `verified` lacks a
`verify-E{n}-T{nn}` target. The loud-skip contract (`SKIPPED: <reason>` + nonzero exit
unless `VERIFY_ALLOW_SKIP=1`, per `v_skip` in the Makefile) holds for every recipe whose
infrastructure hasn't landed. `tools/verify/self_check.sh` (the greenwash scanner),
`tools/verify/cold_clone.sh` (pristine-HEAD clone with scrubbed `NODE_OPTIONS` /
`NODE_ENV` / `npm_config_*` env and PATH-shim protection), and `tools/verify/list.sh`
all run green from a cold clone — and each is demonstrated to go **red** when its
invariant is deliberately violated, with the transcripts committed to this task's
`evidence/`. A recorded `tools/replay/preflight.sh` run establishes the Replay
capability status of this machine, freezing the convention that every Epic-0 claim
carries `Replay: N/A (no browser surface until Epic 3)` plus its mitigation
(stream-layer evidence). This target-composition contract is **frozen here**: every
later task in every epic adds its `verify-E{n}-T{nn}` target by composing these `_v-*`
recipes by name, and joins `verify-all` — changing recipe names or the marker comments
later invalidates the coverage machinery and every standing verification.

## Context

Everything downstream of this task is only as trustworthy as the apparatus that checks
it. The skeleton already exists (Makefile verify section, `tools/verify/*.sh`,
`tools/replay/preflight.sh`, ported from the wasm-vm/figma-clone doctrine donors per
`AGENTS.md`), but as of E0-T01 nothing has ever exercised it end-to-end: no per-task
target has ever been composed, no sensitivity proof has ever been run, and any latent
bug in `self_check.sh`'s scanner or `cold_clone.sh`'s env scrub would silently
green-wash every future task. AGENTS.md is explicit: *"a sensitivity proof is
non-negotiable wherever a measuring apparatus is claimed: mutate one byte of the input
and the apparatus must go red, or the apparatus itself is refuted."* This task is that
proof, applied to the apparatus itself, before any protocol code (E0-T03+) leans on it.

Contracts frozen here (later changes invalidate standing verifications):

- **Per-task target contract**: `verify-E{n}-T{nn}:` targets live inside the marker
  section, are composed from the shared `_v-*` recipes by name, and are added to
  `verify-all`'s prerequisites the moment a task reaches `implemented`.
- **Coverage rule** (already stated in `tools/verify/self_check.sh` and enforced by
  both it and `list.sh`): a task with `status: implemented` or `verified` and no
  `verify-<id>` Makefile target is a failure; `pending`/`in-progress`/`refuted` tasks
  are listed but exempt.
- **Frozen banner strings** (acceptance evidence anchors — editing them is contract
  drift, not compliance): `tools/verify/self_check.sh`'s success line
  `verify self-check OK: every implemented/verified task has a target; no
  green-washing escapes`; `tools/verify/list.sh`'s column-header line
  `TARGET  STATUS  TASK` (padded per `printf '%-18s  %-12s  %s'`); the per-task
  OK echoes, exactly `verify-E0-T01: OK` and `verify-E0-T02: OK` (pattern for later
  tasks: `verify-E{n}-T{nn}: OK` — the target name, a colon, one space, `OK`, nothing
  else); and `verify-all`'s closing line
  `verify-all: every defined verify target passed`.
- **Loud-skip contract**: no verify path may pass silently over missing
  infrastructure — `SKIPPED: <reason>` and nonzero exit, overridable only by
  `VERIFY_ALLOW_SKIP=1` (which still prints).
- **Replay declaration convention for Epic 0**: no browser surface exists until
  Epic 3, so every Epic-0 claim declares `Replay: N/A (no browser surface until
  Epic 3)` with stream-layer evidence as the mitigation — silence is forbidden
  (AGENTS.md, Evidence section).

Depends on E0-T01 because `verify-E0-T01` composes the real workspace gates
(`_v-fmt _v-lint _v-typecheck _v-test _v-build` stop skipping once `package.json`
exists) and because `cold_clone.sh` clones committed HEAD — there must be a bootstrap
commit to clone. Unblocks every subsequent task: E0-T03 onward each land with a
`verify-E0-T{nn}` target under this contract, and the E0-T13 capstone runs entirely
through `make verify-E0-*`.

## Deliverables

- `Makefile` (verify section, inside the markers):
  - `verify-E0-T01:` composed from `_v-fmt _v-lint _v-typecheck _v-test _v-build`
    (the workspace-gates task), ending in exactly `@echo "verify-E0-T01: OK"`.
  - `verify-E0-T02:` composed from `_v-meta` plus a `verify-list` invocation (the
    spine verifying itself), ending in exactly `@echo "verify-E0-T02: OK"`.
  - `verify-all:` prerequisites updated to include both targets (union semantics —
    each `_v-*` recipe still runs; make dedupes shared prerequisites).
  - `.PHONY` updated for the new targets.
- `tools/verify/self_check.sh`, `tools/verify/cold_clone.sh`, `tools/verify/list.sh` —
  exercised end-to-end; any bug found while proving sensitivity is fixed here (these
  scripts are in-scope implementation surface for this task).
- Committed evidence in `.eforest/tasks/epic-0-the-seed/E0-T02-verify-spine/evidence/`:
  - `sensitivity-selfcheck.txt` — transcript showing `self_check.sh` exiting nonzero
    on a planted `|| true` inside a recipe line of the Makefile marker section, and
    (separate plant, same transcript or a sibling file) on a planted
    `continue-on-error` and a planted `-` recipe-prefix; each plant applied to a
    scratch copy or reverted working tree, never committed.
  - `sensitivity-coverage.txt` — transcript showing `make verify-list` and
    `tools/verify/self_check.sh` both exiting nonzero when a task readme's status is
    flipped to `implemented` with no `verify-<id>` target in the Makefile (plant
    reverted after capture).
  - `cold-clone-verify-all.txt` — transcript of
    `tools/verify/cold_clone.sh verify-all` passing from pristine committed HEAD.
  - `loud-skip.txt` — transcript of the bare `make _v-web` run (SKIPPED line,
    nonzero exit) and the `VERIFY_ALLOW_SKIP=1 make _v-web` run (SKIPPED line still
    printed, exit 0), each followed by `echo $?`.
  - `replay-preflight.txt` — the recorded `tools/replay/preflight.sh` output for this
    machine, dated, with the resulting Epic-0 declaration
    (`Replay: N/A (no browser surface until Epic 3)`) stated alongside it.
- Verification log entry (builder claim) naming every command, exit code, and
  evidence path, with the Replay declaration per the frozen convention.

## Acceptance criteria

- [ ] `make verify-E0-T02` exits 0 and its output shows `_v-meta`
      (i.e. `tools/verify/self_check.sh`) and `tools/verify/list.sh` actually ran:
      the transcript contains self_check.sh's exact success line
      `verify self-check OK: every implemented/verified task has a target; no
      green-washing escapes` and list.sh's exact column-header line
      `TARGET  STATUS  TASK` (whitespace-padded per its `printf '%-18s  %-12s  %s'`
      format). These strings are frozen in the Contracts list above — a builder edit
      to either string is contract drift, not a way to satisfy this criterion.
      Evidence: the cold-clone transcript `evidence/cold-clone-verify-all.txt` (whose
      `verify-all` run contains this target's full output) plus critic re-execution
      with the exit code observed live — no separate committed artifact is required.
- [ ] `make verify-E0-T01` exits 0 with zero `SKIPPED:` lines (E0-T01's workspace
      exists), and the gates demonstrably *executed* rather than merely echoing their
      command lines (make prints recipe lines by default, so the strings `pnpm lint`
      etc. appearing in the transcript prove nothing). The check is critic
      re-execution: run the target live, observe exit 0 and zero `SKIPPED:` lines,
      and confirm tool-emitted output is present — at minimum vitest's test-summary
      line from `pnpm test` and the formatter's success line from `pnpm format:check`
      (e.g. Prettier's `All matched files use Prettier code style!`); a gate that is
      silent on success (e.g. `tsc`) is verified by its live exit code. Evidence: the
      cold-clone transcript `evidence/cold-clone-verify-all.txt` (whose `verify-all`
      run contains this target's full output) plus that live re-execution — no
      separate committed artifact is required.
- [ ] `make verify-all` exits 0 and runs the union: the transcript contains the
      literal per-task OK echoes `verify-E0-T01: OK` and `verify-E0-T02: OK`
      (byte-for-byte, the exact frozen `@echo` strings mandated in Deliverables),
      plus `_v-meta`'s `verify self-check OK:` line, and ends with
      `verify-all: every defined verify target passed`. Evidence: the cold-clone
      transcript `evidence/cold-clone-verify-all.txt` (which is a `verify-all` run)
      plus critic re-execution with the exit code observed live — no separate
      committed artifact is required.
- [ ] `tools/verify/cold_clone.sh verify-all` exits 0 from a pristine clone of
      committed HEAD in a scratch dir with scrubbed env; transcript committed as
      `evidence/cold-clone-verify-all.txt` and the SHA it prints matches the claimed
      commit.
- [ ] Sensitivity (greenwash): with `|| true` planted inside a recipe line of the
      Makefile marker section, `tools/verify/self_check.sh` exits **nonzero** naming
      the offending line; same red result for a planted `continue-on-error` in a
      `.github/workflows/*.yml` file and a planted `-`-prefixed recipe line inside
      the marker section. Transcript: `evidence/sensitivity-selfcheck.txt`. The
      working tree after capture is clean (`git status --porcelain` empty of plants).
- [ ] Sensitivity (coverage): with any one task readme's frontmatter flipped to
      `status: implemented` and no matching `verify-<id>` target, both
      `make verify-list` and `tools/verify/self_check.sh` exit **nonzero** naming that
      task id. Transcript: `evidence/sensitivity-coverage.txt`.
- [ ] Loud-skip contract holds: a recipe whose infra is absent (e.g. `make _v-web`
      today) prints `SKIPPED: <reason>` and exits nonzero;
      `VERIFY_ALLOW_SKIP=1 make _v-web` exits 0 but still prints the `SKIPPED:` line.
      Transcript: `evidence/loud-skip.txt`, capturing both runs with their observed
      exit codes (`echo $?` after each).
- [ ] Removing either marker comment (`# --- Adversarial-verification tooling ---` or
      `# --- end verify section ---`) makes `self_check.sh` exit nonzero with its
      "would be blind" message (captured in `evidence/sensitivity-selfcheck.txt`,
      plant reverted).
- [ ] `evidence/replay-preflight.txt` exists, contains a dated
      `tools/replay/preflight.sh` run from this machine, and the Verification log
      claim carries `Replay: N/A (no browser surface until Epic 3)` with stream-layer
      evidence named as the mitigation.
- [ ] All standard gates green at the claimed commit: `pnpm format:check && pnpm lint
      && pnpm typecheck && pnpm test && pnpm build` each exit 0. Evidence:
      `evidence/cold-clone-verify-all.txt` (the cold-clone `verify-all` run already
      exercises every one of these gates via `verify-E0-T01` at pristine committed
      HEAD) plus critic re-execution with exit codes observed live — no separate
      committed artifact is required for this criterion.

## Adversarial verification

The deliverable **is** a measuring apparatus, so the critic's job is to refute the
apparatus, not the code it will later measure. Run every plant with your own edits —
never replay the builder's transcripts as proof; transcripts are claims about runs,
and you re-earn each one.

1. **Re-run every sensitivity plant yourself, from scratch.** In a disposable worktree
   (`git worktree add`), plant `|| true` at a recipe line of *your* choosing inside the
   marker section — pick a different line than the builder's transcript shows — and run
   `tools/verify/self_check.sh`. A green run refutes the entire apparatus and the task.
   Repeat for `continue-on-error` in a workflow file, a `-`-prefixed recipe line, and a
   `|| true` inside `tools/verify/cold_clone.sh` itself (the scripts are declared verify
   path — the scanner must catch escapes in them too, excluding only its own file).
2. **Obfuscated greenwash.** Try escapes the naive regex might miss:
   `||true` (no space), `|| true # justified`, `|| :`, `; exit 0` appended to a failing
   command, `VERIFY_ALLOW_SKIP=1` hardcoded inside a recipe, and moving a fake-pass
   recipe *outside* the marker section then invoking it from inside (the `web-build`
   pattern in reverse). The split between must-catch and documented-gap is frozen
   here, not left to the builder:
   - **MUST go red** (a green run on any of these is a refutation): `||true` and
     `|| true # justified` (both matched by the existing
     `\|\|[[:space:]]*true` regex — a comment suffix does not hide the pattern),
     `|| :`, `; exit 0` appended to a command inside the marker section, and a
     hardcoded `VERIFY_ALLOW_SKIP=1` inside a recipe of the marker section. The
     scanner must grow to catch these if it does not already.
   - **May be documented as out of contract** (only this one): the
     out-of-section fake-pass recipe invoked from inside the marker section — if
     the scanner does not catch it, the gap must be explicitly documented in
     `tools/verify/self_check.sh`'s comments, and angle 7's byte-for-byte contract
     audit still applies.
   Any silent pass in the must-catch list, and any undocumented silent pass in the
   documented-gap slot, is a refutation — file the exact planted diff in the
   Verification log.
3. **Coverage-rule differential.** Flip a *pending* task to `implemented` (no target):
   both `verify-list` and `self_check.sh` must go red naming the id. Then add a decoy
   target `verify-E9-T99:` with no matching task folder and confirm nothing crashes and
   `verify-list` doesn't silently credit it to anything. Then create a malformed task
   folder (`E0-Txx-bad/` with no readme, or a readme with no `status:` line) and
   confirm the scripts fail loudly or skip it by documented rule rather than erroring
   into a false green.
4. **Cold-start / env sabotage.** Run `tools/verify/cold_clone.sh verify-all` yourself.
   Then rerun with a poisoned caller environment: `NODE_OPTIONS='--require /dev/null/x'
   NODE_ENV=production npm_config_registry=http://127.0.0.1:1 tools/verify/cold_clone.sh
   verify-all` and with a fake `node`/`pnpm` shim prepended to PATH that exits 1. The
   scrub contract says all of these must still pass (scrubbed/outranked). Any failure
   that traces to inherited env refutes the scrub; any pass that traces to the *shim
   having executed* refutes the PATH protection. Also confirm the clone is of committed
   HEAD: make an uncommitted breaking edit to the Makefile in the working tree and
   verify cold_clone still passes (it must not see the dirty tree).
5. **Loud-skip bypass hunt.** Grep the marker section for any recipe that can return 0
   without either really running its check or printing `SKIPPED:`. Exercise
   `VERIFY_ALLOW_SKIP=1` on each skipping recipe and confirm the `SKIPPED:` line still
   prints (a skip that goes silent under the override violates the frozen contract).
   Confirm `_v-replay-determinism` / `_v-convergence` / `_v-e2e` still **fail red** (not
   skip) when their guard dirs are faked into existence (`mkdir -p packages/cli` in a
   scratch clone) — the "refuse to fake a pass" branch must be live, not decorative.
6. **Transcript authenticity.** For every committed `evidence/*.txt`: re-execute the
   command it claims and compare shape and exit codes. A transcript whose red run you
   cannot reproduce (after applying the same plant) is fabricated evidence and refutes
   the task outright. Confirm no plant leaked into the committed tree:
   `git grep -nE '\|\|[[:space:]]*true|continue-on-error' -- Makefile tools .github ':!*.md'`
   returns hits in `tools/verify/self_check.sh` **only** (its own detector and comment
   lines — verified to be the exact hit set at the freezing of this spec); any hit in
   any other file is a leaked plant. (Documentation prose such as
   `tools/verify/runbook.md` is excluded by the `:!*.md` pathspec by rule, not by
   charity — doc files are not verify path.)
7. **Frozen-contract audit.** Diff the Makefile marker section and
   `tools/verify/*.sh` against the contracts stated in this readme (recipe names,
   coverage rule text, skip helper semantics). Any drift between the stated frozen
   contract and the shipped code — either direction — is a finding; the contract text
   and the code must agree byte-for-byte on the rules future tasks will build against.

Refutation currency here is a **planted diff + a transcript showing green where red was
contracted** (or red where green was contracted), cited by file:line. No Replay
recordings apply (`Replay: N/A (no browser surface until Epic 3)`); no event-log
offsets exist yet — the stream-layer evidence for this task is the transcripts plus
exit codes, and their reproducibility is the whole game.

## Verification log

(appended over time by builders and critics)
