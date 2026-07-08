---
id: E0-T01
epic: 0
title: "pnpm workspace bootstrap: TypeScript monorepo with real format/lint/typecheck/test/build gates"
priority: 1
status: pending
depends_on: []
estimate: M
capstone: false
---

## Goal

The repo is a TypeScript pnpm workspace whose five cheap gates are live, not skipped: a
root `package.json` (private, `packageManager: pnpm@<pinned>`) defines `format:check`,
`format`, `lint`, `typecheck`, `test`, and `build` scripts that run real tools (Prettier,
ESLint flat config, `tsc --noEmit` via a shared `tsconfig.base.json`, Vitest, `tsc`
build) across every package matched by `pnpm-workspace.yaml` (`packages/*`). A seed
package `packages/seed` (`@eforest/seed`) contains at least one exported function and one
real Vitest test exercising it, so every gate has genuine work to do. Because
`package.json` now exists, the Makefile's `_v-fmt`/`_v-lint`/`_v-typecheck`/`_v-test`/
`_v-build` guards stop printing `SKIPPED` and start executing the real commands, and a
new `verify-E0-T01` target — composed from those shared `_v-*` recipes by name, per the
contract in the Makefile's verify section — exits 0 on a clean tree and nonzero the
moment any single gate is violated. `tools/verify/self_check.sh` (`_v-meta`) still
passes, and `make verify-E0-T01` passes from a cold clone via
`tools/verify/cold_clone.sh`.

## Context

Everything in Epic 0 and beyond flows through the gauntlet in `AGENTS.md`
(`pnpm format:check && pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`), and
the Makefile's verify section was written ahead of time with runtime guards that skip
loudly while no workspace exists — every `_v-*` TypeScript gate currently prints
`SKIPPED: no package.json yet (E0-T01)` and exits nonzero. This task is the moment those
guards flip from loud skips to live gates. It is depended on (directly or transitively)
by every other E0 task: E0-T02 freezes the verify-spine contract on top of it, and
E0-T03..E0-T11 all build packages inside the workspace it creates.

Two contracts matter here:

- **Gate reality over gate greenness.** Per the Makefile header and `AGENTS.md`, no
  recipe may fake a pass. The tool configs this task lands must make violations
  *detectable*: Prettier must actually cover the source tree, ESLint must have real rules
  enabled across all workspace packages, `tsc --noEmit` must include every package's
  sources, and Vitest must fail on an empty suite (no `passWithNoTests`). A green gate
  that cannot go red is a refuted gate.
- **Composition by name.** `verify-E0-T01` composes the shared `_v-fmt` `_v-lint`
  `_v-typecheck` `_v-test` `_v-build` recipes as prerequisites, joins `verify-all`'s
  prerequisites, and is listed by `make verify-list`. The exact five-prerequisite line in
  the Deliverables below is the sole normative form. Note: the example sketched in the
  Makefile's per-task-targets comment is **stale** — it omits `_v-build`, which is
  required here; this task's diff must also correct that Makefile comment to include
  `_v-build`. The recipes themselves are frozen by E0-T02; this task must not duplicate
  their commands inline.

Tooling choices (Prettier + ESLint flat config + Vitest + tsc project layout) are frozen
here for the whole repo; later tasks add packages under `packages/*` and inherit the
gates without touching config.

## Deliverables

- `package.json` (root): private, pinned `packageManager`, scripts `format:check`,
  `format`, `lint`, `typecheck`, `test`, `build` — each invoking the real tool across the
  workspace (recursive or root-level as appropriate), none a no-op or `echo`.
- `pnpm-workspace.yaml` matching `packages/*`.
- `pnpm-lock.yaml` committed, so a cold clone installs deterministically
  (`pnpm install --frozen-lockfile` works).
- `tsconfig.base.json` (strict: `strict: true`, `noUncheckedIndexedAccess` or stricter)
  plus per-package `tsconfig.json` extending it; `typecheck` runs `tsc --noEmit` over
  every workspace package.
- Prettier config + `.prettierignore` (ignoring only build outputs/lockfiles, not
  sources); ESLint flat config (`eslint.config.*`) applying the typescript-eslint
  `recommended` ruleset or stricter to all `packages/*` sources — the red-lint
  transcript below must show a rule from that set firing.
- Vitest config with no `passWithNoTests`; an empty suite is a failure.
- `packages/seed/` (`@eforest/seed`): `src/` with at least one exported function with at
  least two distinct behaviors (e.g. a branch or input-dependent result), each behavior
  asserted with exact expected values in the package's Vitest tests; a `build` producing
  `dist/`.
- `.gitignore` updates (`node_modules/`, `dist/`, task `work/` folders if not already
  covered).
- Makefile: `verify-E0-T01` target inside the verify section, composed as
  `verify-E0-T01: _v-fmt _v-lint _v-typecheck _v-test _v-build` (plus its OK echo),
  added to `verify-all`'s prerequisites; `tools/verify/self_check.sh` and
  `tools/verify/list.sh` still pass.
- `evidence/` transcripts (committed): cold-clone green run, and one red run per gate
  from the sensitivity proof below, each showing the injected violation, the failing
  command, and the nonzero exit.

## Acceptance criteria

- [ ] `bash tools/verify/cold_clone.sh verify-E0-T01` (that literal command, no
      substitute procedure) exits 0. `cold_clone.sh` runs the make target *inside* an
      ephemeral clone with no separate install step, so `verify-E0-T01` must gain an
      `_v-install`-style prerequisite whose recipe runs `pnpm install --frozen-lockfile`
      when `node_modules` is absent (or otherwise perform that install from within the
      target itself); this is the sanctioned place for the frozen-lockfile install — do
      **not** edit `tools/verify/cold_clone.sh` to add one (any such edit is a finding
      under adversarial angle 6, no reason pre-stated here). The transcript at
      `evidence/cold-clone-green.txt` must show a fresh `git clone` into a scratch dir
      and explicit unsetting of `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*`.
- [ ] `make verify-E0-T01` runs the real `_v-fmt` `_v-lint` `_v-typecheck` `_v-test`
      `_v-build` recipes — `evidence/cold-clone-green.txt` (the same transcript as the
      bullet above) contains the actual tool invocation lines (prettier, eslint, tsc,
      vitest) and **zero** occurrences of `SKIPPED:`.
- [ ] Sensitivity, one injected violation at a time, each restored before the next, each
      with a transcript in `evidence/` showing nonzero exit at the named gate:
      - format: mangle whitespace in a `packages/seed` source file →
        `make verify-E0-T01` fails in `_v-fmt` (`evidence/red-format.txt`);
      - lint: introduce a violation of an enabled rule (e.g. an unused variable) →
        fails in `_v-lint` (`evidence/red-lint.txt`);
      - types: assign a string where a number is required → fails in `_v-typecheck`
        (`evidence/red-type.txt`);
      - test: invert one expected value in the seed test → fails in `_v-test`
        (`evidence/red-test.txt`);
      - build: break the build without tripping `_v-typecheck` (e.g. point the seed
        package's build `tsconfig` at a nonexistent entry file, or sabotage its emit
        config so `tsc --noEmit` still passes) → fails in `_v-build`
        (`evidence/red-build.txt`).
- [ ] `pnpm test` exits nonzero when the seed package's test files are removed (no
      `passWithNoTests` escape); demonstrated in `evidence/red-empty-suite.txt`.
- [ ] `make _v-meta` (i.e. `tools/verify/self_check.sh`) exits 0 after the Makefile edit,
      and `make verify-list` exits 0 with `verify-E0-T01` listed against this task.
- [ ] No greenwash escapes in the added lines of this task's diff, checked with the
      literal command
      `git diff <bootstrap-sha>..HEAD -- ':!evidence' | grep -nE '^\+' | grep -nE '\|\| true|passWithNoTests|eslint-disable|@ts-ignore|@ts-expect-error|\.(skip|todo)\('`
      (where `<bootstrap-sha>` is the commit this task branched from), which must
      produce no matches; pre-existing lines outside the diff (e.g. the Makefile verify
      section's `|| exit 1` idioms) are out of scope. Any exception requires a stated
      reason in the Verification log.
- [ ] `packages/seed/dist/` is produced by `pnpm build` and is gitignored (not
      committed).

## Adversarial verification

The claim under attack: *these five gates are live and each one can go red.* Never trust
the committed transcripts — they prove the builder ran the injections once; you must
re-run them yourself with your own violations. A gate that stays green under your
injection refutes the apparatus regardless of what `evidence/` says.

1. **Independent sensitivity sweep.** In a scratch worktree, inject your *own* violations
   (not the builder's examples): a formatting change Prettier's config might not cover
   (e.g. in a root-level `.ts` or config file, or a `packages/seed` test file), a lint
   violation in a *test* file, a type error in a file with no test importing it, a
   failing assertion, and a build sabotage that `tsc --noEmit` cannot catch (e.g. a
   broken build tsconfig or missing entry file). For each, `make verify-E0-T01` must
   exit nonzero at the matching gate. Any injection that survives green refutes the
   task — in particular, `_v-build` wired to a no-op or a typecheck re-run instead of a
   real emit is a refutation.
2. **Coverage-glob attack.** Create a new package `packages/evil` built *minimally*: a
   `package.json` with **no** `lint`/`typecheck`/`test` scripts of its own, plus a source
   file containing a deliberate type error, a lint violation, and a failing test. Run the
   gates *without touching any config file*. All three gates must still go red. This
   refutes not only configs that enumerate `packages/seed` specifically, but also
   `pnpm -r run`-style per-package opt-in wiring where a package that omits the script is
   silently skipped by every gate — either the root gates must run tools covering
   `packages/*` globs directly, or a meta-check must fail when any workspace package
   lacks the gate scripts. If any gate stays green against the minimal `packages/evil`,
   the workspace is refuted — later E0 tasks would land packages outside the gates.
3. **Ignore-file audit.** Read `.prettierignore`, the ESLint config's `ignores`,
   `tsconfig` `include`/`exclude`, and the Vitest `include` globs. Any pattern that
   excludes source or test directories (beyond `dist/`, `node_modules/`, generated
   output) is a finding; verify empirically by placing a violation inside any ignored
   path that contains real code.
4. **Empty-suite and no-op-script hunt.** Delete all test files → `pnpm test` must fail.
   Then read every root script: any script that is an `echo`, a `true`, or a tool run
   scoped to a subset of the workspace (`--filter` hiding packages) is a refutation. Run
   each `pnpm <script>` directly and match its output against what the tool should print
   for the real file set.
5. **Cold-clone / env hunt.** Run the acceptance path via `tools/verify/cold_clone.sh`
   (pristine clone, scratch dir, `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*` scrubbed). A
   pass that depends on the builder's global installs, a warm store resolving deps absent
   from `pnpm-lock.yaml`, or an unpinned pnpm major is a refutation. Check the lockfile
   is in sync: `pnpm install --frozen-lockfile` must succeed without modification.
6. **Composition and self-check integrity.** Diff the Makefile: `verify-E0-T01` must be
   prerequisite-composed from the shared `_v-*` recipes, not inline command copies; it
   must be in `verify-all`'s prerequisites; `tools/verify/self_check.sh` must pass and
   must not have been weakened by this diff (diff the script itself — any edit to
   `tools/verify/` here needs a stated reason or is a finding). `make verify-list` must
   map `verify-E0-T01` to this task folder.
7. **Transcript freshness.** Reproduce at least one committed `evidence/red-*.txt` and
   the green run; a transcript whose failure mode you cannot reproduce (or whose tool
   output shape doesn't match the current configs) is stale evidence and fails the claim
   immediately.

Replay recordings: N/A for this task (no web app until Epic 3; nothing browser-reaching).
Evidence currency is stream-layer fallback per `AGENTS.md`: committed transcripts plus
your own re-execution.

## Verification log
