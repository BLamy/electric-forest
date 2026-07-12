---
id: E1-T01
epic: 1
title: "stream-fs core: frozen fs event envelope, metadata + per-file content streams, file CRUD through dispatch, canonical tree digest wired into ef replay"
priority: 101
status: in-progress
depends_on: [E0]
estimate: L
capstone: false
---

## Goal

`packages/streamfs` (`@eforest/streamfs`) exists, builds under all workspace gates, and
makes a filesystem an **entity on the E0 engine**: one metadata stream (stream type
`fs-meta`, registered in the server's reducer registry with a version) plus one content
stream per file, where **every mutation — create, write, delete — flows only through
`POST /streams/:id/dispatch`** and reads never mutate. A pure reducer `fsReducer`
(exported from `@eforest/streamfs` and shipped as a standalone module loadable by
`ef replay --reducer`) folds fs events into a canonical tree state — a lexicographically
key-sorted map `path → { contentStreamId, contentSha256, size }` — and the **canonical
tree digest** is `stateDigest(tree)` from `@eforest/protocol`: lowercase-hex SHA-256 over
the canonically-encoded reduced tree. A "repo" is a named main-branch stream-fs:
`createRepo(name)` yields metadata stream `fs:<name>:main:meta` and per-file content
streams `fs:<name>:main:file:<fileId>`. Two contracts are **frozen here and versioned**
(`FS_EVENT_VERSION = 1`): the fs event envelope (the three payload schemas below) and the
tree-digest recipe. A committed golden fs event log replays through
`ef replay --digest --reducer` to its committed frozen digest, twice in separate
processes with identical output, and flipping any byte that reaches the folded tree
state flips the digest or fails the parse (state-preserving mutations are enumerated
carve-outs per the sensitivity criterion) — so every later Epic-1 task's claim
(directory ops, patches, merges,
convergence) is a digest comparison against this apparatus.

## Context

Epic 1 builds stream-fs (ROADMAP.md, "Epic 1 — the-trunk"): filesystem semantics on the
durable-stream engine E0 verified — server (`packages/server`) with reducer registry,
`/state` / `/events` / validated `/dispatch` (E0-T10/T11), client (`packages/client`),
protocol primitives (`@eforest/protocol`: canonical JSON, `stateDigest`, pure `replay`),
and the citation tools `ef replay` / `ef bisect` (E0-T04/T12). Prior art (read-only, per
AGENTS.md): electric.ax's stream-fs — metadata stream plus per-file content streams — is
the shape we rebuild; its `watch()`, patches, and stale-write handling are E1-T05,
E1-T03, and E1-T04 respectively, and its two missing capabilities (snapshots, branches)
are E1-T07/T08.

This task is the epic's evidence keystone. Every downstream Epic-1 claim — E1-T02's
deterministic listings, E1-T03's patch/full-write digest parity, E1-T06's two-client
convergence, E1-T09/T10's merges, and the E1-T11 capstone's
`replay(main) == merged tree` proof — bottoms out in "replay the fs log, compare tree
digests." So the contract is frozen here exactly as E0-T03 froze the protocol package:
`FS_EVENT_VERSION = 1` is exported, the payload schemas and the tree-state shape are
documented verbatim in the package readme, and any change to either requires a version
bump plus regeneration of every fs golden in the repo — a loud, deliberate event.

Contracts frozen by this task:

- **fs event envelope** — fs events are `@eforest/protocol` `Event`s
  (`{ type, payload, ts }`) with these types and payload schemas, validated by
  `/dispatch` and by runtime guards:
  - `fs.file.create` — `{ v: 1, path, contentStreamId }`
  - `fs.file.write` — `{ v: 1, path, contentSha256, size }` (full-content write; the
    bytes land on the file's content stream, the metadata event records their
    lowercase-hex SHA-256 and byte length)
  - `fs.file.delete` — `{ v: 1, path }`
  Extra fields, missing fields, wrong types, or unknown `fs.*` types are refused by
  dispatch with the log untouched.
- **path rules** — paths are `/`-separated UTF-8 already in NFC form — **dispatch
  refuses any path not in NFC; no normalization is ever performed** — no leading or
  trailing `/`, no empty segments, no `.` or `..` segments, no NUL. These rules are frozen because
  tree keys feed the digest; directory *entities* (mkdir, listings, tombstones) are
  E1-T02 — in this task directories are implicit path prefixes only.
- **canonical tree state** — `{ files: { [path]: { contentStreamId, contentSha256,
  size } } }`, with canonical-JSON key sorting supplying the deterministic order. Deleted
  paths are absent (tombstones are E1-T02's problem, on branch-fork grounds).
- **tree digest** — `treeDigest(state) === stateDigest(state)` from `@eforest/protocol`,
  never a second hashing implementation.

Non-goals: directory operations (E1-T02), text patches (E1-T03), stale-write fencing —
writes in this task are last-write-wins full writes (E1-T04), `watch()` (E1-T05),
snapshots (E1-T07), branches other than `main` (E1-T08). `depends_on: [E0]` means the
E0-T13 capstone is verified: the whole engine below this package is already proven.

## Deliverables

Path anchor: every `evidence/` path in this spec is relative to this task folder,
`.eforest/tasks/epic-1-the-trunk/E1-T01-streamfs-core-tree-digest/`. The Makefile
`verify-E1-T01` recipe must reference these files by repo-root-anchored absolute path
(e.g. via `$(CURDIR)`) so the recipe passes from any cwd.

- `packages/streamfs/` — workspace package `@eforest/streamfs`, wired into the root
  `pnpm format:check` / `lint` / `typecheck` / `test` / `build` gates.
- `packages/streamfs/src/version.ts` — `export const FS_EVENT_VERSION = 1`; package
  readme documents the frozen envelope, path rules, tree-state shape, digest recipe, and
  the invalidation rule (version bump + regenerate every fs golden).
- `packages/streamfs/src/events.ts` — the three event payload types plus runtime guards
  (`isFsEvent`, per-type payload validators) rejecting missing/extra/wrong-typed fields
  and every path-rule violation.
- `packages/streamfs/src/reducer.ts` — `fsReducer(state, event)`: pure (no I/O, no
  `Date`/`Math.random`/env), conforming to the `@eforest/protocol` reducer signature.
  Semantics: `create` on an existing path, and `write`/`delete` on a missing path, are
  reducer-level errors — dispatch validation refuses them before append, so a log
  containing one is corrupt and `ef replay` must exit nonzero on it, not skip it.
- `packages/streamfs/reducer.mjs` (or equivalent built entry, path documented in the
  package readme) — the standalone reducer module loadable by
  `ef replay <dump> --digest --reducer <path>`; this file is the registration of streamfs
  with the evidence tooling and is what every Verification log in Epic 1 cites.
- `packages/streamfs/src/tree.ts` — canonical tree-state type,
  `emptyTree()`, and `treeDigest(state)` delegating to `@eforest/protocol`'s
  `stateDigest`.
- `packages/streamfs/src/fs.ts` — the `StreamFs` client (built on `packages/client`):
  - `createRepo(name)` → creates metadata stream `fs:<name>:main:meta` with stream type
    `fs-meta`; duplicate name refused with a typed error.
  - `openRepo(name)` → binds to an existing repo; missing repo is a typed error.
  - `createFile(path, bytes)` / `writeFile(path, bytes)` — create the content stream /
    append full content, then dispatch the metadata event carrying the content's
    SHA-256 and size. **The metadata stream is mutated exclusively via `/dispatch`.**
  - `readFile(path)` — resolve the path in reduced state, read the content stream,
    verify the bytes' SHA-256 against the reduced state's `contentSha256`; mismatch is
    a typed `ContentIntegrityError`, never silently returned bytes.
  - `deleteFile(path)`, `tree()` (reduced state), `digest()` (tree digest at head).
- Server-side registration: the `fs-meta` stream type bound to `fsReducer` in the E0-T10
  reducer registry with an explicit version, and dispatch-side validation (E0-T11 stage
  order) enforcing the envelope, path rules, and existence preconditions (create-existing
  / write-missing / delete-missing refused, head offset unchanged).
- Committed golden fixture: `evidence/golden-fs.jsonl` — a metadata-stream dump
  exercising create, multiple writes to the same path (last-write-wins), unicode and
  nested paths, delete, and re-create after delete — plus `evidence/golden-fs.digest`
  (the frozen tree digest, produced once, committed, never regenerated by any check that
  consumes it).
- Committed refusal corpus: `evidence/fuzz/` — dispatch bodies that must be refused with
  the log untouched: unknown `fs.*` type, missing/extra/wrong-typed payload fields,
  `v: 2`, every path-rule violation class (`..` segment, empty segment, leading `/`,
  trailing `/`, NUL, non-NFC form of an existing NFC path), create-existing,
  write-missing, delete-missing. Each case's expected refusal (status + error class) is
  asserted by a committed test that also asserts the stream head offset is byte-identical
  before and after.
- Integration tests (`packages/streamfs/test/`) against a real `packages/server` on an
  ephemeral port: CRUD round-trip (write → read byte-identical), the refusal corpus,
  and the differential check — after a scripted session, `GET /state` on the metadata
  stream, `ef replay` over the dumped log with the streamfs reducer, and an in-process
  `replay()` fold all three produce the identical tree digest.
- `Makefile`: `verify-E1-T01` inside the marker section composing the frozen helper
  recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build _v-replay-determinism`) plus a
  streamfs golden step: replay `evidence/golden-fs.jsonl` through
  `ef replay --digest --reducer` **twice as separate `ef` process invocations**, compare
  both digests to each other and to `evidence/golden-fs.digest`, then the sensitivity
  proof — flip one byte of one event in a temp copy and assert the comparison exits
  nonzero, printing `MUTATION fixture=golden-fs byte=<offset> digest-mismatch
  EXPECTED-FAIL OK` only after observing the nonzero exit. Joins `verify-all`;
  `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E1-T01` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E1-T01 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] `ef replay evidence/golden-fs.jsonl --digest --reducer <documented reducer path>`
      (`evidence/` paths relative to this task folder per the Deliverables path
      anchor; the reducer path as documented in the package readme) prints exactly one
      lowercase-hex SHA-256 line on stdout matching `evidence/golden-fs.digest` and exits
      0; two runs in fresh shells produce byte-identical output
      (`diff <(run1) <(run2)` empty). The Makefile step performs this as two separate
      `ef` process invocations, per the recipe text.
- [ ] Sensitivity, scoped to state-reaching mutations: for any single-byte payload
      mutation of a copy of `evidence/golden-fs.jsonl`, the pass condition is a
      three-way disjunction — the replay exits nonzero (parse/validation failure), OR
      prints a digest different from `evidence/golden-fs.digest`, OR the
      **independently-folded final tree of the mutated log equals the original's**
      (i.e., the check compares against the mutated log's own fold, never merely
      golden-vs-digest; a mutation whose fold provably differs from the original tree
      yet replays green to the golden digest is a failure). The honest carve-out
      classes — mutations that are schema-valid, precondition-valid, and
      state-preserving under last-write-wins — must be enumerated explicitly in the
      package readme exactly as `ts` is: payload bytes of a shadowed write (a write to
      a path later overwritten), swaps of adjacent commuting events (e.g. writes to
      different existing paths), and duplicate idempotent writes. The in-target
      mutation step prints `^MUTATION .* digest-mismatch EXPECTED-FAIL OK$` at least
      once — evidence: `make verify-E1-T01 2>&1 | grep -c '^MUTATION .* digest-mismatch
      EXPECTED-FAIL OK$'` ≥ 1, plus a committed sweep test whose domain is pinned to
      **every byte of every payload** in the golden, asserting the disjunction above at
      each position, with carve-out-class positions asserted as expected-green
      (mutated fold identical to the original tree) rather than skipped.
- [ ] A corrupt-log ordering claim holds: a dump containing `fs.file.write` for a path
      never created, or `fs.file.create` for a path already live, makes `ef replay` exit
      nonzero with a diagnostic naming the offending 1-based line — evidence: committed
      test cases in the fuzz corpus fed through the CLI, green under `pnpm test`.
- [ ] One-door proof, mechanical: `packages/streamfs/src` contains no raw-append call
      targeting a metadata stream — evidence: a committed grep-based check (script or
      test) that scans `packages/streamfs/src` for the raw append surface outside the
      dispatch helper, returning nothing. The list of append-capable method names is
      **pinned to an external artifact owned by the E0 client package, not authored by
      this task's builder**: `packages/client` exports a committed `APPEND_SURFACE`
      manifest — the exhaustive list of its public exports whose transitive call graph
      reaches the client's single raw `POST`-append HTTP function (including any
      low-level fetch wrapper or batch-append surface) — maintained under that
      package's own gates, so a new append-capable client export without a manifest
      entry fails E0's checks, not a judgment call here. At check time this task's
      script diffs its documented list against the `APPEND_SURFACE` manifest and fails
      if any manifest entry is absent from the list, so an incomplete list is itself a
      red check. AND a behavioral check — a hand-crafted **raw** append of a
      schema-invalid fs event to a test metadata stream (bypassing `/dispatch`) makes
      **both** the subsequent `GET /state` on that stream **and** `ef replay` of its
      dump fail with a concrete observable — non-2xx status plus an error class from
      `/state`, nonzero exit from `ef replay` — each naming the offending offset;
      either surface returning a folded state or digest for that stream is a failure
      (this is the same demand as attack angle 2, verbatim). Both checks committed
      and green.
- [ ] Refusal matrix: every case in `evidence/fuzz/` dispatched to a live metadata stream
      is refused with its expected status + error class, stdout of the follow-up head
      probe shows the head offset byte-identical before and after, and a valid dispatch
      immediately afterwards succeeds (the stream is not wedged) — evidence: committed
      integration test iterating the corpus, green under `pnpm test`.
- [ ] Content round-trip and integrity: `writeFile(path, bytes)` then `readFile(path)`
      returns byte-identical content for binary and multi-byte-UTF-8 fixtures, and a test
      that corrupts the content stream out-of-band (or forges a mismatching
      `contentSha256` in a crafted dump) gets `ContentIntegrityError` from `readFile`,
      never silent bytes — evidence: committed tests, green.
- [ ] Differential digest agreement: after a scripted CRUD session against a real server,
      the digest from (a) `GET /state` on the metadata stream fed through `treeDigest`,
      (b) `ef replay` over the dumped event log with the streamfs reducer module, and
      (c) an in-process `replay()` fold are all byte-identical — evidence: committed
      integration test printing all three digests, plus the session's dump committed as
      `evidence/e1-t01-session.jsonl` with its digest cited in the Verification log.
- [ ] Repo naming: `createRepo("alpha")` twice — second call refused with a typed error
      and no second stream created; `openRepo("missing")` is a typed error — evidence:
      committed test.
- [ ] `fsReducer` purity: the following exact single-line command returns nothing —
      `grep -rnE --exclude='*.test.ts' --exclude='fs.ts' "Math\.random|Date\.now|process\.env|(from ['\"]|require\(['\"]|import\(['\"])(node:)?(fs|net|http|child_process)['\"/]?" packages/streamfs/src`
      — this command as printed here is binding; the committed evidence transcript
      must reproduce it verbatim (a transcript containing a different command does not
      satisfy this criterion). The scan covers **all of `packages/streamfs/src` except
      `src/fs.ts`** (the client, which legitimately performs I/O), so the transitive
      import closure of `reducer.ts`, `tree.ts`, and `events.ts` is inside the scanned
      set and impurity cannot hide in a sibling helper module. A second mechanical
      check enforces that no scanned module imports `fs.ts`: the exact single-line
      command
      `grep -rnE --include='*.ts' --exclude='fs.ts' --exclude='*.test.ts' "from ['\"]\./fs['\"]|require\(['\"]\./fs|import\(['\"]\./fs" packages/streamfs/src`
      also returns nothing, with its (empty) output committed as evidence alongside
      the first. Additionally the golden digest is identical under
      `TZ=Pacific/Kiritimati LANG=C` vs default env — evidence: both transcripts
      committed under `evidence/`.
- [ ] `FS_EVENT_VERSION = 1` is exported, and the package readme states the frozen
      envelope, path rules, tree-state shape, and the golden-invalidation rule —
      evidence: the committed files.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `tools/verify/self_check.sh`
      passes; `make verify-list` shows `verify-E1-T01` mapped to this task; `verify-all`
      (including every E0 target and the E0-T09 golden transcripts) still green — this
      task is additive to the frozen protocol.
- [ ] Replay browser layer: N/A (library + server + CLI surface only; no
      browser-reaching surface until Epic 3) — the Verification log entry must declare
      this explicitly per AGENTS.md; stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that this apparatus turns filesystem claims into digest
comparisons. Every attack pairs a manipulation with a refutation condition. Use your own
inputs, never the builder's. Any single success refutes.

1. **Sensitivity, your own bytes (mandatory).** Ignore the builder's chosen mutation.
   Sweep your own: (a) flip one byte inside a `contentSha256` hex string, (b) flip one
   byte of a `path`, (c) change a `size` by 1, (d) swap two adjacent events, (e) delete
   the last line, (f) duplicate an event, (g) change a `ts` by 1 — each against a copy of
   `evidence/golden-fs.jsonl`, replayed with the streamfs reducer. Contract, scoped to
   state-reaching mutations: each of (a)–(f) must exit nonzero, change the digest, or be
   a **state-preserving mutation** — verified by independently folding the mutated log
   yourself and comparing its final tree to the original's fold, never merely
   golden-vs-digest. The honest carve-outs, which the package readme must enumerate
   exactly as it does (g)'s: `ts` is envelope metadata that does not enter the tree
   state (g); payload bytes of a shadowed write — the golden mandates multiple writes to
   the same path under last-write-wins, so mutating a shadowed write's `contentSha256`
   or `size` leaves the final tree unchanged (a)/(c); swapping two adjacent commuting
   events, e.g. writes to different existing paths (d); duplicating an idempotent write
   (f). For each carve-out hit, confirm the mutated log's own fold equals the original
   tree — that equality is the contractually expected outcome, not a defect. **Only a
   mutation whose independently-folded tree provably differs from the original's yet
   replays green to the golden digest refutes the entire measuring apparatus** — file
   that as a task refutation, not a bug.
2. **Bypass the door.** The raw protocol append (E0-T05) still exists. Raw-append a
   well-formed-JSON but schema-invalid fs event to a live metadata stream, then hit
   `GET /state` and `ef replay` on its dump. Refutation: either endpoint folds the
   garbage into a tree state and hands back a digest as if nothing happened. Then hunt
   the library: read `packages/streamfs/src` for any code path that mutates a metadata
   stream without `/dispatch` — one such path refutes the one-door claim regardless of
   whether tests catch it. Diff the one-door check's documented append-surface list
   against `packages/client`'s committed `APPEND_SURFACE` manifest, then audit the
   manifest itself against the client's actual exports: any append-capable export
   missing from the list or the manifest refutes the mechanical check. While there, walk the transitive import graph
   of `reducer.ts`/`tree.ts`/`events.ts` and refute the purity claim if any reachable
   module touches I/O, the clock, RNG, or env. Also raw-append a *schema-valid but precondition-violating*
   event (write to a never-created path): replay must go red at that line, proving
   dispatch preconditions are also replay invariants, not just HTTP-time courtesy.
3. **Self-licking goldens.** Delete `evidence/golden-fs.digest` and run the golden step —
   it must fail red, not regenerate-and-pass. Inspect git history and the recipe/test
   code for any path that writes or recomputes the digest at check time. Then derive the
   digest **independently**: parse the jsonl yourself, fold the documented reducer
   semantics by hand (python + `json.dumps(obj, separators=(',',':'), sort_keys=True,
   ensure_ascii=False)` + `shasum -a 256`, hand-deriving where canonical JSON and python
   disagree). An independent derivation that disagrees is a refutation; a digest only the
   package's own code can reproduce is **needs-evidence**.
4. **Content/metadata coherence.** Forge a dump in which a write event's `contentSha256`
   does not match any real content, and separately corrupt a live file's content stream
   via raw append after a valid write. Refutation: `readFile` returns bytes without
   `ContentIntegrityError`, or the tree digest claims to certify content it never hashed
   while the package readme implies otherwise. Verify the docs state precisely what the
   tree digest covers (metadata state including recorded hashes — not a re-hash of live
   content bytes) so no later task over-claims it.
5. **Path-rule fuzz.** Dispatch your own hostile paths: `..%2f` style traversal after
   decoding, `a//b`, `a/./b`, a 10k-segment path, astral-plane and combining-character
   names, the NFD form of an existing NFC path (must be refused per the frozen path
   rules — an accepted NFD path refutes, whether it silently normalizes or creates a
   second tree key for one user-visible name), trailing `/`, empty string, NUL. Every refusal must leave
   the head offset untouched (probe before/after) and the stream usable. Any accepted
   rule-violating path, or any refusal that appended anyway, refutes.
6. **Determinism, environmentally and across sessions.** Replay the golden under
   `TZ=Pacific/Kiritimati LANG=C` vs defaults, from two different cwds, in fresh
   processes — digests must be byte-identical. Then run your own scripted CRUD session
   twice against two fresh server data dirs dispatching identical bodies, dump both
   metadata logs, and compare `ef replay` digests. (Envelope `ts` and generated
   `contentStreamId`s may differ between sessions — so compare *tree digests after
   stripping/normalizing per the documented state shape* only if the docs claim
   cross-session equality; if they don't, confirm the docs scope the determinism claim to
   replay-of-a-given-log. An over-broad claim the evidence can't back is a refutation of
   the claim as written.)
7. **Sabotage the suite.** In a scratch worktree, break the implementation four ways:
   (a) make `fsReducer` ignore `fs.file.delete`, (b) make the tree key order
   insertion-order instead of canonical, (c) make `treeDigest` hash `JSON.stringify`
   output, (d) make dispatch validation accept `v: 2`. For each: `pnpm test` **and**
   `make verify-E1-T01` must go red. Any sabotage that stays green refutes whichever gate
   it slipped past. Check the diff for `.skip`/`.todo`/inline lint disables while there.
8. **Differential triangle.** Run your own session, then compare all three digest sources
   (server `/state` + `treeDigest`, `ef replay --reducer` on the dump, direct
   `@eforest/protocol` `replay()` fold in a scratch script). Any disagreement refutes —
   the CLI, the server, and the library must be three mouths on one reducer, not three
   reducers.
9. **Freeze audit.** Confirm `FS_EVENT_VERSION` is exported and the invalidation rule is
   documented. In a scratch worktree, change one frozen detail (add a payload field to
   `fs.file.write`, or reorder tree-state fields) and confirm the committed golden goes
   red. A schema change all goldens survive refutes the claim that the goldens pin the
   contract. Also confirm `verify-all` still runs every E0 target green — a protocol
   regression smuggled in by this package refutes its "additive" claim.
10. **Coverage.** Hold the claimed final run against the diff: `createRepo` duplicate
    refusal, `openRepo` missing, every refusal-corpus class, `ContentIntegrityError`,
    the corrupt-log nonzero-exit path, and the sensitivity sweep must each have been
    executed by a committed test or a cited transcript. Unexecuted diff is unproven or
    dead — builder picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your independent digest derivation as a committed cross-check, and
any fuzz path/dump that found interesting surface into the refusal corpus.

## Verification log

### 2026-07-12 — builder — implemented

Implementation commits: `ad1dfd0` (`feat: implement E1-T01 streamfs core`) and
`2676ee9` (`fix: preserve redux replay verification path`). The new
`@eforest/streamfs` package freezes `FS_EVENT_VERSION = 1`, validates the exact fs
event envelope and NFC path rules, reduces metadata into the canonical tree, delegates
tree digests to `@eforest/protocol`, registers `fs-meta` with version `fs-v1`, and
provides `StreamFs` CRUD/read-integrity operations. Metadata mutations use `/dispatch`;
content bytes use per-file streams. `ef replay --reducer packages/streamfs/reducer.mjs`
is the standalone evidence path.

Fresh builder verification:

```text
CI=true make verify-E1-T01                         PASS (104 tests + refusal corpus)
CI=true pnpm format:check                          PASS
CI=true pnpm lint                                  PASS
CI=true pnpm typecheck                             PASS
CI=true pnpm test                                  PASS (104 tests + refusal corpus)
CI=true pnpm build                                 PASS
CI=true tools/verify/cold_clone.sh verify-E1-T01   PASS from pristine clone
```

The additive compatibility checks also pass at `2676ee9`: `CI=true make verify-E0-T10`
and `CI=true node tools/verify/bisect_critic_attacks.mjs` (10 fresh E0-T12 cases).

Stream-layer evidence:

- `evidence/golden-fs.jsonl` and `evidence/e1-t01-session.jsonl` replay to the frozen
  digest `f82e923ccbdc281b11f364372d4915984f9ae3ede04c874b12b916b90581e107` in two
  separate CLI processes; `evidence/golden-fs.digest` is the committed expected value.
- The sensitivity verifier swept all `904` payload bytes: `495` parse failures, `258`
  digest mismatches, and `151` independently confirmed state-preserving carve-outs.
  It printed `MUTATION fixture=golden-fs byte=651 digest-mismatch EXPECTED-FAIL OK`.
- The committed refusal corpus exercised `15` cases with byte-identical heads before
  and after refusal plus a valid follow-up; two raw-bypass streams made `/state` return
  `reducer_error` with an offset and made `ef replay` fail at line 1.
- The append-surface audit matched the external `packages/client` `APPEND_SURFACE`
  manifest; the exact purity and `TZ=Pacific/Kiritimati LANG=C` digest transcripts are
  committed under `evidence/`.

Replay: N/A (library + server + CLI surface only; no browser-reaching surface until
Epic 3) + mitigation: committed event logs, reducer replay digests, raw-bypass
diagnostics, refusal corpus, integrity tests, full gates, and the cold-clone check.

The final builder run demonstrates deterministic fs replay, CRUD and binary content
integrity, dispatch-only metadata mutation, side-effect-free invalid-action refusal,
reducer-visible corrupt logs, and environment-independent tree digests. It is ready for
a fresh adversarial critic; the task remains `implemented` until that critic promotes
or refutes it.

### 2026-07-12 — critic — VERDICT: needs_revision

- P1/ERROR Unicode scalar path rejection — FAILED. Predicted a lone high surrogate in a
  dispatched path would be refused because the frozen contract requires UTF-8/Unicode
  scalar paths; observed `POST /streams/fs:surrogate:main:meta/dispatch` return `201` and
  append offset `0000000000000000_0000000000000000` for path `a/\ud800`. The defect is
  `packages/streamfs/src/events.ts:57-68`: `charCodeAt(index + 1)` is `NaN` at end of
  string, so both range comparisons are false and `isUnicodeScalarString()` returns
  true. Reject the missing low-surrogate case, then re-run the path attack and full gates.
- P2/COVERAGE one-door mechanical audit — INSUFFICIENT. Predicted the committed audit
  would scan all of `packages/streamfs/src` for metadata raw appends; observed
  `tools/verify/streamfs_append_audit.sh:16` and `:29` scan only `packages/streamfs/src/fs.ts`.
  A raw append introduced in `src/server.ts` or another sibling would pass this check.
  Change the audit to scan the whole source directory while explicitly allowing only the
  dispatch helper, re-run the append audit, and re-record the proof.

Independent critic evidence at final tip `cd6317d`:

- `pnpm test` passed 15 files / 104 tests and the promoted refusal corpus printed
  `cases=15 raw-bypass=2 head-neutral follow-ups=all OK`.
- `make verify-E1-T01` passed the full current target, including the 904-byte sensitivity
  sweep (`495` parse failures, `258` digest mismatches, `151` state-preserving cases),
  golden replay, refusal corpus, append audit, purity check, and workspace gates.
- Independent golden mutations for content hash, path, size, adjacent commuting events,
  deletion, duplicate idempotent write, and `ts` produced either a refusal/digest change
  or an independently folded state-preserving result. Independent environment/cwd replay
  matched the frozen digest; the server-state / `ef replay` / protocol-`replay()` triangle
  matched on a fresh Unicode CRUD log; binary-content corruption raised
  `ContentIntegrityError`; raw precondition bypass returned `/state` `422` with offset and
  `ef replay` exited nonzero at line 1; the frozen extra-field mutation went red.
- `make verify-E0-T10` passed at `2676ee9`, and `node tools/verify/bisect_critic_attacks.mjs`
  passed 10 fresh E0-T12 cases. The `cd6317d` `tools/test.mjs` hunk is covered by the
  clean test run because it now builds and executes the refusal corpus after Vitest.

Replay: N/A (library + server + CLI surface only; no browser-reaching surface until Epic
3) + mitigation: stream-layer logs, independent reducer folds, live dispatch probes,
CLI replay failures, the differential triangle, committed tests, and full gates.

Status returned to `in-progress`; fix both findings and record a new critic-ready proof.
