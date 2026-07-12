---
id: E0-T02
epic: 0
title: Verify spine frozen and proven sensitive — composed verify recipes, self-check, cold-clone, per-task target contract
priority: 2
status: implemented
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

### 2026-07-08 — builder — implemented

Commit: `86d0b54` (`feat: freeze E0-T02 verify spine`).

Commands:
`pnpm format:check`;
`pnpm lint`;
`pnpm typecheck`;
`pnpm test`;
`pnpm build`;
`make _v-meta`;
`make verify-E0-T02`;
`make verify-all`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`;
`make _v-web`;
`VERIFY_ALLOW_SKIP=1 make _v-web`;
`tools/replay/preflight.sh`;
scratch-clone sensitivity plants for Makefile greenwash escapes, missing marker,
workflow `continue-on-error`, and missing verify target coverage.

Evidence:
`evidence/cold-clone-verify-all.txt`;
`evidence/sensitivity-selfcheck.txt`;
`evidence/sensitivity-coverage.txt`;
`evidence/loud-skip.txt`;
`evidence/replay-preflight.txt`.

Replay: N/A (no browser surface until Epic 3; `tools/replay/preflight.sh` currently
fails authentication) + mitigation: stream-layer fallback evidence is committed as
reproducible command transcripts, including a pristine cold-clone `verify-all` run and
sensitivity plants for the verifier itself.

Claim: the verify spine is frozen for Epic 0. `verify-E0-T01` and `verify-E0-T02` live
inside the Makefile marker section, are `.PHONY`, compose shared recipes by name, and
emit the exact frozen OK lines `verify-E0-T01: OK` and `verify-E0-T02: OK`.
`verify-all` composes both task targets and ends with the frozen success line. The
self-check scanner now catches `|| true`, `|| :`, `; exit 0`, hardcoded
`VERIFY_ALLOW_SKIP=1`, workflow `continue-on-error`, missing marker comments, and make
ignore-error prefixes in the verify path; the committed sensitivity transcripts show
each planted invariant going red. `make verify-list` and `tools/verify/self_check.sh`
both go red when a task is marked `implemented` without a matching verify target, and
the loud-skip transcript proves `_v-web` is nonzero by default while
`VERIFY_ALLOW_SKIP=1` still prints `SKIPPED:`.

### 2026-07-09 — critic — VERDICT: refuted

VERDICT: refuted

- P1 Makefile greenwash sensitivity — FAILED. Predicted the independent plant
  `- then pnpm lint; \` / `+ then pnpm lint || true; \` at `Makefile:48` would
  make `bash tools/verify/self_check.sh` nonzero. Observed the frozen success banner
  and `exit=0`. The boundary after `(true|:)` in
  `tools/verify/self_check.sh:51` excludes shell's `;`, contradicting the stated
  no-`|| true` verify-path contract. Demand: catch shell separators after every
  swallowed-success form and add a permanent semicolon-terminated sensitivity case.
- P1 package-script greenwash sensitivity — FAILED. Predicted changing
  `package.json:10` from the real lint script to the same script suffixed with
  ` || true` would make the package scan red. Observed the frozen success banner and
  `exit=0`. JSON closes the script with `"`, which the same boundary at
  `tools/verify/self_check.sh:51` excludes even though
  `tools/verify/self_check.sh:108-118` claims package scripts are policed. Demand:
  scan decoded script values or admit JSON string delimiters in the detector, with a
  permanent package-script sensitivity case.
- P1 out-of-section fake-pass — FAILED. Predicted an outside `critic-fake-pass`
  target with recipe `@false || true`, depended on by `_v-lint`, would either go red or
  match the one permitted, explicitly documented gap. Observed `exit=0` and the frozen
  success banner; no gap is documented. `tools/verify/self_check.sh:80-87` only
  forbids outside targets whose own names start `_v-` or `verify-`, so an arbitrary
  helper evades it. Demand: transitively constrain verify prerequisites to the marker
  section or explicitly document the gap exactly as the task requires, then re-record.
- P1 poisoned PATH protection — FAILED. Predicted a caller PATH prefixed with fake
  executable `node` and `pnpm` shims would still pass without executing either shim.
  Observed `FAKE_PNPM_EXECUTED`, then `make: *** [_v-install] Error 98` and
  `cold_clone: verify-all FAILED (exit 2)`. At
  `tools/verify/cold_clone.sh:41-52`, `command -v` resolves tools from the already
  poisoned caller PATH and promotes that directory into `trusted`. Demand: derive the
  trusted toolchain independently of the poisoned PATH and add a permanent shim
  sensitivity test that asserts the shim is never invoked.
- Coverage/remaining attacks — PASSED or waived. Live baseline at
  `5a7f708ce9f5430f2bb7e760acfc5b973b6018e1`: `make verify-E0-T02`,
  `make verify-E0-T01`, `make verify-all`, every standard pnpm gate, pristine
  `cold_clone.sh verify-all`, poisoned NODE_OPTIONS/NODE_ENV/npm_config env, and an
  uncommitted breaking Makefile plant all passed as contracted. Independent plants
  for exact `|| true`, `||true`, `|| true # justified`, `|| :`, `; exit 0`, hardcoded
  `VERIFY_ALLOW_SKIP=1`, make `-` prefix, `continue-on-error`, a verify-script
  `|| true`, both missing markers, and missing-target coverage all went red. Decoy and
  malformed-folder behavior matched the documented task-with-readme rule. Every loud
  skip stayed visible under `VERIFY_ALLOW_SKIP=1`; fake guard directories made
  `_v-replay-determinism`, `_v-convergence`, and `_v-e2e` fail red. Committed evidence
  shapes and exit codes reproduced; the plant-leak grep hit
  `tools/verify/self_check.sh` only. Diff coverage: all changed executable branches
  were exercised above; readme/queue/transcript hunks are evidence/config and waived.
- SUITE: no promotion while P1 apparatus refutations remain. Rework all four holes,
  regenerate the committed sensitivity/cold-clone evidence at the new implementation
  commit, and submit a fresh recorded claim for a new critic session.

Commands: `make verify-E0-T02`; `make verify-E0-T01`; `make verify-all`;
`pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`;
`tools/verify/cold_clone.sh verify-all`; poisoned-env and poisoned-PATH variants of
that cold clone; all Adversarial verification plants listed above; loud-skip/guard-dir
targets; transcript leak grep; `bash -n tools/verify/*.sh tools/replay/preflight.sh`.

Replay: N/A (no browser surface until Epic 3; live
`env -u REPLAY_API_KEY tools/replay/preflight.sh` reproduced CLI/runtime/MCP
availability plus authentication
failure, `exit=1`) + mitigation: independently reproduced command transcripts and
planted verifier diffs with observed exit codes.

### 2026-07-09 — builder — reworked after refutation

Implementation commit: `e8b4c838115e97814de41d841f093b864e4fcf7d`
(`fix: harden E0-T02 verifier sensitivity`).

The four P1 findings are addressed without weakening the frozen contract. The escape
detector now admits shell semicolons and JSON string delimiters after swallowed-success
tokens, so both the critic's `pnpm lint || true;` plant and a package script ending in
`|| true` go red. `self_check.sh` now explicitly documents the one out-of-section
helper limitation the task specification permits, and the standing sensitivity script
pins that exact boundary. `cold_clone.sh` no longer trusts the first `command -v`
result from caller PATH: it uses `trusted_path.sh` to inspect candidates without
executing them and promotes the last executable node/pnpm candidate, enforcing the
frozen prepended-shim threat model. `verify-E0-T02` runs the permanent regression probes
on every invocation.

Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
`pnpm typecheck`; `pnpm test`; `pnpm build`; `make verify-E0-T02`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`; the same cold-clone run
with executable fake node/pnpm shims prepended to PATH and a write-on-execution marker;
independent missing-target coverage plant; `make _v-web`;
`VERIFY_ALLOW_SKIP=1 make _v-web`; `env -u REPLAY_API_KEY tools/replay/preflight.sh`;
`bash -n tools/verify/*.sh`.

Evidence: `evidence/cold-clone-verify-all.txt`;
`evidence/sensitivity-selfcheck.txt`; `evidence/sensitivity-coverage.txt`;
`evidence/poisoned-path.txt`; `evidence/loud-skip.txt`;
`evidence/replay-preflight.txt`.

Replay: N/A (no browser surface until Epic 3; live preflight still reports Replay CLI,
runtime, and MCP available but authentication missing) + mitigation: pristine
cold-clone stream-layer transcripts, standing sensitivity probes, and the poisoned-PATH
marker proof are committed and independently reproducible.

Claim: the verifier now fails the two previously green swallowed-success forms, records
the sole task-sanctioned lexical gap explicitly, and rejects a prepended fake toolchain
without executing it. Pristine and poisoned-PATH `verify-all` both pass at the
implementation commit, while every planted contract violation remains red.

### 2026-07-09 — critic — VERDICT: refuted

VERDICT: refuted

- P1 parenthesized shell greenwash — FAILED. Predicted adding the valid recipe line
  `@(false || true)` immediately before `_v-meta`'s real self-check would make
  `bash tools/verify/self_check.sh` and `make _v-meta` red. Observed both exit `0` and
  print the frozen success banner. The exact planted diff was
  `Makefile:103 +\t@(false || true)`; `tools/verify/self_check.sh:55` accepts only
  whitespace, `;`, `"`, comment, or end-of-line after `true`, so shell's `)` terminator
  evades the scanner while swallowing `false`. Demand: cover valid shell terminators
  (at minimum `)`) and add this independent plant to the permanent sensitivity suite.
- P1 malformed task coverage — FAILED. Predicted a task folder containing a readme with
  `id: E9-T98` and `title:` but no `status:` would either fail loudly or be skipped by a
  documented rule, as Adversarial verification angle 3 requires. Observed
  `bash tools/verify/list.sh` exit `0` with row
  `(pending)                         critic malformed task with no status`, and
  `bash tools/verify/self_check.sh` exit `0` with the frozen success banner.
  `tools/verify/list.sh:19-27` and `tools/verify/self_check.sh:33-41` silently route an
  empty status through their exempt default. Demand: validate task frontmatter and fail
  on a missing/invalid status, or explicitly document and mechanically distinguish a
  sanctioned skip rather than crediting malformed input as pending.
- Prior four P1 regressions — HELD. Independent plants showed a different Make recipe
  ending `pnpm typecheck || true;` red, a package script ending `|| true` red, and the
  arbitrary out-of-section helper green only under the exact documented gap at
  `tools/verify/self_check.sh:87-93`. Pristine `a5836f4` and poisoned
  `NODE_OPTIONS`/`NODE_ENV`/`npm_config_registry` cold clones both passed `verify-all`
  with executable fake `node`/`pnpm` shims prepended; neither shim marker was written.
- PATH contract and cold-clone authenticity — HELD. `trusted_tool_path` selected genuine
  `/opt/homebrew/bin/node` and `pnpm` with duplicate entries, leading/consecutive empty
  entries, and a prepended space-containing shim directory, and neither shim executed.
  Appending that shim directory selected the shims, exactly matching the explicit
  PREPENDED-only threat model at `tools/verify/trusted_path.sh:2-5`. A pristine clone,
  the combined poisoned env/PATH clone, and a clone launched from a working tree with
  uncommitted `_v-meta: @false` all cloned committed `a5836f4` and passed `verify-all`.
- Remaining charter and evidence authenticity — HELD. All standard pnpm gates and live
  `verify-E0-T01`, `verify-E0-T02`, and `verify-all` passed with real Prettier/Vitest
  output. Every listed greenwash plant, both marker removals, missing-target coverage,
  decoy target, no-readme folder, loud-skip bare/override pair, and fake guard-directory
  refusal reproduced. The leak grep hit `tools/verify/self_check.sh` only; every committed
  evidence transcript's command shape and exit behavior reproduced. Live Replay preflight
  again found CLI/runtime/MCP available but no authentication (`exit=1`).
- COVERAGE — COMPLETE FOR THE REWORK DIFF. The Makefile sensitivity call, both new regex
  boundaries, the documented-gap control, cold-clone trusted-PATH integration, and all
  four permanent sensitivity probes executed live. Sabotaging the detector made the
  permanent suite fail on its first formerly-missed plant; changing trusted-path choice
  from last to first candidate made it exit `97`, proving the apparatus is sensitive to
  both reworked mechanisms. Evidence/readme/comment hunks are waived as non-executable.
- SUITE: no promotion while the two apparatus refutations remain. Add permanent
  parenthesized-greenwash and malformed-frontmatter probes during rework, then regenerate
  evidence and submit to another fresh critic.

Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
`pnpm typecheck`; `pnpm test`; `pnpm build`; `make verify-E0-T01`;
`make verify-E0-T02`; `make verify-all`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`; combined poisoned-env and
prepended-shim variants of that cold clone; dirty-working-tree cold clone; independent
Makefile/package/workflow/verify-script/marker/coverage/decoy/malformed-folder plants;
all bare and `VERIFY_ALLOW_SKIP=1` skip targets; fake-guard targets; trusted-PATH
duplicate/empty/space/appended probes; permanent-suite detector/path sabotages;
`git grep -nE '\|\|[[:space:]]*true|continue-on-error' -- Makefile tools .github
':!*.md'`; `bash -n tools/verify/*.sh tools/replay/preflight.sh`;
`env -u REPLAY_API_KEY tools/replay/preflight.sh`.

Replay: N/A (no browser surface until Epic 3; live preflight is unauthenticated) +
mitigation: independently reproduced cold-clone transcripts, planted diffs, exact exit
codes, poisoned tool markers, and permanent sensitivity sabotage results.

### 2026-07-11 — builder — reworked after second refutation

Implementation commit: `bdad0588b8bfb6110655cc7ffe5ab02cde3a0379`
(`fix: close E0-T02 verifier gaps`).

The parenthesized shell terminator and malformed-frontmatter findings are fixed without
weakening prior coverage. The escape scanner now recognizes `)` after swallowed-success
tokens. Both `self_check.sh` and `list.sh` validate status against the frozen lifecycle
set and fail on missing or invalid status. Permanent probes exercise both tools against
a status-less task and exercise the exact `@(false || true)` recipe form.

Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
`pnpm typecheck`; `pnpm test`; `pnpm build`; `bash -n tools/verify/*.sh`;
`bash tools/verify/self_check_sensitivity.sh`; `make verify-E0-T02`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`.

Evidence: `evidence/cold-clone-verify-all.txt`;
`evidence/sensitivity-selfcheck.txt`; standing prior coverage, loud-skip, poisoned-PATH,
and Replay preflight evidence remains unchanged and reproduced by the composed target.

Replay: N/A (no browser surface until Epic 3) + mitigation: the pristine committed-HEAD
cold clone runs every standard gate and both permanent new sensitivity probes, with exact
red/green exit behavior recorded in the committed transcripts.

Claim: committed HEAD passes the full verify union from a pristine clone, while the two
critic plants now fail red in both the standalone permanent probe and the composed
`verify-E0-T02` target.

### 2026-07-11 — critic — VERDICT: refuted

VERDICT: refuted

- P1 shell-terminator greenwash — FAILED. Predicted two independent, valid Make recipe
  plants immediately before `_v-meta`'s real self-check, `@(false || true&)` and
  `@(false || true>/dev/null)`, would make `bash tools/verify/self_check.sh` nonzero.
  Observed the frozen success banner and `exit=0` for both. The planted diffs were
  `Makefile +\t@(false || true&)` and `Makefile +\t@(false || true>/dev/null)`; the
  terminator allowlist at `tools/verify/self_check.sh:63` recognizes `)`, but not valid
  shell `&` or redirection operators after the swallowed-success token. Demand: detect
  the forbidden `|| true` / `|| :` token independent of every valid shell suffix, and
  promote both variants (or an equivalently exhaustive boundary test) into the permanent
  sensitivity suite.
- P1 frontmatter-boundary validation — FAILED. Predicted a task readme whose YAML
  frontmatter omitted `status:` but whose narrative body contained `status: pending`
  would make both coverage tools fail loudly. Observed
  `bash tools/verify/self_check.sh` exit `0` with the frozen success banner and
  `bash tools/verify/list.sh` exit `0`, listing the malformed task as pending. Both
  tools use an unbounded whole-file `sed` at `tools/verify/self_check.sh:33` and
  `tools/verify/list.sh:19`, so body prose is accepted as frontmatter. Demand: restrict
  lifecycle-field parsing to the opening YAML frontmatter block and add permanent
  missing-frontmatter-with-body-decoy probes for both tools.
- Exact prior regressions and baseline — HELD. The builder's `@(false || true)` plant,
  exact missing-status plant, semicolon and package-JSON terminators, documented helper
  gap, and prepended-PATH probe all behaved as claimed. A pristine cold clone at
  `ed8d533cf7c7d594d82a34b460890db8384a7d95` passed `verify-all`, including real
  Prettier, ESLint, TypeScript, Vitest (3 tests), build output, both per-task OK lines,
  and the frozen final banner. An explicit invalid status (`banana`) made both tools
  nonzero and named the task.
- COVERAGE/SABOTAGE — INSUFFICIENT FOR THE NEW EDGES. Every executable hunk in
  `2ebb000..ed8d533` ran through the permanent suite and cold clone, and the existing
  `)` regression is sensitive. But the boundary-list implementation is demonstrably
  incomplete for `&` and redirection, and the status tests cover only a file with no
  status anywhere, not the claimed frontmatter boundary. Readme/evidence/queue hunks
  are waived as claim/config artifacts.
- SUITE: no promotion while the apparatus still admits these false greens. Add the two
  shell-boundary probes and the body-decoy frontmatter probe, then regenerate evidence
  and submit a fresh claim.

Commands: `make verify-E0-T02`; `tools/verify/cold_clone.sh verify-all`; independent
scratch-clone `&`-terminator and redirection-terminator plants; missing-frontmatter with
body-status decoy against both coverage tools; explicit invalid-status controls; and
`bash tools/verify/self_check_sensitivity.sh`.

Replay: N/A (no browser surface until Epic 3) + mitigation: independently reproduced
pristine cold-clone output, permanent sensitivity probes, and exact planted diffs with
observed exit codes.

### 2026-07-11 — builder — reworked after fourth refutation

Implementation commit: `b66588f52eaf063a21ef6acf533c062492f2c9c1`
(`fix: validate E0-T02 frontmatter structure`).

Both coverage tools now require a valid opening and closing frontmatter delimiter and
exactly one requested metadata key before returning a value. Duplicate lifecycle keys
and unclosed blocks therefore fail structurally instead of being credited as pending.
Permanent probes exercise both malformed forms through both tools.

Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
`pnpm typecheck`; `pnpm test`; `pnpm build`; `bash -n tools/verify/*.sh`;
`bash tools/verify/self_check_sensitivity.sh`; `make verify-E0-T02`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`.

Evidence: `evidence/cold-clone-verify-all.txt` and
`evidence/sensitivity-selfcheck.txt`, updated with the exact implementation SHA and
duplicate/unclosed-frontmatter red probes.

Replay: N/A (no browser surface until Epic 3) + mitigation: pristine committed-HEAD
standard gates plus the composed permanent sensitivity suite.

Claim: malformed duplicate or unclosed frontmatter now fails red in both coverage tools,
while the complete verify union passes from a pristine clone.

### 2026-07-11 — builder — reworked after third refutation

Implementation commit: `bc367bbf1e858727eb66b730539e5088b55d744e`
(`fix: harden E0-T02 parser boundaries`).

The greenwash boundary now recognizes shell whitespace, separators, grouping,
background/pipeline operators, and redirection operators after forbidden success tokens.
Task status and title are parsed only from the opening YAML frontmatter block. Permanent
probes reproduce both exact shell suffixes and the prose-status decoy against both tools.

Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
`pnpm typecheck`; `pnpm test`; `pnpm build`; `bash -n tools/verify/*.sh`;
`bash tools/verify/self_check_sensitivity.sh`; `make verify-E0-T02`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`.

Evidence: `evidence/cold-clone-verify-all.txt` and
`evidence/sensitivity-selfcheck.txt`, including the exact implementation SHA and new
red probes.

Replay: N/A (no browser surface until Epic 3) + mitigation: a pristine committed-HEAD
cold clone runs the standard gates, verifier union, and permanent sensitivity suite.

Claim: the two newly refuted shell suffixes and the frontmatter body-decoy now fail red,
while pristine `verify-all` passes at the implementation commit.

### 2026-07-11 — critic — VERDICT: refuted

VERDICT: refuted

- P1 malformed YAML frontmatter can exempt an implemented task — FAILED. Predicted
  both coverage tools would fail loudly for malformed task frontmatter rather than
  silently select a lifecycle value. Observed two independent false greens. Plant one
  used opening frontmatter with duplicate keys, `status: pending` followed by
  `status: implemented`; `bash tools/verify/self_check.sh` and
  `bash tools/verify/list.sh` both exited `0`, and the list credited E9-T96 as pending.
  Plant two opened with `---`, supplied `status: pending`, omitted the closing `---`,
  then placed `status: implemented` in the following prose; both tools again exited
  `0` and credited E9-T95 as pending. `frontmatter_value` at
  `tools/verify/self_check.sh:17-29` and `tools/verify/list.sh:14-26` neither proves a
  closing delimiter exists nor rejects duplicate keys, and exits after the first
  match. Demand: validate exactly one opening YAML frontmatter block with both
  delimiters and exactly one lifecycle key before using its value, and promote
  duplicate-key plus unterminated-block probes for both tools.
- Prior shell/frontmatter regressions — HELD. Predicted the exact prior
  `@(false || true&)`, `@(false || true>/dev/null)`, parenthesized, missing-status,
  and prose-body-decoy plants would now make the verifier red. The permanent
  sensitivity suite reproduced every expected nonzero result. Independent valid
  pipeline and AND-list plants, `@(false || true|cat)` and
  `@(false || true&& printf ...)`, were also detected and made self-check exit `1`.
- Baseline and environment isolation — HELD. `make verify-E0-T02` passed with the
  frozen self-check and task-list output. All five standard gates passed locally
  (Prettier, ESLint, TypeScript, 3 Vitest tests, build). A pristine committed-HEAD
  cold clone of `ae9afa61d31e3d778fc93abdb250081362d5a0ba` passed `verify-all`;
  the poisoned caller environment (`NODE_OPTIONS`, `NODE_ENV`, and
  `npm_config_registry`) also passed after scrubbing. Both runs exercised the real
  gates, permanent sensitivity probes, exact per-task OK lines, and final frozen
  banner.
- COVERAGE/SABOTAGE — INSUFFICIENT FOR FRONTMATTER STRUCTURE. All executable hunks in
  `4b9da42..ae9afa6` ran through the permanent suite and cold clone; the promoted `&`,
  redirection, and prose-decoy cases are sensitive. The new frontmatter parser hunk is
  nevertheless disproven by valid adversarial inputs the suite omits. Readme,
  evidence, and queue hunks are waived as claim/config artifacts.
- SUITE: no promotion while the apparatus is refuted. Add permanent duplicate-key and
  missing-closing-delimiter sensitivity cases, then regenerate the evidence and submit
  a fresh builder claim.

Commands: `bash tools/verify/self_check_sensitivity.sh`; `make verify-E0-T02`;
`pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`;
`env -u REPLAY_API_KEY tools/verify/cold_clone.sh verify-all`; poisoned-environment
cold clone; independent duplicate-status, unterminated-frontmatter, pipeline, and
AND-list plants against both coverage tools where applicable.

Replay: N/A (no browser surface until Epic 3) + mitigation: independently reproduced
pristine and poisoned-environment cold-clone runs, permanent sensitivity probes, and
exact malformed-frontmatter plants with observed exit codes.
