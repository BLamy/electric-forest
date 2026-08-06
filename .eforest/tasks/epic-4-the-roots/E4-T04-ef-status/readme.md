---
id: E4-T04
epic: 4
title: "ef status: classify the working tree against the .ef/ base ledger plus ahead/behind vs the branch head, deterministic with frozen --json output"
priority: 404
status: implemented
depends_on: [E4-T03]
estimate: M
capstone: false
---

## Goal

`ef status [--json] [--offline]` exists in `packages/cli` and is the **instrument** the
rest of Epic 4 reads: it classifies every path in the working tree against the `.ef/`
base ledger frozen by E4-T01 into exactly one of `modified` / `added` / `deleted` /
`clean` (content-based: byte SHA-256 against the ledger's recorded `contentSha256` —
never mtime, never size alone), computes the working-tree digest via E4-T01's
`ef tree-digest` apparatus, probes the branch stream head through the E0 client, and
reports the checkpoint-vs-head relationship — `behindBy: N` (exact event count between
the saved checkpoint offset and the head), `up-to-date`, and local dirtiness (unpushed
working-tree changes; the uplink that pushes them is E4-T06). Output ordering is
deterministic (path arrays sorted lexicographically by UTF-8 byte order, never
locale-dependent), and the `--json` schema is **frozen here and versioned**
(`STATUS_JSON_VERSION = 1`): `--json` mode prints exactly one canonical-JSON line
(`@eforest/protocol` canonical encoding — sorted keys) on stdout and nothing else, exit 0
whenever a report is produced (clean or dirty alike), nonzero with stdout empty and a
stderr diagnostic on any failure. `ef status` is strictly **read-only**: it never
dispatches, never appends, never mutates `.ef/` or the working tree. The sync engines
(E4-T06/T07), the two-machine harness (E4-T09), offline catch-up (E4-T10), and every
Epic-4 critic consume this JSON as their measuring apparatus, so its sensitivity —
one changed byte in one file flips exactly that one path to `modified` — is a
non-negotiable property proven by committed checks, not asserted.

## Context

Epic 4 is the CLI + local sync (ROADMAP.md, "Epic 4 — the-roots"). E4-T01 froze the
`.ef/` workspace format — the base ledger (the tree state as materialized: per-path
`contentSha256` + size) and the checkpoint (branch stream id + exact offset) — plus
`ef tree-digest` with byte-parity to the stream-fs tree digest. E4-T03's `ef clone`
materializes a branch stream into a fresh directory with that checkpoint written. This
task turns those frozen artifacts into the question every subsequent task asks
constantly: *what differs, and who is ahead?* E4-T05's dirty-tree protection refuses
`ef checkout` when status is dirty; E4-T06 uplinks exactly the paths status calls
modified/added/deleted; E4-T07/T10 decide catch-up work from `behindBy`; E4-T09's
convergence assertions are "both machines' `ef status --json` report `clean: true` with
equal digests." An instrument that lies — misses a same-size content change, flips a path
that didn't change, reports a stale head — silently voids all of it, which is why the
adversarial section below treats a failed sensitivity probe as refuting the apparatus,
not as a bug.

Contract frozen here — the `--json` schema, `STATUS_JSON_VERSION = 1`, documented
verbatim in the `packages/cli` readme with the invalidation rule (any field addition,
removal, rename, or semantic change requires a version bump plus regeneration of every
status golden in the repo — a loud, deliberate event):

```json
{
  "v": 1,
  "branch": "<branch name from .ef/>",
  "streamId": "<branch stream id from .ef/>",
  "checkpointOffset": "<saved offset from .ef/>",
  "headOffset": "<server head offset, null under --offline>",
  "behindBy": 0,
  "clean": true,
  "baseTreeDigest": "<sha256 of the .ef/ base ledger tree>",
  "workingTreeDigest": "<sha256 via the E4-T01 tree-digest recipe>",
  "paths": { "added": [], "deleted": [], "modified": [] }
}
```

Semantics pinned here: `behindBy` is the exact count of events on the branch stream
after `checkpointOffset` (`null` under `--offline`); `baseTreeDigest` is the E4-T01
worktree-digest function applied to the base ledger projected to
path → `{ contentSha256, size }` — the ledger's `base` (content revision) field is
**dropped** from the projection — i.e. the identical recipe that produces
`workingTreeDigest`, so the clean-case equality below holds by shared code path, not by
coincidence; `clean` is true iff all three
`paths` arrays are empty, and when clean `workingTreeDigest === baseTreeDigest` by
construction of the E4-T01 apparatus; `paths` values are workspace-root-relative,
`/`-separated, each array sorted by UTF-8 byte order; `.ef/` itself is never classified;
a rename appears as one `deleted` plus one `added` entry (no rename detection in v1);
an mtime-only touch with identical bytes is `clean`. `ef status` must work from any
subdirectory of the workspace (walk up to `.ef/`), with output identical to running at
the root. The human (no `--json`) output is deliberately **not** frozen — machine
consumers must use `--json`, and the readme says so. A missing `.ef/`, or a ledger that
falls into one of E4-T01's frozen typed-refusal classes (truncated bytes, malformed
JSON, missing/unknown `v`, schema-violating field, duplicate ledger key), is a nonzero
exit with a diagnostic, never a confident report over garbage. **Pinned corollary of
the E4-T01 contract:** the ledger format has no self-integrity checksum, so a
corruption that leaves the ledger valid canonical JSON and schema-conformant (e.g. a
flipped hex character inside a `contentSha256`, or an altered `size` digit) is by
contract a *different but valid* ledger — `load()` MUST accept it, and `ef status`
honestly reports the working tree against it (the affected path shows as `modified` or
`clean` per the altered ledger, exit 0). That is correct behavior, not an error path.
An unreachable server without `--offline` is likewise a nonzero exit with a typed
diagnostic and empty stdout, and the head probe is time-bounded: it must fail within
**10 seconds** of an unreachable or stopped server (the bound is part of the frozen
contract and documented in the package readme alongside the exit codes).

Non-goals: pushing/pulling the differences (E4-T06/T07), dirty-tree enforcement at
checkout (E4-T05), conflict classification (E4-T11), ignore files / exclusion rules
(everything under the root except `.ef/` is tracked, per the E4-T01 tree rules), rename
detection, and "ahead by N" in event terms — local dirtiness is reported as the `paths`
classification, since local changes are not events until E4-T06 makes them so.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T04-ef-status/`. The Makefile recipe must reference
them repo-root-anchored (e.g. via `$(CURDIR)`) so it passes from any cwd.

- `packages/cli/src/status.ts` (or the package's established command layout) — the
  `ef status` subcommand: `--json`, `--offline`, workspace-root discovery by upward
  walk, read-only by construction.
- `packages/cli/src/classify.ts` — `classifyWorkingTree(rootDir, ledger)`: the pure
  classification core (deterministic over its inputs; no clock, RNG, env, or network),
  returning the sorted `{ added, deleted, modified }` sets, unit-testable without a
  server.
- `STATUS_JSON_VERSION = 1` exported from `packages/cli`; the schema, field semantics,
  ordering rules, exit-code contract, and golden-invalidation rule documented in the
  package readme exactly as quoted in Context.
- Head probe through the E0 official-client adapter only — no append-capable call
  anywhere in the status path.
- Committed golden fixtures, produced by a committed, deterministic scripted mutation
  sequence:
  - `evidence/golden-status/script.ts` (or `.sh`) — from a fresh server data dir:
    seed a repo, `ef clone` into a scratch workspace, then a scripted sequence of
    local mutations and stream appends — at minimum: pristine clone; modify one file
    in place preserving size; append bytes to another; create a new file (including a
    unicode-NFC nested path); delete a file; mtime-only touch; dispatch K events to
    the branch stream so the checkpoint falls behind — running `ef status --json`
    after each step.
  - `evidence/golden-status/NN-<step>.json` — one frozen transcript per step,
    committed once, never regenerated by any check that consumes them.
  - `evidence/golden-status/normalize.map` — the explicit placeholder map for
    volatile identifiers (the run's `streamId`; offsets **iff** the E0 offset scheme
    is nondeterministic for a scripted append sequence — determined and documented
    here at build time, with the finding recorded in the package readme). `behindBy`,
    `clean`, both digests, and all three `paths` arrays are compared **byte-exact,
    never normalized** — the map is itself a frozen fixture the critic audits.
- `Makefile`: `verify-E4-T04` inside the marker section composing the frozen helper
  recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus: (a) replay the
  scripted sequence against a fresh server data dir and compare every step's
  `ef status --json` output to its committed golden after applying `normalize.map`,
  failing nonzero on any difference; (b) the sensitivity step — flip one byte
  in-place (size preserved) in one file of the cloned workspace, run `ef status
  --json`, assert exactly that one path appears in `modified` with the other arrays
  unchanged and `clean: false`, restore the byte, assert `clean: true` again, and
  print `SENSITIVITY path=<p> flipped-to-modified OK` only after observing both
  assertions; (c) a determinism step — two `ef status --json` invocations as separate
  processes, outputs byte-identical (`diff` empty). Joins `verify-all`;
  `tools/verify/self_check.sh` still passes.
- Tests in `packages/cli/test/`: unit tests for `classifyWorkingTree` (every class,
  ordering, unicode paths, empty file, rename-as-add+delete, mtime-only clean);
  integration tests against a real `packages/server` on an ephemeral port covering
  the behind-by count, `--offline` nulls, the read-only proof, and every error path
  (missing `.ef/`, a ledger in each E4-T01 typed refusal class, unreachable server,
  unknown flag).

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E4-T04` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E4-T04 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Golden transcripts: replaying `evidence/golden-status/script.ts` from a fresh
      server data dir yields, at every step, `ef status --json` output byte-identical
      to the committed `NN-<step>.json` after applying `normalize.map` — where
      `behindBy`, `clean`, `baseTreeDigest`, `workingTreeDigest`, and all `paths`
      arrays are compared byte-exact with no normalization. Evidence: the in-target
      comparison plus the transcripts committed under `evidence/golden-status/`.
- [ ] Fresh-clone clean: `ef clone` (E4-T03) into a scratch dir followed immediately by
      `ef status --json` reports `clean: true`, all three `paths` arrays empty,
      `behindBy: 0`, and `workingTreeDigest === baseTreeDigest ===` the tree digest
      recorded at the E4-T03 checkpoint — evidence: committed integration test plus the
      pristine-clone golden transcript.
- [ ] Sensitivity: flipping one byte in-place (size preserved) of one file makes
      `ef status --json` report exactly that path in `modified` — no other array
      changes — with `clean: false` and a changed `workingTreeDigest`; restoring the
      byte returns `clean: true` with the original digest. The verify target prints
      `^SENSITIVITY path=.* flipped-to-modified OK$` at least once — evidence:
      `make verify-E4-T04 2>&1 | grep -c '^SENSITIVITY .* flipped-to-modified OK$'`
      ≥ 1, plus a committed test asserting the same for an appended-byte and a
      truncated-file mutation.
- [ ] Behind-by exactness: after clone, dispatching K scripted events to the branch
      stream (for at least two distinct K, one of them > 1) makes `ef status --json`
      report `behindBy` exactly K and a `headOffset` equal to the server head
      independently observed through a separate official-client read — evidence:
      committed integration test.
- [ ] mtime-only honesty: touching a file's mtime without changing bytes leaves
      `ef status --json` byte-identical to the pre-touch output (still `clean: true`) —
      evidence: committed test.
- [ ] Determinism and cwd-independence: two fresh-process `ef status --json` runs are
      byte-identical; identical under `TZ=Pacific/Kiritimati LANG=C` vs default env;
      identical when run from the workspace root and from a nested subdirectory (paths
      workspace-root-relative in both) — evidence: committed test plus both env
      transcripts under `evidence/`.
- [ ] stdout purity: in `--json` mode stdout is exactly one canonical-JSON line
      (terminated by a single `\n`, sorted keys, parseable, `v: 1`); on every error
      path (missing `.ef/`; a ledger corrupted into each of E4-T01's typed refusal
      classes — truncated bytes, malformed JSON, unknown `v`, schema-violating field,
      duplicate ledger key; unreachable server without `--offline`, failing within the
      documented 10-second bound; unknown flag) exit is nonzero, stdout is exactly
      0 bytes, and stderr carries a diagnostic — evidence: committed tests asserting
      exit code, `stdout.length`, and a stderr pattern for each case.
- [ ] Read-only proof: a committed test hashes the entire `.ef/` directory and the
      working tree before and after `ef status` (both modes) and asserts byte-identity,
      and asserts the branch stream's head offset is identical before and after (status
      appended nothing) — evidence: the test, green under `pnpm test`.
- [ ] `--offline`: with one in-place byte-flip, one created file, and one deleted file
      staged before the server is stopped, `ef status --json --offline` exits 0 with
      `headOffset: null`, `behindBy: null`, and `paths.modified` / `paths.added` /
      `paths.deleted` each containing exactly that one staged path — with the entire
      `paths` object, `baseTreeDigest`, and `workingTreeDigest` byte-identical to the
      same command run online before the server stopped; the same command without
      `--offline` exits nonzero with stdout empty — evidence: committed integration
      test asserting the byte comparison.
- [ ] `STATUS_JSON_VERSION = 1` is exported and the package readme documents the frozen
      schema, field semantics, ordering, exit codes, and the golden-invalidation rule —
      evidence: the committed files.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` shows `verify-E4-T04` mapped to this task; `verify-all`
      (every E0–E3 target and the earlier E4 targets) still green.
- [ ] Replay browser layer: N/A (CLI-only surface; no browser-reaching behavior) — the
      Verification log entry must declare this explicitly per AGENTS.md; stream-layer
      evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that `ef status` is a trustworthy instrument. Everything
later in Epic 4 reads this JSON, so a lying status voids the epic — attack it as the
apparatus it claims to be. Use your own workspaces, files, and byte offsets, never the
builder's. Any single success refutes.

1. **Sensitivity, your own bytes (mandatory).** Clone a workspace yourself and sweep
   your own mutations: (a) flip one byte mid-file with size preserved, (b) append one
   byte, (c) truncate by one byte, (d) replace a file's content with different bytes of
   identical length AND identical mtime (set it back with `touch -t`), (e) create an
   empty file, (f) delete a file, (g) rename a file, (h) an mtime-only touch. Contract:
   (a)–(f) each flip **exactly** the touched path into the correct class with every
   other array unchanged; (g) yields exactly one `deleted` plus one `added`; (h) leaves
   the output byte-identical. Refutation: any content change status misses (a size- and
   mtime-preserving change that stays `clean` proves the classifier trusts metadata —
   file that as a refutation of the apparatus, not a bug), any untouched path that
   flips, or any (h) that dirties. Cross-check `workingTreeDigest` against your own
   `ef tree-digest` run at each step — disagreement between the two mouths refutes.
2. **Behind-by honesty.** Drive the branch stream yourself: after a clone, dispatch N
   events of your choosing and compare `behindBy` / `headOffset` against your own
   independent official-client probe. For quiescent runs, refutation is `headOffset` != your probed
   head or `behindBy` != `headOffset - checkpointOffset` (in events). For runs with
   events landing *while* status executes, `headOffset` must be a head the server
   actually held at some instant during the status invocation: record the head via
   official-client reads immediately before and immediately after the run — refutation is
   `headOffset` < the pre-run head, `headOffset` > the post-run head, or `behindBy`
   inconsistent with the `headOffset` status itself reported (`behindBy` !=
   `headOffset - checkpointOffset` in events). Also refuting: `--offline` output that
   fabricates a `headOffset` instead of `null`. Then stop
   the server mid-probe: no exit within the documented 10-second head-probe bound (a
   stopwatch check, not a judgment call), an exit 0 with partial JSON, or any bytes on
   stdout alongside the nonzero exit refutes the error contract.
3. **Read-only or refuted.** Hash `.ef/` and the working tree before/after status runs
   (both modes, plus every error path — a failing status must also mutate nothing), and
   diff the server's event log dump before/after. Any byte of difference refutes. Then
   read the diff: any import of an append-capable client surface (check against
   `packages/client`'s `APPEND_SURFACE` manifest) reachable from the status code path
   refutes the read-only claim regardless of whether tests catch it.
4. **Self-licking goldens and the normalization laundry.** Delete a
   `NN-<step>.json` transcript and run `make verify-E4-T04` — it must fail red, not
   regenerate-and-pass; inspect git history and the recipe for any path that rewrites
   transcripts at check time. Then audit `normalize.map` line by line: it may touch
   only the volatile identifiers documented in the readme. A map entry that normalizes
   a digest, a `paths` array, `behindBy`, or `clean` is laundering differences and
   refutes the golden gate outright. Re-derive one transcript independently: run the
   scripted sequence yourself from a fresh data dir and confirm your output matches the
   committed golden under the same map.
5. **Frozen-schema sabotage.** In a scratch worktree, rename one JSON field, reorder
   the canonical encoding, or add an extra field — `pnpm test` and `make verify-E4-T04`
   must both go red (the goldens must pin the schema, not just the values). Separately
   sabotage the classifier three ways: compare by size only, drop the `deleted` class,
   sort `paths` with a locale-dependent comparator — each must turn the suite red. Any
   sabotage that stays green refutes whichever gate it slipped past. Check the diff for
   `.skip`/`.todo`/inline lint disables while there.
6. **Fuzz the workspace and the ledger.** Corrupt `.ef/` yourself: drive the base
   ledger into each of E4-T01's typed refusal classes (truncate its bytes, malform the
   JSON, set an unknown `v`, violate a field's schema, duplicate a ledger key),
   truncate the checkpoint, delete `.ef/` entirely, plant a `.ef/` in a
   subdirectory below a valid root (the upward walk must bind to the nearest root and
   the docs must say which). Byte-flip discipline: a single flipped byte refutes via
   this angle **only if** it lands the ledger in an E4-T01 refusal class (e.g. breaks
   the JSON syntax); a flip that leaves the ledger valid canonical JSON and
   schema-conformant (inside a `contentSha256` hex string, a `size` digit) produces a
   different-but-valid ledger per the Context corollary — status accepting it and
   reporting the affected path as `modified`/`clean` against the altered ledger with
   exit 0 is the contract, not a refutation (verify that the report is in fact
   consistent with the altered ledger; an *inconsistent* report still refutes). Feed
   hostile trees: a file named with combining
   characters, the NFD form of an NFC ledger path, a 10k-deep nesting, a 0-byte file,
   a file that is a directory in the ledger (or vice versa if the E4-T01 tree rules
   admit it). Refutation: any refusal-class input that yields exit 0 with a report,
   any crash without a diagnostic, or any hostile-but-valid tree misclassified.
7. **Determinism, environmentally.** Run status under `TZ=Pacific/Kiritimati LANG=C`
   vs defaults, from root vs nested cwd, twice in fresh processes — all byte-identical.
   Sort-order trap: create files whose names order differently under locale collation
   vs UTF-8 bytes (e.g. `a`, `B`, `ä`) and confirm the arrays are byte-ordered.
   Refutation: any environment- or cwd-dependent byte in `--json` output.
8. **Cold clone.** Run the acceptance commands only via `tools/verify/cold_clone.sh`
   with `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*` scrubbed. Grep the diff for env reads,
   `Intl`/`toLocaleString`, and absolute paths leaking into output. "Works on the
   builder's machine" is a refutation.
9. **Coverage.** Hold the claimed final run against the diff: every classification
   class, `--offline`, every error path, the upward walk, the behind-by probe, and the
   read-only guarantee must each have been executed by a committed test or a cited
   transcript. Unexecuted diff is unproven or dead — builder picks which, you enforce
   it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your own sensitivity-sweep mutations as committed test cases, and
any hostile tree or corrupt-`.ef/` input that found interesting surface into the test
corpus.

## Verification log

### 2026-08-06 — builder — IMPLEMENTED

- Commit `a704496635adbb3030279a253c018d5faf038e1d` adds `ef status [--json]
  [--offline]`, the pure UTF-8/content-SHA classifier, the frozen `v: 1` schema,
  official-client head probe, committed goldens, sensitivity check, and the
  `verify-E4-T04` target.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `CI=true pnpm test`
  (50 files / 526 tests), and `pnpm build` all passed. The focused status suite
  passed 9 tests. The complete `make --no-print-directory verify-E4-T04` target
  passed, including E4-T03's provider/clone/auth prerequisite, `verify-list`, and
  `tools/verify/self_check.sh`, ending with `verify-E4-T04: OK`.
- Stream-layer evidence: `evidence/golden-status/script.sh` starts the published
  `@durable-streams/server` `0.3.8` in file-backed mode with a fresh data directory,
  seeds real StreamFS records, invokes the built `ef clone` process, and compares
  seven status JSON transcripts against the committed fixtures. The pristine and
  mtime-clean digest is
  `85676c3436dd66e2fe7ba9c48e90bea1a5abaa5e3c40d7f42054f1ae7560ddac`; after the
  clone checkpoint `0000000000000000_0000000000000004`, two appended application
  events produce head `0000000000000000_0000000000000006` and `behindBy: 2`.
  `evidence/golden-status/sensitivity.sh` flips one byte and prints
  `SENSITIVITY path=README.md flipped-to-modified OK`; the check compares every
  digest, path array, `clean`, and offset byte-for-byte and performs no regeneration.
- The status path imports only `StreamReader` from `@eforest/client` and uses no
  append-capable operation. The stopped-server test proves online refusal and
  offline equivalence, while the read-only assertions keep `.ef/`, the worktree,
  and the branch stream unchanged. `pnpm view @durable-streams/server version`
  reports `0.3.8`; no additional provider fork is needed for this status read path.
- Replay: N/A (CLI-only surface; no browser-reaching behavior) + mitigation:
  published-server file-backed goldens, official-client integration tests, frozen
  canonical transcripts, and the composed stream-layer verification target above.
- Transcript: `evidence/e4-t04-transcript.txt`.
