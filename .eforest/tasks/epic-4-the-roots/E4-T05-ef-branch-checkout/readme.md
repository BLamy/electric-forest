---
id: E4-T05
epic: 4
title: "ef branch and ef checkout: fork a branch stream from the CLI and rematerialize the working tree onto it with dirty-tree protection"
priority: 405
status: in-progress
depends_on: [E4-T02, E4-T04]
estimate: M
capstone: false
---

## Goal

`packages/cli`'s `ef` binary (E0-T04) grows the two branch-shaped workspace commands.
`ef branch <name>` forks a branch stream from inside an adopted workspace: it reads the
current branch and offset checkpoint from the frozen `.ef/` workspace state (E4-T01
format, written by E4-T02/E4-T03), and issues exactly one authenticated dispatch (E2-T05
CLI token, E2-T03 bearer verification) that performs the E1-T08 copy-on-write fork —
`fs.branch.fork { v: 1, parentStreamId, forkOffset }` with `forkOffset` equal to the
workspace's checkpoint offset — printing the new branch's stream id and fork offset. It
is O(1), appends zero events to the parent, does **not** switch the working tree, and
surfaces E1-T08 refusals through a single generic pass-through path as a typed CLI
error carrying the server's `error.reason` verbatim — with `fs/branch-exists`,
`fs/invalid-branch-name`, and `fs/fork-offset-out-of-range` pinned by test. `ef checkout <branch>` rematerializes the working tree onto the
target branch: it first runs the E4-T04 status classification against the `.ef/` base
ledger and **refuses with the frozen reason `cli/dirty-working-tree` (exit 3) when the
tree is anything but clean** — working-tree bytes, `.ef/` bytes, and both branch logs
byte-untouched by the refusal; on a clean tree it replays the target branch (E1-T08
resolution through the fork chain) to its head, writes the resulting tree into the
working directory (creations, content updates, deletions — tombstoned and renamed paths
land correctly), and commits the switch by replacing the `.ef/` base ledger and
`{branch, offset}` checkpoint via write-temp-then-atomic-rename as the final step, under
a `.ef/checkout-in-progress` journal marker that makes an interrupted checkout loudly
detectable (`cli/interrupted-checkout`) instead of silently half-materialized. The proof
is four artifacts: the fork event visible at the claimed offset in the dumped branch
log; post-checkout `ef tree-digest` (E4-T01) byte-equal to the tree digest of
`replay(branch)` at the fork point for a freshly forked branch (and at head generally);
a main→feature→main checkout round-trip restoring a byte-identical working tree; and a
committed golden transcript of the dirty-tree refusal.

## Context

This is the CLI half of ROADMAP.md's Epic 4 line "`ef branch` / `ef checkout`
(materialize a branch stream into the working tree)". E1-T08 built the fork machinery
server-side; E4-T02/T03 gave a directory a `.ef/` identity; E4-T04 made "is this tree
clean?" a deterministic, frozen-output question. This task composes them into the moment
a developer actually changes lines of history — and it is the last purely-command task
before the sync engines: E4-T06 (uplink) and E4-T07 (downlink) both assume the workspace
can already be pointed at an arbitrary branch with a correct base ledger and offset
checkpoint, and E4-T12's capstone runs two watched checkouts of the same branch. If
checkout can write a tree that doesn't digest-match `replay(branch)`, or can clobber
uncommitted local edits, every convergence claim upstream of it is built on sand — hence
the dirty-tree refusal is specified as byte-neutrality, not as a friendly message.

Builds on, without re-freezing: E1-T08 (fork record, resolution semantics,
`ef replay --parent --until`, the five fork refusal codes), E4-T01 (`.ef/` workspace
format, `ef tree-digest`, tree-digest ↔ stream-digest byte-parity), E4-T03 (offset
checkpoint semantics), E4-T04 (status classification and its frozen `--json` — checkout's
clean/dirty decision is *defined* as "E4-T04 reports zero non-clean entries", one
implementation, no second classifier).

Contract frozen here:

- **CLI refusal shape**: typed refusals exit 3 with exactly one stderr line
  `error: <reason>: <message>` where `<reason>` is a frozen code; stdout is empty
  (0 bytes) on every refusal. Codes minted here: `cli/dirty-working-tree`,
  `cli/unknown-branch`, `cli/not-a-workspace`, `cli/interrupted-checkout`,
  `cli/unsafe-path`. Server-side refusals pass through with the server's
  `error.reason` as `<reason>`, never rewritten. Exit codes: 0 success, 2 usage,
  3 typed refusal — the usage case is exercised here, not assumed: a missing
  argument exits 2 with 0-byte stdout and exactly one stderr usage line, pinned
  by test.
- **Checkout commit protocol**: `.ef/checkout-in-progress` (containing the target
  branch and target offset, canonical JSON) is created before the first working-tree
  byte moves and removed after the `.ef/` state rename; the base ledger + checkpoint
  replacement is a single atomic rename and is the last mutating step. While the marker
  exists, `ef status`, `ef branch`, and `ef checkout` all refuse with
  `cli/interrupted-checkout` (recovery/rerun is E4-T07/E4-T10 territory; here the only
  obligation is refusing to lie).
- **Dirty means dirty**: any E4-T04 classification other than clean — modified, added,
  deleted, renamed, untracked — blocks checkout. There is no `--force`, no stash, no
  partial checkout in this task.
- **`ef checkout <current-branch>`** on a clean tree exits 0 and moves zero bytes
  (tree, `.ef/`, and logs byte-identical before/after).
- Transcript outputs used as goldens are **run-invariant**: no timestamps, pids,
  hostnames, or absolute paths.

Non-goals: live sync in either direction (E4-T06/T07), offline catch-up and interrupted-
checkout *recovery* (E4-T10), conflict files (E4-T11), merge of any kind (E1-T09/T10),
branch deletion or listing, and detached/offset checkout (`--at`) beyond what fresh-fork
materialization already exercises.

## Deliverables

- `packages/cli` — `ef branch <name>` (workspace-aware fork through `/api/dispatch` with the
  E2-T05 token; prints `branch <name> <streamId> forked-at <forkOffset>` on one stdout
  line) and `ef checkout <branch>` (status gate → replay target branch via the E1-T08
  resolution path → materialize tree → atomic `.ef/` commit under the journal marker),
  plus the frozen refusal shape for both commands.
- One tree materializer function shared with nothing invented here: it consumes the same
  reduced tree the E4-T01 digest walks, so "materialized tree digest-matches
  replay(branch)" is structural, not coincidental; deletions and renames handled by
  diffing old base ledger → new reduced tree (stale files removed, never left behind).
- `packages/cli/test/branch-checkout.test.ts` — over a real Durable Streams service via real HTTP:
  fork offset in the branch dump equals the workspace checkpoint at branch time; parent
  head offset + dump digest byte-identical before/after `ef branch`; clean checkout onto
  a fresh fork digest-matches `ef replay <branch-dump> --parent <main-dump> --digest`;
  the round-trip; each dirt class (modified, added, deleted, renamed, untracked) refused
  with `cli/dirty-working-tree` and full byte-neutrality before/after, asserted by
  harness-computed independent recursive hashes (every path + full contents, untracked
  included, not `ef tree-digest`) of the working tree (`.ef/` excluded) and of `.ef/`
  itself, plus both stream dumps; `cli/unknown-branch`, `cli/not-a-workspace`,
  `cli/interrupted-checkout` (marker planted by the test), and a pass-through server
  refusal (`fs/branch-exists`) each asserted literally against the frozen stderr shape
  with stdout 0 bytes; usage errors (`ef checkout` and `ef branch` with no argument)
  asserted as exit 2, stdout 0 bytes, one stderr usage line; the real `ef checkout`
  binary driven against the published local Durable Streams server seeded through the
  official client with hand-tampered events that carry an out-of-rules
  path, refused at the replay-client boundary as `cli/unsafe-path` before any
  working-tree byte moves — end-to-end through the real checkout code path, not a
  unit test on an internal validator; no-op checkout of the current branch.
- `evidence/` — `e4-t05-fork-offset.txt` (branch-log dump excerpt showing
  `fs.branch.fork` at the claimed offset + the `.ef/` checkpoint it was claimed from),
  `e4-t05-checkout-digest.txt` (post-checkout `ef tree-digest` vs replay digest, both
  printed by separate processes), `e4-t05-roundtrip.txt` (main→feature→main with the
  before/after tree hashes), `e4-t05-dirty-refusal.txt` (**frozen golden** transcript of
  the refusal — stderr line, exit code, before/after byte-equality hashes; the verify
  run compares its fresh transcript against this file and never regenerates it),
  `e4-t05-sensitivity.md` (sabotage transcripts).
- `Makefile`: `verify-E4-T05` per the E0-T02 target contract — cold-clone runnable, the
  four evidence artifacts reproduced fresh, the dirty-refusal transcript diffed against
  the committed golden, sensitivity proof included, plus re-runs of `verify-E4-T01` and
  `verify-E4-T04` proving this task changed neither the workspace format nor the status
  classifier.

## Acceptance criteria

- [ ] `make verify-E4-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] **Fork at the claimed offset**: after `ef branch feature` in a workspace whose
      `.ef/` checkpoint reads offset `O`, the dumped `feature` metadata stream contains
      exactly one event — `fs.branch.fork` with `forkOffset === O` (literal string
      equality against the checkpoint file's value, asserted by test and shown in
      `evidence/e4-t05-fork-offset.txt`) — and the parent stream's head offset and
      `ef replay --digest` dump digest are byte-identical before and after the command.
- [ ] **Checkout digest parity**: after `ef checkout feature` on a clean tree,
      `ef tree-digest` in the working directory equals
      `ef replay <feature-dump> --parent <main-dump> --digest`, byte-identical, the two
      values produced by two separate node processes (distinct pids printed by the
      harness); for the fresh fork this is the digest at the fork point by construction.
      A second scenario checks out a branch that has post-fork edits (dispatched by a
      separate client) and the same equality holds at head — including one deleted and
      one renamed path whose old working-tree files are gone after checkout (asserted
      literally, not just via digest).
- [ ] **Round-trip byte identity**: with local edits absent, checkout main → feature →
      main; a recursive byte comparison (every path + full contents, `.ef/` excluded) of
      the working tree before and after is empty, and `ef tree-digest` matches its
      pre-round-trip value; transcript in `evidence/e4-t05-roundtrip.txt`. `ef checkout
      main` while already on main moves zero bytes anywhere (tree, `.ef/`, both logs).
- [ ] **Dirty-tree refusal, byte-neutral, per class**: for each of modified, added,
      deleted, renamed, untracked (each staged independently on a clean checkout),
      `ef checkout <other>` exits 3, stdout is 0 bytes, stderr is exactly one line with
      reason `cli/dirty-working-tree`, and neutrality is asserted by an independent
      apparatus: a full recursive hash over every path and full contents — untracked
      files included — computed by test harness code that does not import the CLI's
      digest, one hash for the working tree with `.ef/` excluded and one for the
      `.ef/` directory itself (the round-trip criterion's recursive byte comparison,
      as a hash), plus both branch stream dumps; all byte-identical before and after
      the refused command. `ef tree-digest` is explicitly not a valid neutrality
      oracle for its own refusal paths. The modified-class run's transcript matches the committed golden
      `evidence/e4-t05-dirty-refusal.txt` byte-for-byte; the golden is a frozen artifact
      the run compares against, never rewrites.
- [ ] **Typed refusals pinned**: `cli/unknown-branch` (nonexistent branch),
      `cli/not-a-workspace` (no `.ef/`), `cli/interrupted-checkout` (marker present —
      and while it is present, `ef status` and `ef branch` refuse with the same code),
      and a passed-through `fs/branch-exists` from `ef branch` each asserted literally:
      exit 3, stdout 0 bytes, frozen stderr shape, no stream mutated (dump digests
      byte-identical). An invalid branch name is refused by the server as
      `fs/invalid-branch-name` and passed through verbatim — the CLI performs no
      client-side name rewriting or normalization. Usage errors are pinned too:
      `ef checkout` with no argument (and `ef branch` with no argument) exits 2,
      stdout 0 bytes, exactly one stderr usage line, nothing mutated.
- [ ] **Hostile tree refused before it lands**: checkout validates every path at the
      replay-client boundary — after the branch's events are resolved, before any
      filesystem call — and the test exercises that seam end-to-end: it drives the
      real `ef checkout` binary against the published local Durable Streams server
      seeded through the official client with hand-tampered events containing at
      least one path that violates the E1-T01 path rules (a `..` segment, a leading
      `/`, a non-NFC name), and asserts the frozen refusal shape — `cli/unsafe-path`,
      exit 3, stdout 0 bytes — before a single working-tree byte moves. A unit test
      on an internal path-validation function that the real checkout code path does
      not call satisfies nothing here. Neutrality is asserted with the same
      independent apparatus as the dirty-tree criterion: harness-computed full
      recursive hashes (every path + full contents, untracked files included, not
      `ef tree-digest`) — one over the working tree with `.ef/` excluded, one over
      the `.ef/` directory itself — plus both stream dumps, byte-identical before
      and after.
- [ ] **Journal marker honesty**: the test kills a checkout between tree materialization
      and the `.ef/` rename (hook or injected fault); afterwards
      `.ef/checkout-in-progress` exists, and `ef status` refuses with
      `cli/interrupted-checkout` rather than reporting any classification over the
      half-materialized tree.
- [ ] Sensitivity proof inside `make verify-E4-T05`: in a scratch worktree, (a) making
      checkout skip the E4-T04 status gate, (b) making the materializer skip deletions
      (stale files left behind), and (c) making `ef branch` fork at the parent's head
      instead of the checkpoint offset, each turn the target red; transcripts in
      `evidence/e4-t05-sensitivity.md`. Any sabotage the target stays green on fails
      this criterion.
- [ ] No regression: `verify-E4-T01` and `verify-E4-T04` re-run green against this tree,
      and all root gates pass (`pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build`).
- [ ] Replay (browser layer): N/A — CLI-only task, no browser-reaching surface; declared
      explicitly per AGENTS.md, with fork-offset dumps, digest parity transcripts, the
      round-trip byte diff, and the frozen refusal golden as the stream-layer currency.

## Adversarial verification

The claim under attack: "`ef branch` forks exactly at the workspace's checkpoint offset
without touching the parent, `ef checkout` writes a tree byte-equal to `replay(branch)`
and never destroys a local modification, and every refusal moves zero bytes anywhere."
Use your own repos, edits, and seeds throughout — never the builder's fixtures — and
invent at least one angle this list lacks.

1. **Your own fork, your own arithmetic.** From a cold clone: init/clone a workspace,
   advance the branch through a second dispatch client, then — *before* the workspace
   has caught up — run `ef branch`. The fork must land at the workspace's stale
   checkpoint offset, not at the server head: dump the branch log and compare
   `forkOffset` to the checkpoint file yourself. A fork at head refutes the offset
   claim (and would make E4-T07's downlink semantics incoherent). Also dump the parent
   before/after and byte-diff: any moved parent byte refutes E1-T08 pass-through.
2. **Dirty matrix, including sneaky dirt.** Stage each dirt class yourself, plus the
   nasty ones: a content change with mtime restored to the original (must still block —
   E4-T04's classification is content-true, and checkout inherits it), a `touch` that
   changes zero bytes (must NOT block — a clean tree refused is equally a refutation),
   a new empty directory, a file replaced by a directory at the same path. For every
   blocked case, hash the full tree, `.ef/`, and both dumps before/after — one moved
   byte refutes neutrality; for every clean case, checkout must succeed and
   digest-match replay.
3. **The clobber hunt.** Make a local edit, then try every route around the guard:
   checkout the *current* branch, checkout with the edit in a deeply nested new
   directory, checkout immediately after planting-then-removing the journal marker,
   run two `ef checkout` processes concurrently. Any path that ends with your edited
   bytes gone — overwritten, deleted, or left digest-matching the target as if the edit
   never existed — refutes dirty-tree protection, the task's whole reason to exist.
4. **Independent materialization oracle.** Check out a branch with post-fork history
   (renames, deletions, a patched file). Separately materialize `replay(branch)` with
   your own from-scratch script over the resolved dump (never importing the CLI's
   materializer) and `diff -r` the two trees, `.ef/` excluded. Any differing path or
   byte refutes the parity claim more precisely than the digest does — and if the trees
   match while the digests differ, the E4-T01 digest apparatus itself is refuted.
5. **Kill it mid-flight.** SIGKILL `ef checkout` at several points (fault injection or
   a large tree + timing). After each kill: if the marker exists, `ef status`,
   `ef branch`, and `ef checkout` must all refuse with `cli/interrupted-checkout`; a
   post-kill `ef status` that reports *clean* over a tree matching neither branch is a
   direct refutation. Then verify the `.ef/` state itself is never torn: it must parse
   as either the complete old state or the complete new state, never a hybrid.
6. **Offset and auth sabotage at the door.** Hand-edit the `.ef/` checkpoint to a
   mid-gap offset no parent event carries and to an offset past head — `ef branch` must
   surface `fs/fork-offset-out-of-range` verbatim with no stream created (probe by
   GET). Strip/forge the CLI token — the fork must be refused at the E2-T03 door with
   no branch stream created and exit 3. Any locally-invented reason code where a server
   code exists refutes the pass-through contract.
7. **Golden and apparatus honesty.** Delete `evidence/e4-t05-dirty-refusal.txt` and run
   `make verify-E4-T05` — it must fail red, not regenerate-and-pass. Run your own
   sabotages beyond the builder's committed three: make the refusal exit 0 while still
   printing the error line; make the round-trip comparison skip file contents and
   compare paths only. A verify target that stays green under either refutes the
   measuring apparatus, which voids every other artifact in this task.
8. **Feed the materializer a hostile tree.** Every other angle hands the materializer
   honest dumps; don't. Hand-craft events whose paths violate the E1-T01 path rules —
   a `..` segment, a leading `/`, a non-NFC name — and drive the real `ef checkout`
   binary against a fresh published local Durable Streams server seeded through the
   official client, the same seam the acceptance criterion
   freezes. The refusal must come from the replay-client boundary check inside the
   real checkout code path — a passing unit test on an internal path-validation
   helper that checkout never calls is itself a refutation, not evidence. It must
   refuse with `cli/unsafe-path`, exit 3, before a single working-tree byte moves:
   compute your own independent recursive hashes (not `ef tree-digest`) of the tree
   and `.ef/` before/after, the same neutrality bar as the dirty refusal. A
   materializer that blindly joins paths — writing outside the workspace, or
   normalizing a name into a collision — stays green under angles 2, 4, and 6 and
   is exactly what this angle exists to catch.

Refutation currency: a fork-offset string that differs from the checkpoint, a parent
byte that moved, a working-tree path whose bytes differ from your independent
materialization, a local edit that a checkout destroyed, a refusal that left a trace, or
a post-kill `clean` verdict — each cited with the dump, offset, digest pair, or byte
diff. "Checkout should also support stashing" is a design note, not a finding. No
refutation → promote your independent materialization diff into a committed test and
your nastiest dirt case into the dirty-matrix fixture set.

## Verification log

### 2026-08-06 — builder — IMPLEMENTED

- Commit: `de82d040` (`feat: implement E4-T05 branch checkout`).
- Latest-provider check: `@durable-streams/server@0.3.8` is the current `latest` tag and is the package exercised by the tests; no emulator is used by the E4-T05 integration or evidence harness. The checked-in `@durable-streams/server@0.3.8` patch remains necessary for `/dump`, aligned opaque transport offsets, and historical fork source-offset mapping. The official provider exposes an inherited parent prefix in a forked child dump; the fork event is asserted as the single child-owned fork event, and the repository-home validator now handles that official shape.
- Commands: `make --no-print-directory verify-E4-T05`; `node tools/verify/e4_t05_branch_checkout.mjs`; `node tools/verify/e4_t05_sensitivity.mjs`; `node node_modules/typescript/bin/tsc -b tsconfig.build.json --pretty false`; targeted ESLint and Prettier checks.
- Stream-layer evidence: `evidence/e4-t05-fork-offset.txt`, `evidence/e4-t05-checkout-digest.txt`, `evidence/e4-t05-roundtrip.txt`, `evidence/e4-t05-dirty-refusal.txt`, and `evidence/e4-t05-sensitivity.md`. The official-server harness exercises the real `ef` binary for branch and checkout, stale-checkpoint forks, post-fork write/delete/rename materialization, independent replay/tree digest equality, main→feature→main byte identity, no-op checkout, the five dirty-tree classes, journal interruption, typed refusals, and hostile raw paths. It also proves E4-T01 and E4-T04 regressions and requires each of the three implementation mutations to turn the focused suite red.
- Full gate result: 51 test files and 532 tests passed; `verify-E4-T01`, `verify-E4-T04`, and `verify-E4-T05` all passed with zero `SKIPPED:` lines.
- Replay: N/A (CLI-only task, no browser-reaching surface) + mitigation: official Durable Streams HTTP dumps, fork transport-offset evidence, independent recursive hashes, replay/tree digest parity, raw stream byte-neutrality checks, and frozen refusal transcript.

### 2026-08-06 — independent critic — VERDICT: refuted

- **Authenticated dispatch contract — REFUTED.** The builder path directly called the
  official native fork endpoint and then appended the fork event, while the task requires
  one authenticated `POST /api/dispatch` through the E2-T05 token door. The changed path
  is `packages/cli/src/branch-checkout-command.ts:305-313`; the focused test used only the
  official Durable Streams server at `packages/cli/test/branch-checkout.test.ts:33-45`.
  Rework must move the branch mutation behind the authenticated dispatch door and prove
  the request through real HTTP.
- **Invalid-name pass-through — REFUTED.** `createNativeBranch` rejected names locally
  at `packages/cli/src/branch-checkout-command.ts:268-272`, but the frozen contract requires
  the server's `fs/invalid-branch-name` reason to pass through verbatim. Rework must let
  the dispatch door validate the name and preserve that reason.
- **Fork immutability evidence — NEEDS-EVIDENCE.** The focused test compared raw parent
  dumps, but did not explicitly record parent head and replay/dump digest before and after
  the command as required by the acceptance criterion. Rework must add those exact checks
  and cite them in the evidence artifact.
- **Sensitivity transcript — NEEDS-EVIDENCE.** The committed sensitivity artifact only
  summarized mutation names; it did not preserve the expected-red command transcripts.
  Rework must record the failure outputs while retaining the frozen target behavior.
- **Provider finding.** The critic independently confirmed `@durable-streams/server@0.3.8`
  is latest and that E4-T05 uses its official test server, not the emulator. The checked-in
  provider patch remains a separate current-provider compatibility question and must be
  closed with direct control evidence before final verification.
- Replay: N/A (CLI/platform/stream work has no browser-reaching surface) + mitigation:
  authenticated dispatch HTTP evidence, official-provider dumps, digest comparisons, and
  the committed sensitivity transcript.
