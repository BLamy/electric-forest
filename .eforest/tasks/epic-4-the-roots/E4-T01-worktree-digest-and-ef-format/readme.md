---
id: E4-T01
epic: 4
title: "Working-tree digest apparatus and the frozen .ef/ workspace format: ef tree-digest with byte-parity to the stream-fs tree digest"
priority: 401
status: in-progress
depends_on: [E3]
estimate: M
capstone: false
---

## Goal

Epic 4's measuring apparatus lands before any sync feature: `packages/cli`'s `ef` binary
ships `ef tree-digest <dir>`, which walks a local directory and prints the **canonical
worktree digest** — exactly one lowercase-hex SHA-256 line on stdout, exit 0, nothing
else on stdout (the E1-T06 `ef materialize` output contract, verbatim) — computed by the
**same algorithm E1 froze for stream-fs**: `stateDigest` from `@eforest/protocol` over
the canonically-encoded **content projection** of the E1-T01 tree state,
`{ files: { [path]: { contentSha256, size } } }` (lexicographically key-sorted canonical
JSON, E1-T01 path rules: `/`-separated NFC UTF-8, no leading/trailing `/`, no empty/`.`
/`..` segments, no NUL). The projection is frozen here as `WORKTREE_DIGEST_VERSION = 1`,
exported from `@eforest/streamfs` as one function — `worktreeDigest(state)` — with the
exclusion of the session-scoped `contentStreamId` field documented as the _only_
difference from E1-T01's full tree state, and `ef replay <dump> --worktree-digest` /
`ef materialize <dump> --out <dir> --worktree-digest` printing the identical projection
digest from an event log through that same function, never a second implementation. The
unflagged `ef materialize` form retains E1's tree-digest output for backward
compatibility. This makes
`digest(worktree) == digest(replay(branch))` an exact-equality claim every later Epic-4
task (E4-T02 init, E4-T03 clone, E4-T09 convergence, the E4-T12 capstone) proves by
running two commands and comparing two lines. Alongside it, the versioned **`.ef/`
workspace-state format** is frozen (`EF_WORKSPACE_VERSION = 1`, module
`@eforest/workspace` in `packages/workspace`): server/project/repo/branch identity, the
head-offset checkpoint, and the per-file base ledger `path → { base, contentSha256,
size }` (`base` is the E1-T04 per-path content revision) that E4-T04 status
classification and E4-T06 stale-write fencing read — canonical JSON on disk, atomic
write-temp-then-rename saves, typed refusal of unknown versions and corrupt bytes.
Changing either frozen contract later invalidates every Epic-4 golden — a loud,
version-bumped event, exactly as E1-T01 froze the fs envelope.

## Context

Epic 4 (ROADMAP.md, "Epic 4 — the-roots") builds `ef init/clone/branch/checkout/status`
and the two-way watcher, and its capstone verdict is "final trees are byte-identical and
match `replay(branch)`". Every one of those claims bottoms out in comparing a _local
directory on disk_ against a _replayed stream_ — so the comparator must exist first,
frozen, and provably sensitive, or every later green in this epic is unfalsifiable. This
is the same keystone move as E1-T01 (the fs digest apparatus before any fs feature) and
E1-T06 (the convergence harness before any merge): the epic's tasks cite this
instrument; they do not re-derive it.

Why a _projection_ and not the raw E1-T01 tree digest: E1-T01's canonical tree state
maps `path → { contentStreamId, contentSha256, size }`, and E1-T06 already documents
that `contentStreamId`s are generated per session — they are stream bookkeeping, not a
function of the bytes on disk, so no directory walk can ever reproduce them. The honest
exact-equality currency between a worktree and a branch is therefore the digest of the
tree state _minus that one field_, and this task freezes that subtraction in one place
rather than letting each Epic-4 task improvise it. `ef tree-digest` on a directory and
`ef replay --worktree-digest` on a dump are two mouths on the one
`worktreeDigest(state)` function; the parity fixture proves them byte-equal.

Contracts frozen by this task:

- **Worktree digest recipe** (`WORKTREE_DIGEST_VERSION = 1`): the digest is
  `stateDigest(projection)` from `@eforest/protocol` where
  `projection = { files: { [path]: { contentSha256, size } } }`, keys canonically
  sorted, `contentSha256` the lowercase-hex SHA-256 of the file's exact bytes, `size`
  the byte length. Documented verbatim in the `@eforest/streamfs` readme next to the
  E1-T01 tree-state shape, with the field-exclusion rule and the invalidation rule
  (version bump + regenerate every Epic-4 golden).
- **Directory-walk rules**: the walk is deterministic and environment-free — sorted
  traversal, no dependence on readdir order, mtime, mode bits, owner, locale, TZ,
  umask, or cwd (file metadata other than path/bytes is an enumerated carve-out: it
  must NOT affect the digest, and the readme says so). `.ef/` at the worktree root is
  always excluded from the walk. On-disk names must round-trip the E1-T01 path rules:
  a name that is not valid NFC UTF-8, or any non-regular file (symlink, FIFO, socket,
  device) anywhere in the tree, is a typed refusal — exit nonzero, stdout exactly 0
  bytes, diagnostic on stderr naming the offending path — never a silent skip or
  silent normalization. Empty directories: whether they enter the projection follows
  the E1-T02 directory/tombstone semantics; the builder's answer is pinned in the
  readme and exercised by a committed test (an undocumented answer is a contract
  hole, not a freedom).
- **`.ef/` workspace format** (`EF_WORKSPACE_VERSION = 1`): file layout under
  `<worktree>/.ef/` documented in the `@eforest/workspace` readme — identity (server
  URL, project, repo, branch, metadata stream id), the head-offset checkpoint (the
  last stream offset fully applied to this worktree), and the base ledger
  `path → { base, contentSha256, size }` where `base` is the E1-T04 content revision
  the local copy was materialized from. All files canonical JSON. `load()` refuses —
  typed errors, never defaults — a missing/unknown `v`, malformed JSON, truncated
  bytes, schema-violating fields, or duplicate ledger keys. `save()` is atomic:
  write to a temp file in `.ef/`, fsync, rename — a crash at any point leaves either
  the old or the new state on disk, never a torn one.

Non-goals: no network, no server, no auth, no dispatch — `ef init` (E4-T02) is the
first task to put anything _into_ a `.ef/`; this task only freezes the format and its
load/save/refusal semantics against fixture bytes. No watcher, no status classification
(E4-T04 consumes the ledger; it does not exist yet). `depends_on: [E3]` means the
E3 capstone is verified: engine, stream-fs, gates, and the web canopy below this CLI
are already proven, and `ef replay` / `ef materialize` (E0-T04, E1-T06) exist to be
extended.

## Deliverables

Path anchor: every `evidence/` path in this spec is relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T01-worktree-digest-and-ef-format/`. The Makefile
`verify-E4-T01` recipe must reference these files repo-root-anchored (e.g. via
`$(CURDIR)`) so the recipe passes from any cwd.

- `@eforest/streamfs`: `worktreeDigest(state)` — the content projection + `stateDigest`
  in one exported function — plus `WORKTREE_DIGEST_VERSION = 1` and the readme sections
  above (recipe, exclusion rule, carve-outs, invalidation rule).
- `packages/cli`: `ef tree-digest <dir>` — deterministic sorted walk, hashes exact
  bytes, builds the projection, delegates to `worktreeDigest`, prints the one-line
  digest; all refusal classes above exit nonzero with 0 bytes on stdout. Also
  `ef replay <dump> --worktree-digest` and `ef materialize <dump> --out <dir>
--worktree-digest` (the unflagged materialize form retains E1's tree digest), both
  routed through the identical exported function — the CLI
  contains no hashing or canonicalization of its own.
- `packages/workspace` (`@eforest/workspace`): typed `load(dir)` / `save(dir, state)`
  with the atomicity and refusal semantics above, `EF_WORKSPACE_VERSION = 1`, format
  readme. Wired into all five workspace gates.
- Committed golden fixtures:
  - `evidence/fixture-tree/` — a real committed directory tree: nested and unicode
    (NFC) paths, a binary file, an empty file, multiple sizes, enough surface for the
    byte-sweep.
  - `evidence/golden-worktree.jsonl` — a stream-fs metadata event log (valid under the
    E1-T01/E1-T02 envelope) whose replayed tree materializes to exactly
    `fixture-tree/`'s contents.
  - `evidence/golden-worktree.digest` — the frozen worktree digest, produced once,
    committed, never regenerated by any check that consumes it.
  - `evidence/ef-fixtures/` — one valid `.ef/` state plus a refusal corpus: `v: 2`,
    truncated file, malformed JSON, extra field, wrong-typed field, duplicate ledger
    key — each with its expected typed error asserted by a committed test.
- Tests (`packages/cli/test/`, `packages/workspace/test/`): the parity proof
  (materialize the golden log to a temp dir with `ef materialize`, run
  `ef tree-digest` on it, byte-compare all three digest sources — tree-digest,
  `ef replay --worktree-digest`, direct `worktreeDigest` on the folded state — against
  `golden-worktree.digest`); the full byte-sweep sensitivity test over every byte of
  every file in a temp copy of `fixture-tree/` (each flip must change the digest —
  content bytes admit no carve-outs); metadata carve-out tests (touch mtime, chmod
  where the platform allows → digest unchanged); the walk-refusal corpus (symlink,
  FIFO, non-NFC name); `.ef/` exclusion; `.ef/` load/save round-trip, refusal corpus,
  and a crash-atomicity test (kill the saving process between temp-write and rename;
  reload must yield old-or-new, never torn).
- `Makefile`: `verify-E4-T01` inside the marker section composing the frozen helper
  recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus the golden steps:
  (1) parity — `ef tree-digest evidence/fixture-tree` and
  `ef replay evidence/golden-worktree.jsonl --worktree-digest` each run **twice as
  separate `ef` process invocations**, all four lines byte-equal each other and
  `evidence/golden-worktree.digest`; (2) sensitivity — flip one byte of one fixture
  file in a temp copy, assert the digest comparison exits nonzero, printing
  `MUTATION fixture=fixture-tree byte=<offset> digest-mismatch EXPECTED-FAIL OK` only
  after observing the mismatch. Joins `verify-all`; `tools/verify/self_check.sh` still
  passes.

## Acceptance criteria

- [x] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E4-T01` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E4-T01 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [x] **Parity**: `ef tree-digest evidence/fixture-tree`,
      `ef replay evidence/golden-worktree.jsonl --worktree-digest`, and
      `ef tree-digest <dir>` where `<dir>` is a fresh
      `ef materialize evidence/golden-worktree.jsonl --out <dir> --worktree-digest` all print the same
      single lowercase-hex SHA-256 line, byte-equal to
      `evidence/golden-worktree.digest`, each exiting 0; two runs of each in fresh
      shells are byte-identical (`diff <(run1) <(run2)` empty) — evidence: the Makefile
      steps above plus a committed integration test printing all sources.
- [x] **Sensitivity**: a committed sweep test whose domain is pinned to **every byte of
      every file** in a temp copy of `evidence/fixture-tree/` asserts each single-byte
      flip changes the `ef tree-digest` output (content bytes admit no carve-out
      classes), and the in-target mutation step prints
      `^MUTATION .* digest-mismatch EXPECTED-FAIL OK$` at least once — evidence:
      `make verify-E4-T01 2>&1 | grep -c '^MUTATION .* digest-mismatch EXPECTED-FAIL OK$'`
      ≥ 1, plus the sweep test green under `pnpm test`. Structural mutations are also
      covered by committed tests: rename one file, delete one file, add one file,
      truncate one file by one byte, swap two files' contents — each changes the
      digest.
- [x] **Carve-outs are frozen, not folklore**: committed tests prove mtime changes and
      (platform permitting) mode changes leave the digest byte-identical, and the
      `@eforest/streamfs` readme enumerates exactly these metadata carve-outs and the
      `contentStreamId` exclusion — evidence: the tests plus the committed readme text.
      The mode-change test's platform gate is pinned by the conditional-execution rule
      below: on the builder's machine it must actually execute, and the final claimed
      run's transcript must show it ran.
- [x] **Empty-directory semantics are pinned, not implied**: the `@eforest/streamfs`
      readme states the empty-directory answer (whether an empty directory enters the
      projection, per the E1-T02 directory/tombstone semantics), and a committed test
      creates and removes an empty directory in a temp copy of
      `evidence/fixture-tree/` and asserts the digest changes or stays identical
      **exactly as the readme states** — evidence: the committed readme text plus the
      test green under `pnpm test`.
- [x] **Case-insensitive-filesystem behavior is pinned, not implied**: the
      `@eforest/streamfs` readme states what `ef tree-digest` does when the underlying
      filesystem is case-insensitive and two projection paths differ only by case
      (refusal, or a documented outcome — the builder's answer is pinned in the
      readme), and a committed test attempts to construct two names differing only by
      case and asserts the behavior **exactly as the readme states**; where the
      platform's filesystem makes the construction impossible, the test is subject to
      the conditional-execution rule below — evidence: the committed readme text plus
      the test green under `pnpm test`.
- [x] **One algorithm, three mouths**: `ef tree-digest`, `ef replay --worktree-digest`,
      and `ef materialize --worktree-digest`'s printed digest all resolve to the single exported
      `worktreeDigest`; a committed grep-based check asserts `packages/cli/src`
      contains **none of a pinned forbidden-token list**: `createHash`,
      `crypto.subtle`, `sha256`/`SHA-256` (except in printed help/diagnostic strings,
      which the check must explicitly whitelist by exact line), `JSON.stringify`
      applied to tree or projection state, and any key-sorting of file maps
      (`sort_keys`, `.sort(` over path arrays feeding an encoder) — i.e. no hashing or
      canonical-JSON encoding outside delegation to
      `@eforest/protocol`/`@eforest/streamfs`. The committed evidence is the exact
      grep command line(s) plus their empty match output under `evidence/`; a check
      script that greps for anything less than this pinned list does not satisfy this
      criterion. Angle 3's manual source read remains the semantic backstop for
      re-implementations that token-based grepping cannot see (e.g. a hand-rolled
      hasher or encoder under a different name) — evidence: the check script/test,
      green, its command line and (empty) match output committed under `evidence/`.
- [x] **Refusals**: for each on-disk-constructible walk-refusal class (symlink, FIFO,
      non-NFC on-disk name, unreadable file) `ef tree-digest` exits nonzero with stdout
      exactly 0 bytes and a stderr diagnostic naming the offending path — evidence:
      committed tests iterating the corpus, green under `pnpm test`. The remaining
      frozen-path-rule violations (NUL in a name, empty/`.`/`..` segments, embedded
      `/`) are unconstructible as on-disk filenames on POSIX/APFS and are therefore
      exercised at the **library layer, not by an on-disk fixture**: a committed test
      feeds `worktreeDigest` a projection containing each rule-violating key directly
      and asserts a typed refusal for every one — evidence: that library-level test,
      green under `pnpm test`. The unreadable-file case cannot be constructed when
      tests run as root (`chmod 000` is readable to root); it is subject to the
      conditional-execution rule below.
- [x] **Conditional tests are loud, counted, and executed on the claimed run**: no
      environment-gated assertion may silently not run. Each platform- or
      privilege-gated test (the mode-change carve-out, the unreadable-file refusal,
      the case-collision construction) must either execute its assertion or emit a
      loud, greppable named-skip marker on a line matching
      `^CONDITIONAL-SKIP: <test-name> reason=<reason>$`; the `verify-E4-T01` Makefile
      recipe counts these markers and the spec here pins which environments are
      permitted to skip: mode-change only on filesystems that do not honor `chmod`,
      unreadable-file only when running as root (euid 0), case-collision only when
      the platform's filesystem cannot construct two names differing only by case —
      nothing else. The zero-`SKIPPED:` rule above covers Makefile-level skips; this
      criterion extends it to `pnpm test`-level conditionals. The final claimed run's
      committed transcript must show all gated assertions actually executed (zero
      `CONDITIONAL-SKIP:` lines) on the builder's machine — evidence: the transcript
      under `evidence/` plus
      `make verify-E4-T01 2>&1 | grep -c '^CONDITIONAL-SKIP:'` printing `0`.
- [x] **`.ef/` exclusion**: two temp copies of `fixture-tree/` differing only in the
      presence/contents of a `.ef/` directory produce byte-identical digests —
      evidence: committed test.
- [x] **Non-root `.ef/` is pinned, not implied**: the `@eforest/streamfs` readme's
      exclusion rule explicitly states that only the worktree-root `.ef/` is excluded
      and that a nested `sub/.ef/` enters the walk as ordinary content (or the
      opposite — the builder's answer is pinned in the readme), and a committed test
      places a `sub/.ef/` with contents in a temp copy of `fixture-tree/` and asserts
      the digest changes or stays identical **exactly as the readme states** —
      evidence: the committed readme text plus the test green under `pnpm test`.
- [x] **`.ef/` format**: round-trip `save` → `load` is identity on the typed state; every
      case in `evidence/ef-fixtures/` refusals loads to its expected typed error (never
      a default); `EF_WORKSPACE_VERSION = 1` is exported and the format readme states
      the layout, the base-ledger semantics (`base` = E1-T04 content revision), and the
      invalidation rule — evidence: committed tests plus the committed files.
- [x] **Crash atomicity**: a save interrupted between temp-write and rename (child
      process killed at an injected fault point) leaves a directory from which `load`
      returns either the complete old state or the complete new state — a torn or
      unparseable result fails the test — evidence: committed fault-injection test,
      green.
- [x] **Environmental determinism**: the golden digest is identical under
      `TZ=Pacific/Kiritimati LANG=C umask 077` vs default env, from two different
      cwds — evidence: both transcripts committed under `evidence/`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
pnpm typecheck && pnpm test && pnpm build` exit 0); `tools/verify/self_check.sh`
      passes; `make verify-list` maps `verify-E4-T01` to this task; `verify-all`
      including every E0–E3 target still green — this task is additive to the frozen
      protocol and fs contracts.
- [x] Replay browser layer: N/A (CLI + library surface only; nothing browser-reaching
      changes) — the Verification log entry must declare this explicitly per AGENTS.md;
      stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that this apparatus makes "worktree equals branch" an
exact-equality fact. Every attack pairs a manipulation with a refutation condition. Use
your own inputs, never the builder's. Any single success refutes.

1. **Sensitivity, your own bytes (mandatory).** Ignore the builder's chosen mutation.
   In your own temp copies of `evidence/fixture-tree/`: flip a byte mid-file, flip the
   first and last byte, truncate by one byte, append one byte, swap two files' bytes,
   rename a file (case-only rename included), delete a file, add an empty file, replace
   a file with an empty one. Every one must change the `ef tree-digest` line. Then the
   carve-outs: touch mtimes, chmod, re-copy the tree so inode/readdir order differs —
   digest must be byte-identical, and the readme must enumerate exactly these
   carve-outs. **A content-reaching mutation that leaves the digest green refutes the
   entire measuring apparatus** — file it as a task refutation, not a bug.
2. **Parity, derived independently.** Do not trust the committed golden pair together.
   Materialize `evidence/golden-worktree.jsonl` yourself with `ef materialize`,
   `diff -r` it against `evidence/fixture-tree/`, and run `ef tree-digest` on both.
   Then derive the digest **by hand**: walk the fixture tree with python, build
   `{"files": {path: {"contentSha256": ..., "size": ...}}}`, encode with
   `json.dumps(obj, separators=(',',':'), sort_keys=True, ensure_ascii=False)` (hand-
   deriving wherever canonical JSON and python disagree), `shasum -a 256`. An
   independent derivation that disagrees is a refutation; a digest only the package's
   own code can reproduce is **needs-evidence**.
3. **Second-implementation hunt.** Read `packages/cli/src` and `packages/workspace/src`
   for any hashing, sorting, or JSON-encoding of tree state that does not delegate to
   the one exported `worktreeDigest` / `@eforest/protocol` canonical encoder. One
   parallel implementation — even a byte-identical one today — refutes the "one
   algorithm, three mouths" claim, because parallel truths drift.
4. **Aliasing attacks on the projection.** Engineer distinct trees that might collide:
   file `a` with content `x` vs file `a` with content `y` of equal SHA-256-prefix;
   paths `a/b` + `c` vs `a` + `b/c`; a path containing `"` , `\`, or astral-plane
   characters vs its escaped-lookalike; two files whose concatenated
   path+hash strings are equal under naive string joining. Equal digests for trees
   whose materialized bytes differ refutes. Conversely: byte-identical trees reached
   by different construction orders (copy order, mid-walk file creation) must produce
   equal digests.
5. **Hostile filesystems.** On APFS: create an NFD-named file (must be refused per the
   frozen rules — silent normalization that digests it as NFC refutes, because one
   user-visible name would alias two claimed tree keys); attempt two names differing
   only by case and confirm the documented behavior holds; drop in a symlink escaping
   the tree, a symlink loop, a FIFO, an unreadable file, a 10k-deep nesting, a file
   named with a trailing space and a newline. Every refusal: exit nonzero, stdout
   exactly 0 bytes. Any silent skip — a digest computed over a tree the walk didn't
   fully certify — refutes.
6. **`.ef/` exclusion and injection.** Put a `.ef/` in your tree with garbage, with a
   valid workspace state, and nested at a non-root depth (`sub/.ef/` — is it excluded?
   The readme must say; behavior contradicting the readme refutes). Digest must ignore
   root `.ef/` entirely; then confirm `ef tree-digest` never _writes_ anything —
   `find <tree> -newer <marker>` after a run must be empty. An apparatus that mutates
   what it measures refutes.
7. **`.ef/` format attacks.** Feed `load()` your own corruptions beyond the committed
   corpus: NUL-truncated JSON, a ledger with 100k entries, a `base` of the wrong type,
   `v: 1.0` vs `1`, a ledger key violating path rules, BOM-prefixed file. Every one a
   typed error, never a default or a crash without classification. Then the crash
   test yourself: run a save loop under `kill -9` at random delays (or the injected
   fault point) 50 times; any reload that is neither complete-old nor complete-new
   refutes atomicity.
8. **Self-licking goldens.** Delete `evidence/golden-worktree.digest` and run
   `make verify-E4-T01` — it must fail red, not regenerate-and-pass. Inspect the recipe
   and tests for any write to the golden files at check time; inspect git history for a
   regenerated golden. A check that can never fail refutes the verify spine's coverage
   of this task.
9. **Sabotage the suite.** In a scratch worktree, break it four ways: (a) include
   `contentStreamId`-shaped noise in the projection, (b) make the walk readdir-order
   instead of sorted, (c) hash `JSON.stringify` output instead of canonical JSON,
   (d) make `load()` accept `v: 2`. For each: `pnpm test` **and** `make verify-E4-T01`
   must go red. Any sabotage that stays green refutes whichever gate it slipped past.
   Check the diff for `.skip`/`.todo`/inline lint disables while there.
10. **Freeze audit + coverage.** Confirm `WORKTREE_DIGEST_VERSION` and
    `EF_WORKSPACE_VERSION` are exported and both invalidation rules documented; change
    one frozen detail (add a field to the projection, reorder ledger fields) in a
    scratch worktree and confirm the committed goldens go red. Then hold the claimed
    final run against the diff: every refusal class, the sweep, the carve-outs, the
    atomicity test, and both `--worktree-digest` mouths must each have been executed by
    a committed test or cited transcript. Unexecuted diff is unproven or dead — builder
    picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your independent python digest derivation as a committed
cross-check, and any hostile tree or `.ef/` corruption that found interesting surface
into the committed corpora.

## Verification log

### 2026-08-02 — builder — IMPLEMENTED

- Commits `a06992d96b59c2856828335f10cd352e0d99b2b8` and
  `cf60dc0223257354f19e05427a8f8d745c65975b8` add `WORKTREE_DIGEST_VERSION=1`,
  the pure `worktreeDigest` projection, the Node-only deterministic directory walker,
  `ef tree-digest`, `--worktree-digest` replay/materialize mouths, and the typed
  `@eforest/workspace` v1 canonical `.ef/workspace.json` load/save format.
- Historical pre-rework snapshot: `CI=true pnpm format:check`, `CI=true pnpm lint`,
  `CI=true pnpm typecheck`, `CI=true pnpm test` (47 files / 498 tests), and
  `CI=true pnpm build` all passed. The rework log below supersedes this snapshot.
- `make verify-E4-T01` passed from a pristine cold clone via
  `tools/verify/cold_clone.sh --keep verify-E4-T01`; the cold transcript ran the
  scrubbed gates, the production web build, parity verifier, focused conditional tests,
  `tools/verify/self_check.sh`, `verify-list`, and emitted `verify-E4-T01: OK` with zero
  `SKIPPED:` and zero `CONDITIONAL-SKIP:` lines.
- Stream evidence: `evidence/golden-worktree.jsonl` materializes byte-identically to
  `evidence/fixture-tree/` (excluding its reserved root `.ef/`), and
  `evidence/golden-worktree.digest` is
  `b16539504148543e5320e94e878584102f320284d5378aa65ea14adc6e815c73`. `ef tree-digest`,
  `ef replay --worktree-digest`, `ef materialize --worktree-digest`, direct `worktreeDigest`, and
  the environmental determinism probe all match that frozen line. The committed CLI
  test flips every byte in every fixture file and exercises rename/delete/add/truncate/
  content-swap mutations; mtime/mode carve-outs, root/nested `.ef/`, symlink/FIFO/
  unreadable refusals, path validation, workspace refusal corpus, and child-kill
  atomicity are covered.
- Evidence transcript: `evidence/e4-t01-transcript.txt`. Replay: N/A (CLI + library-only
  change; no browser-reaching code) + mitigation: committed stream-layer goldens,
  parity/sensitivity/refusal tests, five repo gates, and cold-clone proof above.
- The aggregate `verify-all` E0–E3 target was not part of this historical snapshot;
  its current status is recorded explicitly in the rework log below.

### 2026-08-02 — builder — REWORKED AFTER CRITIC AUDIT

- Commit `23a616c1` closes the independent audit findings: the public
  `verify-E4-T01` recipe is cwd-independent; root `.ef` directories alone are excluded
  (a root `.ef` file is measured); empty-directory creation/removal and every structural
  mutation are isolated; on-disk NFD, symlink, FIFO, unreadable, and CLI zero-stdout
  refusal paths are exercised; case-insensitive overwrite semantics are asserted; and
  workspace ledger bases refuse arbitrary strings, accepting only `BASE_NONE` or a
  well-formed stream offset.
- The E1 materialize contract is preserved: unflagged `ef materialize` returns the tree
  digest, while E4 parity opts into the shared projection with `--worktree-digest`.
  The verifier now probes two default cwds plus
  `TZ=Pacific/Kiritimati LANG=C PATH=/usr/bin:/bin umask 077` from `/tmp`, and audits
  all CLI additions since the E3 base.
- Commit `1e8843e8` adds the final evidence hardening: the pinned forbidden-token audit is
  now a committed grep check:
  `tools/verify/e4_t01_cli_tokens.sh` runs the exact commands and
  `evidence/e4-t01-cli-token-grep.txt` records their empty outputs; `make verify-E4-T01`
  executes the check as part of the target.
- An independent Python derivation in `tools/verify/e4_t01_python_digest.py` reproduces
  the frozen digest; its command/output is committed in
  `evidence/e4-t01-python-digest.txt` and runs inside `make verify-E4-T01`.
- Local `/tmp` execution of `make -f <repo>/Makefile verify-E4-T01` passed at 503 tests;
  the final cold clone of commit `1e8843e8` passed the scrubbed target with 503 tests,
  two production builds, 3-file/30-test refusal gate, zero `SKIPPED:` and zero
  `CONDITIONAL-SKIP:` lines, `verify-E4-T01: OK`, and the committed transcript above.
- Replay: N/A (CLI + library-only change; no browser-reaching code) + mitigation remains
  the committed stream-layer goldens, parity/sensitivity/refusal corpus, repo gates,
  and cold-clone proof. The separate E0–E3 aggregate `verify-all` target was attempted
  at this HEAD but is not green: the direct `node tools/verify/e1_capstone.mjs` proof
  fails at `fresh capstone evidence drifted: transport-provenance.json`; an independent
  control run on the E3-T10 parent fails at the same pre-existing derived-evidence
  check. Criterion #15 remains unchecked rather than being green-washed; no upstream
  task status was changed.

### 2026-08-02 — builder — AGGREGATE RECHECK AFTER SANCTIONED E1 REFRESH

- `node tools/verify/e1_capstone.mjs --update-evidence` refreshed only the E1-T11
  derived `transport-provenance.json` and `evidence-manifest.json`; `make verify-E1-T11`
  then passed with the refreshed artifacts.
- `CI=true make --no-print-directory verify-all` advanced past E1-T11, then failed at
  `_v-e2-t01-identity` in `packages/identity/scripts/verify-provenance-refresh.mjs`:
  the frozen E2 closure allowlist does not include the E4 worktree CLI/StreamFS files
  (including `packages/cli/src/worktree-command.ts` and the generated worktree outputs).
  No E2 verifier or evidence was changed; criterion #15 remains unchecked pending an
  explicit E2 allowlist/evidence decision.

### 2026-08-02 — critic — VERDICT: needs-evidence

- P6/COVERAGE — resolved by the builder's rework: `tools/verify/e4_t01_cli_tokens.sh`
  now runs the complete pinned, case-insensitive grep list (including `sort_keys`),
  `evidence/e4-t01-cli-token-grep.txt` records both empty outputs, and the target runs
  that check. The independent Python digest cross-check is also committed and green.
- P15/COVERAGE — INSUFFICIENT. The prediction was that every E0–E3 target would remain
  green. After the sanctioned E1 refresh made `verify-E1-T11` pass, the aggregate
  failed at `_v-e2-t01-identity` in `packages/identity/scripts/verify-provenance-refresh.mjs`
  because the frozen E2 closure allowlist omits the E4 worktree CLI/StreamFS files.
  Criterion #15 remains unchecked; make an explicit E2 allowlist/evidence decision or
  record an accepted waiver before verification.
- Replay: N/A (CLI + library-only change; no browser-reaching code) + stream-layer
  mitigation: frozen digest, parity/sensitivity/refusal corpus, committed grep and
  Python cross-checks, five repo gates, and final cold-clone proof.
- SUITE: rework remains pending only for the aggregate capstone provenance gate; no
  implementation claim is marked verified.

### 2026-08-02 — builder — E2 PROVENANCE GATE REWORK

- Fixed the stale E2 allowlist in `packages/identity/scripts/verify-provenance-refresh.mjs`.
  The fix is committed as `24dff42b` on the E4-T01 branch.
  The approved refresh now includes the reviewed post-E2 E3/E4 transport-runtime changes:
  `78` changed base-closure inputs and `38` post-E1 closure additions, including the
  worktree CLI/StreamFS outputs. The verifier now uses the same code-point path ordering
  as E1's capstone generator instead of locale collation, so the two canonical artifacts
  compare byte-for-byte.
- `node packages/identity/scripts/verify-provenance-refresh.mjs` passed with a `273`-file
  closure and exactly the two derived E1 artifacts changed; the refreshed manifest digest
  is `e3caf31a0f1b6381c8b4d5290b68bb41c46e49ee6cbd44e2681be554ecf75685`.
- `node packages/identity/scripts/verify-provenance-refresh-sensitivity.mjs` passed its
  `13` attacks with `baseline: green` and `restored: green`, including the untracked
  closure-file refusal under the expanded allowlist.
- `CI=true make --no-print-directory verify-E2-T01` passed: format/lint/typecheck, `47`
  test files / `503` tests, two production builds, identity replay determinism and
  grant-mutation bisect, work-queue policy, provenance verification, sensitivity, and
  `verify-E2-T01: OK`. A full `CI=true make --no-print-directory verify-all` run also
  reached `verify-E2-T01: OK`, `verify-E2-T02: OK`, and `verify-E2-T03: OK` after the
  fix; later aggregate gates were still running when this entry was recorded.

- Replay: N/A (provenance/CLI verification only; no browser-reaching code) + stream-layer
  mitigation: canonical provenance bytes, exact closure/path checks, 13 mutation attacks,
  identity golden replay/bisect, and the E2 target transcript above. The task remains
  `in-progress` for a fresh critic verdict; no upstream E2 status was changed.

### 2026-08-02 — critic — VERDICT: needs-evidence

- Focused stream checks passed at `fc419be8`: `node tools/verify/e4_t01_evidence.mjs`,
  `bash tools/verify/e4_t01_cli_tokens.sh`, and the independent
  `tools/verify/e4_t01_python_digest.py` cross-check all passed; the three dedicated
  StreamFS/workspace/CLI suites passed (`30/30`). A fresh independent materialization
  comparison matched all five non-root-`.ef` fixture files, and fresh first/last-byte,
  append, truncate, cross-file swap, rename, delete, empty-file add, and replacement
  mutations all changed the digest. Additional NUL, wrong-base, float-version, invalid
  path, BOM, and duplicate-key workspace inputs produced typed errors. This covers the
  focused parity, sensitivity, refusal, delegation, and atomicity claims without editing
  implementation code.
- P15/COVERAGE — INSUFFICIENT. Criterion #15 requires every E0–E3 target and the aggregate
  `verify-all` to pass. The newest committed `evidence/e2-provenance-repin.txt` only records
  `verify-E2-T01`, `verify-E2-T02`, and `verify-E2-T03`; it explicitly says the aggregate run
  stopped there while later stages continued independently. No committed transcript proves
  the remaining E0–E3 gates, so the capstone gate is not earned. Run and commit a complete
  aggregate verification (or an explicit accepted waiver with equivalent evidence) before
  retrying this critic verdict.
- Replay: N/A (CLI/library/provenance-only change; no browser-reaching code) + mitigation:
  focused stream-layer golden parity, independent Python digest, hostile mutation/refusal
  probes, delegation grep, and the committed dedicated test suites above.

### 2026-08-02 — builder — E2-T05 SNAPSHOT RACE REWORK

- Commit `9ca7e801` fixes the remaining deterministic E2-T05 transcript race. The
  transcript verifier now derives the target records and the target head offset from one
  `readDurableJsonSnapshot` response instead of issuing a GET followed by a separate HEAD;
  the item list and offset therefore describe the same server snapshot.
- Refreshed `evidence/e2-t05-transcript.txt` preserves the frozen target digest and counts
  while recording the current application offsets (`...0218` after device append and
  `...0436` before/after revoke). `node tools/verify/e2_t05_transcript.mjs` emits
  `E2_T05_TRANSCRIPT_OK` without updating goldens.
- `CI=true make --no-print-directory verify-E2-T05` passed: format/lint/typecheck,
  `47` test files / `503` tests, production builds, emulator suites, the E2-T05 browser
  evidence checks, sensitivity spine, and final `verify-E2-T05: OK`. The earlier aggregate
  recheck had stopped at the stale transcript; rerun the complete aggregate from this
  commit before asking the critic to reconsider P15.
- Replay: N/A (provenance/CLI verification only; no browser-reaching code) + stream-layer
  mitigation: the committed transcript, identity/target digests, full E2-T05 gate, and
  the prior focused parity, sensitivity, refusal, delegation, and cold-clone evidence.

### 2026-08-02 — builder — E2-T06 SQUASH HISTORY + STANDING CLOSURE REWORK

- `tools/verify/e2_t06_no_database.mjs` now preserves the frozen scan base
  `defbb46f9d2ecbebae3373bffdeb816448ce3698` while recognizing the published GitHub
  squash merge `0bccd2e1fd3a35ffefb589d0ef8fc585f13791aa` (`E2-T06: durable stream
  namespaces (#32)`). It verifies that the squash is in `HEAD`, that every pinned
  recovery object still has its exact parent and six-file path set, and records
  `history-mode=squashed-merge`; legacy linear history remains fail-closed.
- Refreshed the E2-T06 runtime-boundary manifest for the current gateway,
  namespace-runtime, and production bytes, and refreshed the exact no-database
  dispositions/evidence for the full current closure: `files-scanned=417`,
  `structural-files=34`, `unallowlisted=0`, `stale=0`, with
  `E2_T06_RUNTIME_BOUNDARY_ATTESTED` and `E2_T06_NO_DATABASE_OK`.
- `node tools/verify/e2_t06_no_database.mjs --check-only` is green. The working-tree
  adversarial run `bash tools/verify/e2_t06_no_database_sensitivity.sh --working-tree`
  passed all eleven storage/runtime-boundary/fingerprint cases (`control: zero-mutation
  GREEN`, `E2_T06_NO_DATABASE_SENSITIVITY_OK`). Commit this rework, then rerun the
  focused E2-T06 gate and the complete aggregate before critic reconsideration.
- Replay: N/A (provenance/CLI/runtime-boundary verification only; no browser-reaching
  code) + stream-layer mitigation: frozen base/squash attestation, exact storage
  dispositions, runtime-boundary hashes, and the adversarial sensitivity transcript.

### 2026-08-02 — builder — E2-T06 SENSITIVITY WORKTREE DEPENDENCY REPAIR

- `tools/verify/e2_t06_sensitivity.sh` now mirrors both `packages/*/node_modules` and
  `apps/*/node_modules` into disposable worktrees, preserving each package-relative
  path. This closes the harness-only `vite: command not found` failure without
  symlinking workspace packages back to the builder checkout.
- `bash tools/verify/e2_t06_sensitivity.sh --update-evidence --working-tree` passed
  exact attribution for the zero-mutation control and the uniqueness, instance-side-
  table, and payload-owner sabotages; the committed transcript now records
  `control-green ... tests=22 failed=0`. The no-database standing check remains green
  (`unallowlisted=0`, `stale=0`).
- Replay: N/A (verification harness/evidence-only change; no browser-reaching code) +
  stream-layer mitigation: exact parsed-vitest attribution, rebuilt disposable graphs,
  and the committed E2-T06 sensitivity transcript.

### 2026-08-02 — builder — E2-T07 CURRENT-CLOSURE GOLDEN REPIN

- The aggregate reached E2-T07 and stopped on deterministic evidence drift: the
  official Durable Streams JSON now exposes an `offset` on each successful event, and
  the current StreamFS/namespace closure changes the no-side-effect digest snapshots.
  Authorization outcomes and refusal behavior were unchanged; the frozen snapshots were
  stale rather than the implementation being behaviorally divergent.
- `node tools/verify/e2_t07_matrix.mjs --write-golden` ran two fresh HTTP scenarios
  deterministically and refreshed only `e2-t07-http-matrix.txt` and
  `e2-t07-no-side-effect.txt`; `e2-t07-decision-matrix.txt` remained byte-identical.
- `CI=true make --no-print-directory verify-E2-T07` passed the shared `47` test files /
  `503` tests, the deterministic matrix (`runs=2`, `36/36` tests), three-case
  sensitivity check, E2-T06 standing checks (`27/27` tests), and the complete standing
  E0–E3 corpus (`9` files / `113` tests), ending with `verify-E2-T07: OK`. Full output:
  `/tmp/e2-t07-after-current-closure.log`.
- Replay: N/A (authorization/evidence/CLI verification only; no browser-reaching code) +
  stream-layer mitigation: deterministic HTTP/decision/no-side-effect goldens,
  parsed sensitivity attacks, the shared test/build gates, and the standing E0–E3
  verification corpus.
