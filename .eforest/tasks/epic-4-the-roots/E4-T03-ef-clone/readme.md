---
id: E4-T03
epic: 4
title: "ef clone: materialize a branch stream into a fresh working directory with an exact offset checkpoint"
priority: 403
status: in-progress
depends_on: [E4-T01]
estimate: M
capstone: false
---

## Goal

`packages/cli`'s `ef` binary ships `ef clone <org>/<repo> [branch] [dir]`
(`branch` defaults to `main`, `dir` defaults to the repo name, server URL from
`--server`/`EF_SERVER`/the E2-T05 credential store, bearer token from the E2-T05
credential store when present): it resolves the repo through the E2-T06 namespace
reducer to the branch's stream-fs streams (`fs:<org>/<repo>` per branch), reads the
branch metadata stream's **head offset `H` once** at clone start, materializes the
reduced tree **as of exactly `H`** into a freshly created `dir` — via the E1-T07
`bootstrapRead` path (newest snapshot, digest-verified against its announced
`stateDigest`, then tail to `H`) when a snapshot exists, via full replay from offset
`-1` otherwise, both funneling into the E1-T06 deterministic tree writer (sorted
traversal, exact content bytes, no timestamp/locale/umask/cwd dependence) — and writes
`.ef/` in the **E4-T01 frozen workspace format**, checkpointed at exactly `H`: the
branch identity, server URL, per-stream offset checkpoints, and the per-file base
ledger whose digests are the E4-T01 `ef tree-digest` currency. On success it prints
exactly two lines on stdout — `checkpoint <H>` and the lowercase-hex SHA-256 canonical
tree digest of the materialized tree — and exits 0, and that digest equals both
`ef tree-digest <dir>` and `ef materialize <branch-dump> --at <H>`'s digest, always.
Non-main branches clone by name through the same path, and an **empty repo** (a branch
stream carrying zero stream-fs events) clones cleanly: the result is a directory
containing only a valid `.ef/`, checkpointed at the branch head, whose printed digest
equals the digest of the empty projection `{ files: {} }` under the frozen E4-T01
recipe (`WORKTREE_DIGEST_VERSION = 1` — equivalently, `ef tree-digest` of an empty
directory) — not an error, not a missing directory. Failure at any point (refused
read, unknown repo or branch, `--at` offset violation, snapshot integrity mismatch,
corrupt event, non-empty target, network death mid-stream) exits nonzero with a typed
one-line error and leaves **no directory containing a valid `.ef/`** — "valid" meaning
`ef workspace check <dir>` exits 0, per the validity-marker contract frozen below — a
clone either completes exactly or visibly does not exist. `make verify-E4-clone` proves all of it from a cold
clone of this repo against a cold-started server seeded with the E3-T01 corpus, so this
task does not wait on `ef init` (E4-T02): the corpus's pinned manifest digests are the
independent expected values every clone is judged against.

## Context

Epic 4 is the git-shaped CLI, and `ef clone` is its read side: every later task stands
on a working directory whose relationship to the branch stream is *exact and recorded*.
E4-T04 (`ef status`) classifies the tree against the `.ef/` base ledger this task
writes; E4-T05 (`ef checkout`) rematerializes onto another branch from the same
machinery; E4-T06/T07 (the sync engines) resume from the offset checkpoint recorded
here; the E4-T12 capstone's two machines each begin life as an `ef clone`. If the
checkpoint is off by one event, or the tree drifts from `replay(branch)` at the
recorded offset by a single byte, every downstream convergence claim inherits the lie —
which is why this task's whole acceptance surface is digest equality against
independently pinned values, not "the files look right."

Nothing here is a new materialization algorithm: E1-T06 froze `ef materialize`'s
deterministic tree writer and `--at <offset>` lens, E1-T07 froze snapshot bootstrap
(digest-verified, tail from `O + 1`) and `410 Gone` retention, and E4-T01 froze the
`.ef/` workspace format and `ef tree-digest` with byte-parity to the stream-fs tree
digest. This task is the composition: those paths driven over live HTTP against an
authenticated server (E2-T03/T07 bearer enforcement — public repos readable
tokenless, private ones only with a member token per the E2-T07 decision matrix),
producing a workspace instead of a scratch dir. The E3-T01 corpus is the proving
ground by design: `maple/reading-room` gives a public repo with two diverged branches
(`main`, `feature/typography`, fork at the manifest's `fork_offset` anchor), renames,
tombstones, and patch chains — exactly the shapes a naive clone resurrects or
mismaterializes — with every head offset and state digest already pinned in
`evidence/corpus-manifest.json`; `maple/secret-garden` gives the private repo the
refusal path is proven against. Depending on the corpus rather than `ef init` keeps
this task's evidence anchored to goldens that predate this diff.

Contracts frozen here (later changes invalidate standing verifications, loudly):

- **Clone output contract**: success prints exactly `checkpoint <H>` then one
  lowercase-hex SHA-256 tree-digest line on stdout, exit 0; diagnostics go to stderr.
  With `--at <offset>`, the first line is `checkpoint <offset>` — the historical
  offset recorded in `.ef/`, never the branch head. In every mode the printed
  checkpoint value is byte-identical to the checkpoint `.ef/` records. Scripts
  (E4-T09's harness, the E4-T12 capstone) parse these two lines.
- **Checkpoint exactness**: the offsets recorded in `.ef/` are the offsets the
  materialized tree is the reduction of — the invariant is
  `ef tree-digest <dir> == digest(materialize(branch log, --at checkpoint))`,
  regardless of what the server appended after clone start. `H` is sampled once;
  events appended during the clone are not consumed and not checkpointed.
- **Workspace validity marker** (frozen *here* — the E4-T01 format deliberately
  defines per-file `load()`/`save()` semantics only, no whole-directory validity
  notion): a `.ef/` is **valid** iff the marker file `.ef/complete` exists with
  content exactly the canonical JSON `{ "v": 1 }` *and* the E4-T01 `load()` accepts
  the workspace. The marker is written last: only after every working-tree file and
  every other `.ef/` file has been written and fsynced, itself via the E4-T01 atomic
  `save()` path (temp file, fsync, rename). The runnable decision procedure is
  `ef workspace check <dir>` (shipped by this task): exit 0 iff valid; nonzero with a
  typed one-line error otherwise (marker absent, marker content wrong, or any `load()`
  refusal). Every "valid `.ef/`" claim in this spec means exactly
  "`ef workspace check <dir>` exits 0".
- **All-or-nothing**: `.ef/` becomes valid (per the validity-marker contract above)
  only as the final step of a fully verified materialization; any interrupted or
  failed clone leaves no directory for which `ef workspace check` exits 0.
  E4-T04..T08 must gate on that check (equivalently, require the marker) before
  treating the base ledger and checkpoint as trustworthy — and may then trust them
  without re-deriving.
- **Bootstrap/replay parity**: clone-via-snapshot and clone-via-full-replay of the
  same branch at the same offset produce byte-identical directories including `.ef/`.
  Which path ran is an implementation detail invisible in the artifact.

Non-goals: no writes to any server stream (clone is read-only; the log is untouched —
provable by head/digest comparison before and after); no `ef init` (E4-T02), no
branch switching (E4-T05), no live tailing past `H` (E4-T07); no new protocol or
server behavior — a door that misbehaves under clone is a finding against its owning
task.

## Deliverables

- `packages/cli`: `ef clone <org>/<repo> [branch] [dir]` — argument/flag parsing
  (`--server`; `--at <offset>` for cloning at a historical offset, following the
  frozen E1-T06 `--at` rule exactly: the offset **must name an event offset present
  in the branch log** — an offset greater than head, or one naming no event, is
  `EBAD_OFFSET`, never a silent clamp to head; an `--at` below a compaction point,
  whose events are `410 Gone` per E1-T07, is likewise `EBAD_OFFSET` with stderr
  naming the compaction point), namespace resolution via the E2-T06 reducer view,
  head sampling, snapshot-or-replay materialization over HTTP (E1-T07
  `bootstrapRead` / full replay through the E1-T06 tree writer), `.ef/` emission in
  the E4-T01 format with the `.ef/complete` validity marker (frozen in Contracts
  above) written last, `ef workspace check <dir>` implementing that contract's
  decision procedure, and typed errors (`ETARGET_NOT_EMPTY`, `EREFUSED`,
  `ENOT_FOUND`, `EBAD_OFFSET`, `ESNAPSHOT_INTEGRITY`, `ECORRUPT_EVENT`,
  `EINTERRUPTED` — exact names frozen in the CLI's error module) on every failure
  path, never an untyped stack trace: an unknown org/repo is `EREFUSED`,
  deliberately byte-indistinguishable from the unauthorized-private-repo refusal per
  the E2-T07 privacy-neutrality rule (a prober must not learn whether the repo
  exists); an unknown branch on a repo the caller can read is `ENOT_FOUND` (the
  repo's existence is already disclosed by its readability).
- Refusal behavior: target dir exists and is non-empty → refuse before any network
  read, nothing created; unauthorized private repo → the E2-T07 refusal surfaced with
  its status, no partial directory.
- `tools/verify/clone.sh`, wired as standing Makefile targets `verify-E4-clone` and
  `verify-E4-T03` (standard `_v-*` gates + `verify-E4-clone`), joining `verify-all`
  and `make verify-list` with `tools/verify/self_check.sh` green. The script:
  cold-starts the E2-T02 emulator + auth-enabled server on ephemeral ports and a
  scratch data dir, seeds via `make seed-canopy`, then (1) clones
  `maple/reading-room` `main` and `feature/typography` into scratch dirs and asserts
  each printed digest and `ef tree-digest` output byte-equal the corpus manifest's
  pinned `state_digest`, and each printed checkpoint equals the manifest's
  `head_offset`; (2) clones `main` a second time into a second dir and asserts
  `diff -r` empty between the two clones including `.ef/`; (3) dumps the branch log,
  runs `ef materialize <dump> --at <checkpoint>` and asserts digest equality with the
  clone; (4) appends one post-seed event through `/api/dispatch`, clones again, and
  asserts the new checkpoint equals the new head while the *old* clone still
  digest-matches materialize-at-*its*-checkpoint; (5) snapshots + compacts the branch
  (E1-T07), re-clones, asserts the digest is unchanged from the pre-compaction
  clone, and asserts the `410 Gone` path actually ran: the transcript must show a
  logged `410` response (or an event-read count strictly below the pre-compaction
  event count) during the post-compaction clone — digest equality alone does not
  pass this step; (6) probes the private repo with a non-member token (refused, no directory,
  server log-neutral) and re-verifies head offset + `ef replay --digest` unchanged
  after the entire run (clone wrote nothing); (7) sensitivity — a corrupted-transfer
  clone (one event byte flipped through a fault-injection proxy or store mutation in
  a scratch data dir) must exit nonzero with `ECORRUPT_EVENT`-class failure and leave
  no valid `.ef/`.
- Committed tests (harness suite), green under `pnpm test`: clone determinism (two
  clones `diff -r` empty), checkpoint-equals-materialize invariant under a
  mid-clone concurrent append (writer injected between head sampling and tail
  completion), snapshot-vs-full-replay byte parity, `--at <offset>` historical clone
  matching `ef materialize --at` for ≥2 offsets including the corpus `fork_offset`,
  every typed-error path (non-empty dir, refused read, unknown org/repo —
  `EREFUSED`, its error output byte-identical in shape to the
  unauthorized-private-repo refusal — unknown branch on a readable repo
  (`ENOT_FOUND`), `--at` greater than head or naming no event offset
  (`EBAD_OFFSET`), `--at` below a compaction point after an E1-T07 snapshot +
  compaction (`EBAD_OFFSET`), snapshot integrity mismatch, truncated stream
  mid-clone via a killed transfer) each asserting exit code, error
  name, and absence of a valid `.ef/` (`ef workspace check` nonzero or target
  absent), read-only-ness (head offset + stream
  digest identical before/after a successful clone), empty-repo clone (a repo whose
  branch stream carries zero stream-fs events — created through the E2 dispatch doors
  in the test's scratch server — clones to a directory containing only a valid `.ef/`,
  checkpoint equal to the branch head, printed digest byte-equal to the digest of the
  empty projection `{ files: {} }` per the frozen E4-T01 recipe
  (`WORKTREE_DIGEST_VERSION = 1`) — the expected value derived in the test from
  `worktreeDigest` on that projection or `ef tree-digest` of an empty scratch
  directory, never from the clone under test — and `ef tree-digest <dir>` agrees),
  and checkpoint-tamper detection:
  hand-editing one digit of the recorded checkpoint in a finished clone's `.ef/`
  makes the `ef tree-digest <dir>` vs `ef materialize <dump> --at <checkpoint>`
  comparison fail (nonzero exit / digest mismatch) — the runnable check a tampered
  checkpoint cannot survive.
- `evidence/`: the recorded final-run transcripts — clone stdout captures, the branch
  dumps used, digest comparison output, and the interrupted/corrupt-clone failure
  transcripts. Replay browser evidence: N/A per AGENTS.md 3a (no browser-reaching
  surface; CLI + stream layer), declared in the claim with the digest/transcript
  evidence as mitigation.

## Acceptance criteria

- [ ] From a cold clone of this repo via `tools/verify/cold_clone.sh` (scrubbed env:
      `NODE_OPTIONS`, `NODE_ENV`, `npm_config_*` unset), `make verify-E4-clone` and
      `make verify-E4-T03` exit 0 with zero `SKIPPED:` lines, cold-starting emulator,
      server, and seed themselves. Evidence: the critic reruns both cold.
- [ ] Digest identity against independent goldens: for each of `main` and
      `feature/typography` on `maple/reading-room`, the clone's printed tree digest,
      `ef tree-digest <dir>`, `ef materialize <branch-dump> --at <checkpoint>`'s
      digest, and the E3-T01 manifest's pinned `state_digest` are all byte-equal, and
      the printed `checkpoint` equals the manifest's `head_offset`. Evidence: the
      verify transcript + the critic re-deriving each digest independently.
- [ ] Checkpoint exactness under concurrency: with a writer appending through
      `/api/dispatch` during the clone, `ef tree-digest` of the finished clone equals
      `ef materialize --at <recorded checkpoint>` of the branch dump — never the
      post-append head state. Evidence: committed test + the critic's own mid-clone
      appends.
- [ ] Bootstrap/replay parity: cloning the same branch at the same offset before and
      after snapshot + compaction yields `diff -r`-empty directories including
      `.ef/`; a clone of the compacted branch never receives events below the
      compaction point (the `410 Gone` path is exercised, not avoided) — proven by a
      concrete observable, not digest equality alone: the verify step (5) transcript
      or a committed test asserts a logged `410` response (or an event-read count
      strictly below the pre-compaction event count) during the post-compaction
      clone. Evidence: committed test + verify step (5), including the `410`/read-count
      assertion.
- [ ] Determinism: two clones of the same branch against the same server state are
      byte-identical under `diff -r` including `.ef/` — no timestamps, ports, token
      bytes, or absolute paths in any written file (committed pattern sweep over a
      fresh clone's `.ef/`). Evidence: committed test + sweep.
- [ ] All-or-nothing: every failure path — non-empty target (refused pre-network),
      unauthorized private repo and unknown org/repo (both `EREFUSED`,
      indistinguishable per E2-T07 privacy neutrality), unknown branch on a readable
      repo (`ENOT_FOUND`), `--at` greater than head, naming no event offset, or below
      a compaction point (all `EBAD_OFFSET`), snapshot artifact with one flipped byte
      (`ESNAPSHOT_INTEGRITY`), one corrupted event in transfer (`ECORRUPT_EVENT`),
      transfer killed mid-materialize — exits nonzero with its frozen typed error and
      leaves no directory for which `ef workspace check` exits 0 (the validity check
      frozen in Contracts); a subsequent clean clone into a
      fresh dir succeeds. Evidence: committed tests per path + committed failure
      transcripts.
- [ ] Read-only: the branch metadata stream's head offset and `ef replay --digest`
      digest are identical before and after the entire verify run's clones and
      refused probes — clone appends nothing anywhere. Evidence: verify step (6)
      assertion + the critic's own before/after digest.
- [ ] Authorization is live: `maple/reading-room` (public) clones tokenless;
      `maple/secret-garden` with a `willow`-member token is refused with the E2-T07
      shape and creates nothing; the same repo clones successfully with a
      `maple`-member token minted from the cold-started emulator. Evidence: verify
      transcript + the critic's own freshly minted tokens.
- [ ] `--at <offset>` historical clone: cloning `reading-room@main` at the corpus
      `fork_offset` anchor yields a tree whose digest equals
      `ef materialize <dump> --at <fork_offset>`, its `.ef/` checkpoint records
      `fork_offset`, not head, and its first stdout line is exactly
      `checkpoint <fork_offset>` per the frozen output contract. Evidence: committed
      test citing the manifest anchor and asserting the stdout line.
- [ ] Empty repo and non-main branch: cloning a zero-fs-event repo yields a directory
      containing only a valid `.ef/`, exit 0, checkpoint equal to the branch head, and
      a printed digest byte-equal to the digest of the empty projection
      `{ files: {} }` per the frozen E4-T01 recipe (equivalently, `ef tree-digest` of
      an empty directory — derived from the frozen instrument, not from the clone
      under test); cloning
      `feature/typography` by name yields the manifest-pinned digest for that branch,
      not `main`'s. Evidence: committed tests + the manifest's per-branch digests.
- [ ] Standing-gate wiring: `verify-E4-clone` and `verify-E4-T03` appear in
      `verify-all` and `make verify-list`; `bash tools/verify/self_check.sh` exits 0;
      re-running `verify-all` on this tree stays green. Evidence: the critic reads
      the Makefile and reruns.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0 from the cold clone.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with the clone transcripts, dumps, and digest comparisons as the
      stream-layer mitigation.

## Adversarial verification

The claim under attack: "a clone is an exact, recorded materialization — the tree is
byte-for-byte `replay(branch)` at the checkpoint `.ef/` records, the checkpoint is the
head that was actually consumed, two clones are indistinguishable, and a clone that
cannot be exact does not exist." Every Epic 4 sync claim will resume from this
checkpoint; if it can be off by one event or the tree can drift one byte, refute it
here. Use your own offsets, tokens, and byte positions throughout; invent at least one
angle beyond these.

1. **Checkpoint honesty under a hostile writer (mandatory).** Race the clone yourself:
   script appends through `/api/dispatch` fired continuously while `ef clone` runs (and
   one aimed precisely between head sampling and first read, via a pause hook or
   proxy delay if the tests expose one — if they don't, that's a coverage finding).
   For every finished clone, independently compute
   `ef materialize <fresh-dump> --at <the .ef/ checkpoint>` and compare digests. A
   single mismatch — tree ahead of checkpoint, behind it, or a checkpoint recording
   the post-append head — refutes the exactness contract. Then hand-edit the
   checkpoint in a scratch clone's `.ef/` (one offset digit) and run the committed
   checkpoint-tamper check this task ships (deliverables): `ef tree-digest <dir>`
   compared against `ef materialize <fresh-dump> --at <the tampered checkpoint>` must
   exit nonzero / report a digest mismatch — a tampered checkpoint that still passes
   that comparison refutes the exactness contract.
2. **Differential clone: snapshot vs replay vs materialize.** Clone the same branch
   three ways — pre-compaction (full replay), post-compaction (snapshot bootstrap),
   and offline via `ef materialize` of a dump at the same offset — and `diff -r` all
   three pairwise (working trees byte-exact; `.ef/` byte-exact between the two real
   clones). Any differing byte refutes bootstrap/replay parity. Then corrupt the
   snapshot artifact in the server's scratch data dir (one byte; also try a
   *consistent* rewrite of artifact body and its own header) and re-clone: anything
   other than a typed `ESNAPSHOT_INTEGRITY` failure with no valid `.ef/` — especially
   a green clone with a wrong tree — refutes the integrity anchor.
3. **Kill it mid-flight, everywhere.** SIGKILL the clone process at several points
   (during tail, during file writes, between last file and `.ef/` finalization —
   loop a randomized-delay kill ≥20 times). After every kill: the target must
   contain no valid `.ef/` (run `ef workspace check <dir>` — the validity check this
   task freezes and ships — and demand nonzero), and `ef status`-style
   consumers must refuse it, and a fresh clone into a new dir must succeed and
   digest-match. A single kill that leaves a valid-looking `.ef/` with a partial
   tree refutes all-or-nothing. Also kill the *server* mid-clone: the client must
   fail typed, not hang or half-succeed.
4. **Corrupt the wire.** Flip one byte of one event in transit (fault-injection
   proxy) and separately in the scratch store; truncate the stream response
   mid-record; reorder is impossible by protocol but try a duplicate record. Every
   corruption must produce a nonzero typed failure and no valid `.ef/`; a clone that
   completes green on corrupted input refutes the verifying-materialization claim.
   Pick your own bytes — do not reuse the builder's committed corruption cases.
5. **Determinism under hostile environment.** Two clones from different cwds, umasks
   (`022` vs `077`), `TZ`/`LANG` values, and ephemeral ports: `diff -r` must be
   empty including `.ef/`. Grep a fresh clone's `.ef/` and the CLI source for
   `Date.now`, `Math.random`, `crypto.randomUUID`, `os.tmpdir`, absolute paths, and
   token bytes reaching written files. One varying byte or one leaked secret
   refutes.
6. **Golden-as-echo attack.** Read `tools/verify/clone.sh` and the tests: is any
   expected digest computed by cloning and then compared to itself? The expected
   values must come from the E3-T01 committed manifest (or `ef materialize` over a
   dump — an instrument frozen before this diff). In a scratch worktree, sabotage
   the tree writer (make tombstone application a no-op; drop the last patch of the
   corpus patch chain) and run `verify-E4-clone`: it must go red naming the digest
   mismatch. A green run under either sabotage refutes the entire measuring
   apparatus. Also sabotage the checkpoint (record `H-1`): the
   materialize-at-checkpoint comparison must catch it.
7. **Authorization and read-only-ness with your own identities.** Mint your own
   tokens (a `willow` member, a subject the seed never used, no token at all) and
   attempt `maple/secret-garden`: every refusal must match the frozen E2-T07 shape,
   create nothing on disk, and be log-neutral (head + `ef replay --digest` identical
   before/after your barrage — on the private repo's streams *and* the identity
   streams). Probe repos and orgs that do not exist (`maple/nope`, an org the seed
   never created) with and without tokens: each must fail `EREFUSED` with an error
   shape byte-indistinguishable from the private-repo refusal — a distinguishable
   "not found" leaks repo existence and refutes the E2-T07 privacy-neutrality rule.
   Abuse `--at` (head+1, an offset naming no event, an offset below the compaction
   point after step (5)'s compaction): each must fail `EBAD_OFFSET` typed, creating
   nothing — an untyped stack trace on any of these probes refutes the
   every-failure-path-typed claim. Then verify a successful clone appended nothing:
   enumerate every stream
   on the server before and after and compare heads. Any new event refutes clone's
   read-only contract.
8. **Coverage and sabotage of the verdict machinery.** Hold the recorded run against
   the diff: the `--at` path (the valid case *and* the `EBAD_OFFSET` cases —
   greater-than-head, non-event offset, below-compaction), every typed-error branch
   (all seven frozen names, including `EREFUSED` on unknown repos and `ENOT_FOUND`
   on unknown branches), and the `410`/snapshot
   bootstrap path must each have executed in a committed test or the recorded
   transcripts — unexecuted diff is unproven or dead. In a scratch worktree, make
   the verify script's `diff -r` compare a dir to itself and its digest comparison
   always-equal: `make verify-E4-clone` or `self_check.sh` must go red. Sweep the
   diff for `.skip`/`.todo`/inline lint disables.

Refutation currency: a checkpoint whose materialize-at digest differs from
`ef tree-digest` of the clone (cite both digests + the dump + offset), two clones with
a differing byte (cite the path), a kill or corruption that leaves a valid `.ef/`
(cite the marker and the missing/wrong paths), a cross-tenant clone that creates a
directory or touches a log (cite offsets before/after), or a sabotaged tree writer
the verify target stays green on. "Clone should also start the watcher" is E4-T07/T08's
row, not a finding. No refutation → promote your sharpest race or corruption case
(exact injection point + predicted typed failure) as an additional committed test.

## Verification log

### 2026-08-04 — builder — provider boundary recheck — status remains `in-progress`

- Rechecked the published dependency rather than assuming the locked version was
  current: `npm view @durable-streams/server version versions --json` reports the
  latest release as `0.3.8`.
- Unpacked `@durable-streams/server@0.3.8` and audited its shipped `server` and
  `store` sources. The release still exposes no `compact`, `discard`, or physical
  retention operation; its `410` handling is for soft-deleted streams only.
- The committed verifier remains decisive on the actual branch: core clone and the
  Auth0/platform matrix pass, then `bash tools/verify/clone.sh` exits 1 after
  `physical-compaction=not-observed status=200 logical=...` with
  `E4_T03_BLOCKED`.
- This is not solvable by a dependency bump or an application-layer fake: the repo's
  architecture delegates transport/storage to the published provider and forbids a
  second Durable Streams transport. Status remains `in-progress` pending provider
  support or an explicit scope decision.
- Replay: N/A (CLI + stream-layer change; no browser-reaching surface) + mitigation:
  committed clone/auth tests, provider-version audit, digest/transcript evidence,
  and the explicit failing physical-retention gate.

### 2026-08-04 — builder — rework — commit `5ac5b449` — status remains `in-progress`

- Hardened the refuted boundaries: bounded typed `EINTERRUPTED` transport,
  preservation of pre-existing empty targets, byte-identical `EREFUSED` unknown
  and unauthorized repository errors, and host/port-free workspace identity.
- Added provider-retained `/dump` fallback support, snapshot/full-replay parity,
  checkpoint-tamper, read-only, and interruption coverage; switched verifier
  success clones to the shipped `ef` binary.
- Added a real Auth0 emulator + platform JWT/grant/membership matrix. Focused
  tests passed 2 files / 13 tests; lint, typecheck, and build passed; the auth
  verifier passed `public=tokenless private=maple-member refused=willow-member`.
- The clone verifier reports `physical-compaction=not-observed status=200
  logical=...`: the configured `@durable-streams/server@0.3.7` provider exposes
  only the logical snapshot anchor, not physical prefix discard/410. The standing
  `bash tools/verify/clone.sh` therefore exits with `E4_T03_BLOCKED` after the
  Auth0 matrix, and this task remains `in-progress`.
- Replay: N/A (CLI + stream-layer change; no browser-reaching surface) +
  mitigation: committed tests, corpus replay/materialization digests, live auth
  transcript, read-only comparisons, and the explicit provider-boundary failure.

### 2026-08-04 — builder — implemented — commits `78cfd278`, `e11fab41`, `75647039`

- Implemented `ef clone <org>/<repo> [branch] [dir]`, `--server`, `--at`, the
  `ef workspace check <dir>` validity decision, deterministic tree materialization,
  snapshot-or-replay bootstrap at an exact sampled offset, canonical `.ef/`
  workspace state, typed failures, and read-only namespace/stream access.
- Added committed tests in `packages/cli/src/clone.test.ts` for exact bytes,
  repeat determinism, concurrent append checkpointing, historical and empty
  clones, target refusal, missing branches, bad offsets, 410/compaction mapping,
  corrupt content, snapshot integrity, and marker absence on failure.
- Added `tools/verify/clone.sh`, `tools/verify/e4_t03_clone.mjs`, Makefile
  targets `verify-E4-clone`/`verify-E4-T03`, and the cold-clone target registry.
  The verifier seeds the committed E3-T01 corpus into a fresh official
  Durable Streams server and compares clone output to independent corpus replay
  digests, including main, `feature-typography`, fork-offset, post-append,
  snapshot, corruption, and refusal cases.
- Gates passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `CI=true pnpm test` (49 files / 513 tests), `pnpm build`,
  `bash tools/verify/self_check.sh`, and `make verify-E4-clone`.
- The final committed head `75647039` also passes both registered cold-clone
  targets: `bash tools/verify/cold_clone.sh verify-E4-clone` and
  `bash tools/verify/cold_clone.sh verify-E4-T03`. Each ran from a pristine,
  scrubbed checkout, emitted its required `: OK` marker, and produced no
  `SKIPPED:` lines; the root suite reported 49 files / 513 tests and the clone
  suite reported 5 tests.
- Evidence: `evidence/e4-t03-clone-transcript.txt` and
  `evidence/e4-t03-gates.txt`. Stream evidence includes main digest
  `0258a361769008256cb6e970a97bc85b7e42fcbfda62ae4ae6a5ea9685b1af55`, branch
  digest `7953a770e6098c92a1aba1b8957bd7e3e23a44325410b094358b12d46d11bbcb`,
  heads `...0029`/`...0031`, and fork `...0029`.
- Scope note: the committed verifier uses a fresh official Durable Streams test
  server seeded from the E3-T01 corpus and a deterministic refusal fetcher for
  the authorization-negative path. It does not claim a separate E2 emulator or
  browser authorization session; the E2-authenticated live matrix remains for
  independent critic coverage.
- Replay: N/A (CLI + stream-layer change; no browser-reaching surface) +
  mitigation: committed clone tests, corpus replay/materialization digests,
  live offset transcript, snapshot-integrity check, and typed refusal check.

### 2026-08-04 — critic — VERDICT: refuted

- R1 privacy-neutral refusal — FAILED. A fresh tokenless probe against an
  uncreated `acme/nope` repo returned `ENOT_FOUND`, while the private refusal
  returned `EREFUSED`. `packages/cli/src/clone-command.ts:274` treats a 404
  namespace response as a readable direct-stream fallback, and the missing
  physical stream is later mapped at `:436-437`; this leaks existence. Fix the
  no-credential unknown-org/repo path to emit `EREFUSED` with the same stderr
  shape as private refusal, and add a byte-identity test.
- R2 interrupted transfer — FAILED. A fresh fetcher that raised
  `ECONNREFUSED` remained retrying for 15 seconds and never returned from
  `runClone`; `clone-command.ts:468` enters the published stream read without a
  bounded abort budget, so the `EINTERRUPTED` mapper at `:439-442` is not
  reachable for this failure. Add bounded transport cancellation and a test
  asserting typed failure plus no valid target.
- R3 compaction evidence — INSUFFICIENT. The verifier snapshots but never calls
  compaction (`tools/verify/e4_t03_clone.mjs:218-238`), while clone always reads
  the full metadata dump (`packages/cli/src/clone-command.ts:468` and
  `packages/streamfs/src/fs.ts:529-539`). The committed 410 test at
  `packages/cli/src/clone.test.ts:311-321` returns 410 for every stream request,
  not a retained-prefix boundary. Add a real snapshot+compaction run and assert
  a logged 410 or a strictly smaller post-compaction read count.
- R4 authorization matrix — FAILED. The verifier starts only a bare official
  Durable Streams test server (`e4_t03_clone.mjs:106-110`), seeds only
  `reading-room` (`:51-60`), and uses a hand-written refusal fetcher
  (`:262-278`). It never starts the E2 emulator/authenticated platform or
  proves tokenless public, unauthorized private, and authorized private clone
  behavior. Replace the stub with the real cold-started matrix.
- R5 read-only proof — INSUFFICIENT. `e4_t03_clone.mjs:160-200` compares
  different values only around a deliberate append; it never brackets the
  clone/refusal run with unchanged heads and replay digests. Add before/after
  equality for every touched stream.
- F1 determinism — FAILED. `workspaceState` writes `options.serverUrl` into
  `.ef/workspace.json` (`clone-command.ts:411-418`), so ephemeral host ports are
  persisted despite the criterion forbidding ports in written workspace state.
  Normalize or remove that field and add the committed pattern sweep.
- F2 failure cleanup — FAILED. `targetState` records whether the directory
  existed at `clone-command.ts:455`, but the failure path at `:498-501` always
  recursively removes it. A failed clone into an existing empty directory can
  delete the user's directory. Only remove directories created by this clone.
- F3 coverage — INSUFFICIENT. The changed code lacks committed tests for
  checkpoint tampering, snapshot-vs-full-replay byte parity, truncated/killed
  transfer, read-only before/after, unknown-repo privacy equality, and the
  namespace-resolution branch. Re-submit only after these gaps and the blocking
  refutations are covered by fresh evidence.

Commands/evidence: fresh critic review of `1c979676..9933e937`, independent
source inspection, and disposable live probes against the official test server.
Status returns to `in-progress`; Replay remains N/A because this is a CLI +
stream-layer change.
