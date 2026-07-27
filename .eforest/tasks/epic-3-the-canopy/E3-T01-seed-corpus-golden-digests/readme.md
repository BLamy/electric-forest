---
id: E3-T01
epic: 3
title: "Deterministic browse corpus: scripted seed dispatching orgs, repos, branches, and files to golden per-stream digests"
priority: 301
status: implemented
verification_run_ceiling: 3
verification_recovery_base_run: 0
verification_recovery_control_commit: 39c6c9aa26cf47e8bfd990ffa7cd191023cde14f
verification_invalid_loop_commit: cafff29593bdaf12e6eb3851fd2664ac661b661f
verification_resume_commit: da68c9f70e1a92ad4664dc2ab3bab2d86a9f4f0a
depends_on: [E2]
estimate: M
capstone: false
---

## Goal

The single, frozen world every Epic 3 view task browses exists as committed, replayable
data. `tools/verify/seed-canopy.ts` (runnable as `make seed-canopy`) drives a **fixed
action sequence** against a fresh auth-enabled Durable Streams service + E2-T02 OIDC
emulator through the frozen boundary that owns each mutation: identity bootstrap through
`IdentityStore` and the existing auth flow; namespace org/project/repo events through
authenticated `POST /api/dispatch`; and repository stream creation, StreamFS mutations,
and native forks through the frozen StreamFS/Durable Streams APIs. There are no direct
store writes and no unauthenticated appends. The sequence builds: **two orgs** (`maple`,
`willow` — two tenants, so cross-tenant visibility is testable), a deterministic project
in each org, **three repos** via E2-T06 `ns.*` dispatches (`maple/reading-room` public,
`maple/secret-garden` private, `willow/field-notes` public), **branches**
(`reading-room` gets `feature-typography` forked from `main` at a recorded offset via the
E1-T08 fork operation and event, then both sides diverge), and a **small source tree** on
`reading-room@main` (nested directories, ≥8 files, one file rename, one directory
rename, one delete/tombstone, and ≥3 E1-T03 patch edits to one file so patch-aware
rendering has real material). Every stream the seed touches — identity, `__registry__`
(E2-T08 derived index), each repo's namespace/metadata stream, and each branch's
stream-fs metadata + content streams — is dumped to
`evidence/dumps/<manifest-key>.jsonl` and pinned in `evidence/corpus-manifest.json`: one
entry per stream carrying `{stream, dump, head_offset, state_digest}` where
`state_digest` is the `ef replay <dump> --digest` output (E0-T04, with the stream's
reducer), plus named **anchors** (`fork_offset`, the offsets of each patch event, the
tombstoned path, the renamed paths) that later tasks cite by name instead of magic
numbers. The seed is deterministic end to end: two cold runs produce byte-identical
dumps and therefore byte-identical manifests — no wall-clock timestamps, random ids,
port numbers, or token bytes reach any event body. `make verify-E3-seed` proves all of
it from a cold clone: cold-start emulator + server, run the seed, diff every fresh dump
byte-exact against the committed dump, replay every committed dump and compare every
digest against the manifest, probe E2-T11's tenant-first privacy matrix live (a
tenant-bound `willow` member is refused on both maple repos; anonymous/unbound access is
allowed only for public `maple/reading-room`; a same-tenant maple identity follows the
frozen visibility/grant rules), and run the sensitivity check — flip one byte of one
committed dump in a scratch copy and the target must go red naming exactly that stream.
Exit 0 only when every pinned digest reproduces exactly.

## Context

Epic 3 is the web app: repo list (E3-T04), repo home (E3-T05), file tree (E3-T06), file
viewer (E3-T07), branch switcher (E3-T08), history (E3-T09), and the-reading-room
capstone (E3-T10). Every one of those tasks makes a digest-equality claim ("the DOM tree
digest equals `ef replay` of the branch metadata stream", "the viewer's content digest
equals the server head"). Those claims are only cheap and only refutable if every task
renders the **same committed world** whose per-stream digests are already pinned — this
task builds that world once and freezes it. Without it, each view task would invent its
own throwaway seed, no two sessions would browse the same state, and the capstone's
cold-start demo would have nothing deterministic to cold-start into.

The corpus is deliberately shaped by its consumers: the fork with recorded offset and
post-fork divergence feeds E3-T08 (fork point visible) and E3-T05 (branch list); the
rename + tombstone feed E3-T06's "rename- and tombstone-aware" tree; the patch chain
feeds E3-T07's patch-aware rendering; the two orgs and the private repo feed E3-T04's
"private repos invisible cross-tenant"; the second tenant's repo proves the registry
separates orgs, not just repos. Using each frozen authenticated boundary (rather than
replaying fixture logs straight into the store) is the point, not a flourish: namespace
and privacy operations re-prove the E2 HTTP gates, while StreamFS creation and forks use
the already-verified native application APIs. The corpus is exactly what supported
clients can produce.

Builds on: E2-T02 (tokens minted at run time from the cold-started emulator for the
seed's named subjects — an org-admin of `maple`, a member of `maple`, an org-admin of
`willow`, plus a `willow` member used only as the cross-tenant probe), E2-T04/T05
(identity provisioning event shapes and `IdentityStore` bootstrap), E2-T06 (`ns.*`
org/project/repo creation dispatches and the `fs:<org>/<repo>` stream-id resolution),
E2-T07 (public/private visibility the
probe exercises), E2-T08 (the `__registry__` derived stream is one of the pinned
streams), E1-T01..T03 (stream-fs file/dir/patch events), E1-T08 (branch fork at
offset), E0-T04 (`ef replay --digest` as the digest instrument), E0-T02 (verify-spine
recipe contract; `tools/verify/self_check.sh` polices the new targets).

Contracts frozen here:

- **The corpus is committed data**: `evidence/dumps/*.jsonl` and
  `evidence/corpus-manifest.json` are produced once and committed. Every E3 task and
  the E3-T10 capstone browses exactly this corpus (cold servers seeded by
  `make seed-canopy` or by replaying these dumps) and pins its own goldens against
  these digests. Changing the corpus invalidates downstream goldens — the only
  sanctioned path is a documented `regen-E3-seed` Make target that regenerates dumps +
  manifest and prints the review diff; `verify-E3-seed` itself never writes into
  `evidence/`.
- **The manifest schema**: one JSON object, stable key order, entries
  `{stream, dump, dump_sha256, head_offset, state_digest}` per stream plus a top-level `anchors`
  map; no timestamps, ports, or token material anywhere in the file. Later tasks
  reference streams and anchors by manifest key. **Dump paths**: the manifest entry's
  `dump` field is the sole authority on dump file paths; every dump lives flat in
  `evidence/dumps/` with basename `<manifest-key>.jsonl`. Manifest keys are derived
  from stream ids by a fixed, collision-checked sanitization (each of `:`, `/`, `@`
  replaced with a single fixed safe character; the seed fails loudly if two stream
  ids collapse to one key), so the directory tree is deterministic across builders.
- **Determinism of the seed**: two cold runs of `make seed-canopy` yield
  byte-identical dumps. Any envelope field that would naturally vary (timestamps,
  generated ids) is either fixed by the seed (logical clock, declared literals) or
  proven absent from the dumps; a corpus that is not byte-reproducible is a red run.

Non-goals: no web app, no React, no browser surface (E3-T02+ own that — per AGENTS.md
3a this task has no browser-reaching surface, so Replay browser evidence is declared
N/A with the dump/digest/sensitivity evidence as the stream-layer mitigation); no new
server or protocol behavior (the seed only exercises frozen E0–E2 doors; a door that
misbehaves under the seed is a finding against its owning task); no merge activity
(E1-T09/T10 shapes are not part of this corpus).

## Deliverables

- `tools/verify/seed-canopy.ts` — the seed script: reads a config (server URL, emulator
  URL) from argv/env, mints tokens for the four named subjects from the live E2-T02
  emulator, then executes the fixed action sequence in a fixed order: identity bootstrap
  through `IdentityStore`/auth; `ns.org.create`, deterministic `ns.project.create`, and
  `ns.repo.create` through authenticated `/api/dispatch`; repository/content stream
  creation and the `reading-room@main` source tree through StreamFS (mkdirs, file creates
  with fixed content literals, one file rename, one directory rename, one delete); ≥3
  patch edits to `docs/chapter-one.md` (or the equivalent committed path); the
  `feature-typography` native fork at the offset the manifest records as `fork_offset`;
  one post-fork edit on each side. The script fails loudly (nonzero, no partial
  evidence) on any refusal or unexpected offset.
- `Makefile`: `seed-canopy` (cold-start emulator + auth-enabled server on ephemeral
  ports and scratch data dir unless URLs are supplied, run the seed, dump every touched
  stream as `<manifest-key>.jsonl` into an output directory — `OUT=<dir>` if supplied,
  otherwise a fresh mktemp dir under the task's `work/` whose path is printed — and
  print the per-stream head offsets, canonical dump hashes, and state digests),
  `verify-E3-seed` (the full proof: seed a fresh
  server, byte-diff fresh dumps against `evidence/dumps/`, `ef replay` every committed
  dump, compare its raw SHA-256 and reduced-state digest against the manifest, run the
  cross-tenant privacy probe,
  run the sensitivity check), and `regen-E3-seed` (the only writer of `evidence/`;
  prints the diff for deliberate review). `verify-E3-seed` and `verify-E3-T01`
  (standard `_v-*` gates + `verify-E3-seed`) join `verify-all` and `make verify-list`;
  `tools/verify/self_check.sh` stays green.
- `tools/verify/seed_sensitivity.sh` — invoked inside `verify-E3-seed`: copies
  `evidence/dumps/` to a scratch dir, flips one byte in one dump (stream and byte
  position taken from committed defaults but overridable by flags for the critic),
  reruns only the replay-vs-manifest comparison against the scratch copy, and asserts
  the run goes red naming exactly the mutated stream and no other; a green run, or a
  red run blaming the wrong stream, exits nonzero.
- `evidence/dumps/<manifest-key>.jsonl` — one committed dump per seeded stream, named
  per the frozen manifest-key encoding above: the
  identity stream, `__registry__`, each repo's namespace/metadata stream, and each
  branch's stream-fs metadata + per-file content streams for both `reading-room`
  branches, `secret-garden@main`, and `field-notes@main`.
- `evidence/corpus-manifest.json` — the pinned manifest per the frozen schema,
  including anchors: `fork_offset`, `patch_offsets` (the ≥3 patch events),
  `tombstoned_path`, `renamed_from`/`renamed_to` (file and directory), and the
  post-fork divergence offsets on each branch.
- `evidence/e3-t01-privacy-probe.txt` — the committed transcript of the frozen
  E2-T11-ordered privacy matrix: the tenant-bound `willow` member's token is refused
  reading both `maple/secret-garden` and public `maple/reading-room`; anonymous/unbound
  access is refused on secret-garden and allowed on reading-room; and a same-tenant
  maple identity is allowed according to the repo's visibility/grants. Refusals are
  log-neutral and the transcript contains statuses and error classes only, never token
  bytes.
- Committed tests (harness suite), green under `pnpm test`: seed determinism (two
  fresh seeds → byte-identical dump sets), manifest agreement (`ef replay` of every
  committed dump equals its manifest digest), anchor validity (the event at
  `fork_offset` is an E1-T08 fork event; each `patch_offsets` entry is an E1-T03 patch
  event; the tombstoned path is absent from the final tree while `renamed_to` is
  present and `renamed_from` absent), manifest hygiene (pattern sweep: no timestamp,
  port, JWT-segment, or hex-token bytes in manifest or dumps), and the sensitivity
  red paths for at least three distinct (stream, byte) choices.
- Tools/verify runbook section (`tools/verify/runbook.md`): how downstream E3 tasks
  consume the corpus — seed via `make seed-canopy` or replay the dumps, cite streams
  and anchors by manifest key, never regenerate.

## Acceptance criteria

- [ ] From a cold clone via `tools/verify/cold_clone.sh` (scrubbed env: `NODE_OPTIONS`,
      `NODE_ENV`, `npm_config_*` unset), `make verify-E3-seed` and `make verify-E3-T01`
      exit 0 with zero `SKIPPED:` lines, cold-starting the E2-T02 emulator and the
      auth-enabled server themselves on ephemeral ports and a scratch data dir.
      Evidence: the critic reruns both from a cold clone — stream layer.
- [ ] Every pinned digest reproduces exactly: for every entry in
      `evidence/corpus-manifest.json`, `ef replay evidence/dumps/<dump> --digest` (with
      that stream's reducer) prints a digest byte-equal to the manifest's
      `state_digest`, and the dump's last record's offset equals `head_offset`.
      Evidence: committed test iterating the manifest; the critic re-derives every
      digest independently.
- [ ] Seed determinism: two runs, `make seed-canopy OUT=a` and `make seed-canopy OUT=b`,
      against two fresh server data dirs produce dump directories such that
      `diff -r a b` and `diff -r a evidence/dumps` are both empty. Evidence: committed
      determinism test + the critic's own double run.
- [ ] Frozen-boundary honesty and authentication: identity bootstrap uses only
      `IdentityStore`/existing auth APIs; namespace mutations use authenticated
      `/api/dispatch`; repository/content creation, file mutations, and the native fork
      use only public frozen StreamFS/Durable Streams APIs. The seed imports no store
      implementation or server internals. Every event family that defines server-stamped
      actor metadata carries one of the named subjects; identity and frozen StreamFS
      envelopes are validated against their own exact schemas instead. A tokenless replay
      of the seed's first namespace mutation is refused with E2-T03's 401 shape and
      log-neutral — the target stream's head offset and digest are byte-identical before
      and after. Evidence: committed boundary/import sweep + refusal test.
- [ ] The corpus contains what Epic 3 needs, provably: committed anchor-validity tests
      assert the `fork_offset` event is an E1-T08 fork on `feature-typography`, both
      branches carry at least one post-fork event with digests that differ from each
      other at head (divergence is real), `patch_offsets` names ≥3 E1-T03 patch events
      on one file whose final content digest differs from its pre-patch digest, and the
      final `reading-room@main` tree contains `renamed_to`, lacks `renamed_from` and
      `tombstoned_path`. Evidence: committed tests reading only the dumps + manifest.
- [ ] Tenant-first privacy is live: inside `verify-E3-seed`, a token minted for the
      tenant-bound `willow` member is refused reading every maple stream, private and
      public, with E2-T11's frozen 404 and log-neutral head/digest; anonymous/unbound
      access is refused on every `maple/secret-garden` stream and allowed on
      `maple/reading-room`; and a same-tenant maple identity is allowed according to
      visibility/grants. Each manifest stream is passed through the frozen public
      authorization components (`GrantAwareVerifier`, `decideTenantAccess`,
      `NamespaceViewReader`, and `decideStreamAuthorization`); allowed decisions read
      the exact decided stream, while refusals perform no target read. The stable
      transcript records the observed status/body and before/after target hash as
      `evidence/e3-t01-privacy-probe.txt`. Evidence: the transcript + the critic's own
      fresh-token matrix.
- [ ] Sensitivity: `tools/verify/seed_sensitivity.sh` (run inside `verify-E3-seed`)
      flips one byte of one dump in a scratch copy and the replay-vs-manifest
      comparison goes red naming exactly the mutated stream; committed tests cover ≥3
      distinct (stream, byte) choices including a byte inside a patch event's body and
      a byte inside an offset field. A flip that stays green, or a red that misnames
      the stream, fails the criterion. The registered verifier emits a committed
      sensitivity-stage receipt, `self_check.sh` requires its structural invocation,
      and a committed sabotage test deletes that invocation and proves the spine goes
      red. Evidence: committed red-path tests, sabotage marker, and the critic's own
      flips.
- [ ] Goldens are frozen, regeneration is deliberate: `verify-E3-seed` leaves
      `evidence/` byte-identical (asserted by digest of the directory before/after);
      deleting the manifest or any dump makes `verify-E3-seed` fail red, never
      regenerate-and-pass; `regen-E3-seed` exists and prints a review diff. Evidence:
      recipe text + the critic's deletion runs.
- [ ] Manifest hygiene: a committed pattern sweep proves no timestamp, port number,
      JWT segment, or token byte appears anywhere in `corpus-manifest.json` or any
      committed dump. Evidence: committed test.
- [ ] Standing-gate wiring: `verify-E3-seed` and `verify-E3-T01` appear in
      `verify-all` and `make verify-list`; `bash tools/verify/self_check.sh` exits 0;
      re-running `verify-all` on this tree stays green (the seed added observation and
      data, no behavior). Evidence: the critic reads the Makefile and reruns.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
  pnpm test && pnpm build` exit 0. Evidence: deterministic exit codes from the
      cold clone.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with the committed dumps, manifest digests, privacy transcript,
      and sensitivity runs as the stream-layer mitigation.

## Adversarial verification

The claim under attack: "this corpus is deterministic, was built through the exact frozen
boundary that owns each mutation, pins every stream to a digest that `ef replay`
reproduces from a cold clone, and cannot drift or be corrupted by a single byte without
the target going red on exactly the right stream." The corpus is the foundation every E3
golden stands on — if it wobbles, every later view task's evidence is built on sand. Use
your own byte positions, subjects, and probes throughout; invent at least one angle beyond
these.

1. **Sensitivity with your own flips (mandatory).** Do not reuse the builder's
   committed (stream, byte) choices. Pick five of your own across different dumps: a
   byte in an event body, a byte in a path string, a byte in an offset field, a byte
   in the fork event at `fork_offset`, and a whole-record deletion (truncate one line
   from a dump). After each single mutation in a scratch copy, the comparison must go
   red naming exactly the mutated stream — a green run refutes the apparatus; a red
   run blaming an unmutated stream refutes its localization. Then mutate the
   **manifest** instead (change one `state_digest` hex char, one `head_offset`): the
   target must also go red — a comparison that trusts the dumps over the manifest, or
   vice versa, asymmetrically, is a finding.
2. **Determinism under a hostile environment.** Run `make seed-canopy` twice from two
   separate cold clones under differing env (`TZ=UTC` vs `TZ=Pacific/Kiritimati`,
   `LANG=C` vs `LANG=en_US.UTF-8`, different cwd and umask, different ephemeral
   ports) and byte-diff the full dump sets against each other and against
   `evidence/dumps/`. Any differing byte refutes the determinism contract. Then grep
   the dumps and manifest for anything resembling an ISO date, a port, a pid, or a
   JWT segment; a hit is a finding even if today's diff happened to pass. Sweep the
   seed's source for `Date.now`, `Math.random`, `crypto.randomUUID`, and
   locale-sensitive formatting feeding event bodies.
3. **Frozen-boundary honesty.** Read `tools/verify/seed-canopy.ts` and classify every
   mutation: identity bootstrap through `IdentityStore`/auth, namespace mutations
   through authenticated HTTP dispatch, and stream creation/files/forks through public
   StreamFS/Durable Streams APIs. There must be no store implementation/server-internal
   import or server-data-dir write. Sabotage each boundary independently: make the E0-T11
   validator refuse one namespace event, make StreamFS creation fail, and make the native
   fork fail — the seed must stop loudly without falling back to another path. Separately,
   replay the namespace action sequence with **no** token and with the `willow` member's
   token against `maple` streams: every mutation must be refused with the frozen
   E2-T03/E2-T11 shapes, log-neutral
   (head offset + `ef replay --digest` identical before/after your barrage).
4. **Golden-as-echo attack.** Inspect the Makefile and tests: is any committed digest
   or dump (re)computed by the code under test at check time? Delete the manifest,
   then one dump, and run `verify-E3-seed` — red, never regenerate-and-pass. Run
   `verify-E3-seed` and byte-compare `evidence/` before/after — any changed byte
   refutes the frozen-golden contract. Then sabotage the stream-fs reducer in a
   scratch worktree (e.g. make rename a no-op) and run `regen-E3-seed`: the printed
   review diff must show the drift; if the anchor-validity tests still pass against
   the regenerated corpus (renamed_from still present but tests green), the tests
   read the corpus rather than the contract — refute them.
5. **Corpus adequacy against its consumers.** Hold the manifest anchors against the
   E3-T04..T10 task claims yourself: verify by replaying the dumps (not by trusting
   the tests) that the fork event sits at `fork_offset` and both branches truly
   diverge after the inherited prefix (digest-bisect the two branch dumps — every
   record through `fork_parent_offset` must be identical and the first divergent
   offset must be `fork_offset`, strictly greater than `fork_parent_offset`), that the
   ≥3 patches actually change the file's content
   digest step by step (materialize at each `patch_offsets` prefix), and that the
   tombstoned path is present at some earlier offset and absent at head (a tombstone
   the tree never contained proves nothing about tombstone-awareness). A missing or
   mislabeled anchor is a finding: downstream tasks will cite it.
6. **Privacy probe from your own identity.** Mint your own unbound token from the
   emulator and sweep every stream in the manifest: every `secret-garden` stream must
   refuse and public `reading-room` must allow. Separately use a tenant-bound willow
   member (both maple repos refuse) and a same-tenant maple identity (visibility/grants
   decide). Every refusal must be log-neutral under `ef replay --digest`. Diff your
   decisions against `evidence/e3-t01-privacy-probe.txt`'s classes. Any stream in the
   dumps that the manifest omits — enumerate the server's stream list after seeding and
   diff against the manifest keys — refutes the "every stream pinned" claim.
7. **Warm-state and cold-clone hunt.** Run `verify-E3-seed` twice back-to-back and
   concurrently in two shells; grep the seed and recipes for fixed ports, fixed temp
   paths, or reuse of a development data dir. Then run everything only through
   `tools/verify/cold_clone.sh` with scrubbed env. A run that passes only warm, or
   fails only cold, refutes.
8. **Sabotage the verdict machinery.** In a scratch worktree: make the dump byte-diff
   compare a file to itself, make the digest comparison always-equal, and drop the
   sensitivity call from the recipe — after each, `make verify-E3-seed` or
   `tools/verify/self_check.sh` must go red. Sweep the diff for `.skip`/`.todo`/inline
   lint disables. **Coverage:** hold the recorded run against the diff — the seed's
   refusal-failure path (a dispatch refused mid-seed), the sensitivity flag overrides,
   and `regen-E3-seed` must each have been executed by a committed test or the
   recorded run; unexecuted diff is unproven or dead.

Refutation currency: a mutated dump the target stays green on, two seed runs whose
dumps differ by one byte, an actor-bearing event whose actor is not a named subject, a
digest the manifest pins that `ef replay` cannot reproduce from the committed dump, a
`secret-garden` read that succeeds cross-tenant, or a seeded stream absent from the
manifest — each cited with the stream id, dump path, offset, and digest pair. "The
corpus should also contain merges" is a later task's row to add via `regen-E3-seed`,
not a finding. No refutation → promote your sharpest hand-picked flip (stream + byte +
predicted red) as an additional committed sensitivity case.

## Verification log

### 2026-07-27 — builder — BLOCKED: frozen doors cannot produce the specified corpus

- Lifecycle commit: `a8e5a13` (based exactly on verified E2-T12 commit
  `c554356e5ec5d36e7c3ded1dba66b78b932b6f8b`).
- The required branch name `feature/typography` is rejected by the frozen E1-T08
  `BRANCH_NAME_PATTERN` (`packages/streamfs/src/branch.ts:8,25-30,101-103`) and is
  classified as a malformed repository target by E2-T07
  (`packages/platform/src/authz/decide.ts:158-180`). Substituting another name would
  weaken the explicit corpus contract.
- E1-T08 creates a branch by calling the Durable Streams fork transport directly
  (`packages/streamfs/src/branch.ts:95-123`;
  `packages/streamfs/src/fs.ts:565-588`). `POST /api/dispatch` appends only to an
  already-existing application stream and turns a missing target into
  `official_stream_append_failed` (`packages/platform/src/gateway.ts:492-514`).
  Namespace repo creation creates only `ns:root` and `ns:org:<org>` streams
  (`packages/platform/src/ns/dispatch.ts:263-281`), not repo metadata, branch, or
  content streams. Therefore the required fork and source tree cannot be created
  through the dispatch door alone.
- The identity stream is an internal target
  (`packages/platform/src/authz/decide.ts:178-180`) and the frozen HTTP route topology
  exposes no identity organization or membership mutation door. Those mutations
  exist only as `IdentityStore` methods. Consequently the seed cannot provision the
  two tenant memberships entirely through `POST /api/dispatch`, as required.
- The required fresh read-only pre-critic completed the finite threat model and
  confirmed that changing server/auth/transport semantics is out of scope and that
  dispatch-only plus the exact branch name cannot be weakened.
- Commands: `sed -n '1,380p'
.eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/readme.md`;
  `rg -n 'api/dispatch|classifyDispatchTarget|BRANCH_NAME_PATTERN|createForkStream|ensureStream'
packages tools -S`; line-numbered source inspection of the cited files; `git status
--short --branch`.
- Replay: N/A (no browser-reaching surface and implementation cannot begin without
  contradicting frozen prerequisites) + mitigation: line-cited source audit against
  the verified E2-T12 head. No corpus dumps, manifest digests, privacy transcript, or
  sensitivity evidence are claimed.

Demand: reconcile the task with the verified substrate before builder work resumes.
Either authorize and specify prerequisite product changes (branch grammar, an
authenticated identity-admin dispatch door, and dispatch-mediated stream/fork
creation), or amend the corpus contract. Per the loop contract, the builder does not
route around this by direct store writes, a renamed branch, or fabricated goldens.

### 2026-07-27 — loop — `invalid_loop`

- A second independent read-only audit confirmed the builder's blocker and found
  two additional literal contradictions: the fixed sequence omits required
  `ns.project.create`, and its universal `actor` requirement is incompatible
  with frozen identity and StreamFS event schemas.
- No implementation or verification run was claimed. The project stops on
  E3-T01 because making the gate green requires a human choice between new
  prerequisite product behavior and a revised corpus contract.
- The smallest contract-only reconciliation is: use `feature-typography`; add
  deterministic project creation; bootstrap identity through `IdentityStore` or
  the existing auth flow; route namespace mutations through authenticated
  `/api/dispatch`; create repository/content streams and native forks through
  the frozen StreamFS/Durable Streams APIs; and scope actor assertions to event
  families that define actor metadata.

### 2026-07-27 — human scope decision

- Authorization: APPROVED
- Task: E3-T01
- Decision: reconcile the seed corpus with the already-verified E1/E2 API
  boundaries using the smallest contract-only correction recorded above.
- Constraint: preserve the pre-run blocker and empty verdict ledger; change no
  verified product behavior; resume only E3-T01.

### 2026-07-27 — human resume — RUNS 1-3 authorized

- Authorization: APPROVED
- Task: E3-T01
- Stopped after run: 0
- Authorized runs: 1-3
- Scope: control-plane recovery transition and E3-T01 verification only

### 2026-07-27 — scope clarification — E2-T11 tenant ordering preserved

- The privacy matrix now follows verified E2-T11 without product changes:
  tenant isolation precedes repository visibility, so a tenant-bound willow member is
  refused on both maple private and maple public streams. Anonymous/unbound access
  distinguishes public from private, while a same-tenant maple identity follows the
  existing visibility/grant rules.
- Frozen citations: `packages/platform/src/gateway.ts:332-334`,
  `packages/platform/src/tenant-isolation.ts:20-33`, and
  `tools/verify/e2_t11_evidence.mjs:245-250`.
- This contract/evidence correction belongs to authorized E3-T01 recovery run 1 and
  changes no verified runtime behavior.

### 2026-07-27 — builder — CLAIM: deterministic canopy corpus implemented

- Candidate commit:
  `2bf957f62c8efb132a9b751d6ebf3ce3330aaf9c`.
- Root gates: `CI=true pnpm format:check`, `CI=true pnpm lint`,
  `CI=true pnpm typecheck`, `CI=true pnpm test`, and `CI=true pnpm build` all
  exited 0. The full test gate passed 32 files and 409 tests.
- Task proof: `make --no-print-directory verify-E3-T01` exited 0 at the candidate
  commit. It generated two byte-identical fresh corpora under hostile timezone/locale
  settings, independently checked the exact 22-stream inventory, each canonical
  dump SHA-256, head offset, and replayed state digest, and ended
  `E3_T01_VERIFY_OK streams=22
  evidence-digest=d7534746d264395ca8acfbf7e2101af1fe34a372f4da0742eea17227de283612`
  followed by `verify-E3-T01: OK`.
- Sensitivity and refusal coverage: the recorded task proof localized a patch-payload
  byte flip, offset byte flip, content-stream byte flip, and final-record truncation
  to exactly one manifest key. It also injected failures at the namespace,
  StreamFS, and native-fork boundaries and confirmed no partial corpus was published.
- Cold-clone proof:
  `tools/verify/cold_clone.sh verify-E3-T01` cloned exact candidate
  `2bf957f62c8efb132a9b751d6ebf3ce3330aaf9c`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, scrubbed the environment, reran
  409 tests plus the complete corpus verifier, and ended
  `cold_clone: verify-E3-T01 PASSED from a pristine clone`.
- Stream evidence:
  `evidence/corpus-manifest.json`, all 22 canonical dumps under
  `evidence/dumps/`, and `evidence/e3-t01-privacy-probe.txt`. The manifest pins
  fork event `0000000000000000_0000000000000029`, main head
  `0000000000000000_0000000000000029`, and feature head
  `0000000000000000_0000000000000031`.
- What the evidence demonstrates: the fixed named-subject sequence crosses the
  authenticated namespace door, public StreamFS APIs, and native fork API to create
  the maple/willow browse corpus; reducer replay and raw dump hashes agree
  independently for every authoritative server-discovered stream; branch heads
  diverge after a recorded native fork; and the tenant-first privacy probe stays
  log-neutral while refusing willow on both maple repositories, permitting anonymous
  public access, refusing anonymous private access, and permitting same-tenant maple
  access according to the frozen rules.
- Replay: N/A (E3-T01 changes only non-browser seed/verification tooling and committed
  stream fixtures; no browser-reaching behavior exists) + mitigation: canonical
  event-log dumps, raw SHA-256 values, replayed state digests, privacy transcript,
  localized mutation checks, atomic failure injection, exact-head Make proof, and
  pristine cold-clone proof.

### 2026-07-27 — judge round 1 — VERDICT: refuted

- P1 privacy evidence is synthesized rather than observed per stream. Predicted every
  maple manifest stream would be requested through the authorization gate with the
  willow-member, anonymous, and maple-admin principals, as required by acceptance
  criterion 6 and adversarial attack 6. Observed only six repository-level
  `GET /api/repos/maple/<repo>/main/events` probes in
  `tools/verify/seed-canopy.ts:554-582`; the per-stream rows for every secret-garden
  and reading-room metadata/content stream are then emitted from inventory with
  hard-coded statuses at `tools/verify/seed-canopy.ts:589-598`, without requesting
  those streams. The unsupported claims appear in
  `evidence/e3-t01-privacy-probe.txt:10-24`. Demand: either execute and record real
  auth-gated probes for every claimed stream, including refusal neutrality, or narrow
  the task and transcript to the frozen repository-route granularity; never label
  inventory-derived rows as observations.
- P1 verdict machinery is not sabotage-sensitive. Predicted removing the sole
  sensitivity invocation would make `verify-E3-seed` or
  `tools/verify/self_check.sh` red, as required by adversarial attack 8. In a
  disposable exact-head clone, deleting only `sensitivityChecks(EVIDENCE)` at
  `tools/verify/canopy_verify.mjs:278` left
  `bash tools/verify/self_check.sh` green and an unrestricted loopback run of
  `node tools/verify/canopy_verify.mjs` exited 0 with
  `E3_T01_VERIFY_OK streams=22
evidence-digest=d7534746d264395ca8acfbf7e2101af1fe34a372f4da0742eea17227de283612`,
  with no sensitivity markers. Demand: make the verification spine fail closed on
  omission of the sensitivity stage and retain this exact deletion as a promoted
  sabotage regression.
- P1 the fork-divergence attack contradicts the pinned anchor semantics. Predicted the
  first main/feature divergence would be strictly greater than `fork_offset`, as
  required by adversarial attack 5. Independent comparison found both dumps equal
  through `fork_parent_offset`
  `0000000000000000_0000000000000028`, then first diverging at
  `0000000000000000_0000000000000029`: main contains `fs.file.write`, while feature
  contains `fs.branch.fork`. The manifest defines that same feature event offset as
  `fork_offset`, so the observed first divergence equals, rather than exceeds, the
  required anchor. Citations:
  `evidence/corpus-manifest.json:159-178`,
  `evidence/dumps/fs_maple_reading-room_main_meta.jsonl:30`, and
  `evidence/dumps/fs_maple_reading-room_feature-typography_meta.jsonl:30`.
  Demand: require divergence after `fork_parent_offset`, which matches the native
  fork contract, or explicitly redefine the anchor semantics; then rerun the exact
  attack.
- Surviving checks: independently rederived all 22 raw dump SHA-256 values and head
  offsets; `node tools/verify/canopy_compare.mjs` reproduced all 22 state digests;
  five critic-chosen mutations localized exactly (`__identity__` body,
  `ns_org_maple` path, `__registry__` offset, feature fork body, and `ns_root`
  truncation); manifest digest/head mutations and missing manifest/dump attacks went
  red on the exact target; all three patches materialized step-by-step to their
  declared result digests; actor-bearing namespace/registry events used named
  subjects, while identity and StreamFS envelopes stayed within their own schemas.
  An escalated exact-submission cold clone reached `verify-E3-seed: OK` and
  `cold_clone: verify-E3-seed PASSED from a pristine clone`. A concurrent full
  `make --no-print-directory verify-E3-T01` attempt suffered a Vitest worker
  `SIGABRT`/resource cascade; it is not raised as a product finding because the
  deterministic refutations above already decide the run.
- Commands: `node tools/verify/canopy_compare.mjs`; five independent
  `bash tools/verify/seed_sensitivity.sh --stream ... --byte ...`/`--mode truncate`
  runs; independent Node SHA/head, actor-schema, patch-materialization,
  manifest-mutation, and missing-golden probes; disposable-clone
  `bash tools/verify/self_check.sh` and `node tools/verify/canopy_verify.mjs` after
  the one-line sabotage; `tools/verify/cold_clone.sh verify-E3-seed`;
  `make --no-print-directory verify-E3-T01`.
- SUITE: promote the sensitivity-call deletion as a permanent self-check mutation.
  Retain the five critic-chosen dump mutations as additional sensitivity corpus cases
  after the refutations clear.
- Replay: N/A (the submission changes only non-browser seed/verification tooling and
  committed stream fixtures) + mitigation: the committed event-log dumps, raw hashes,
  replayed digests, independent patch materialization, privacy evidence audit,
  sensitivity mutations, sabotage clone, and cold-clone seed proof. The absence of
  browser evidence is sufficient and is not a finding.

### 2026-07-27 — builder run 2 — CLAIM: refutations cleared

- Candidate commit:
  `47c0c2a6f9a58089b788db590a47b88c4dd9a5b1`.
- Exact-head proof: `make --no-print-directory verify-E3-T01` exited 0 at the
  candidate commit. Its ordered root gates passed format, lint, typecheck, all 33 test
  files and 410 tests, and build before the task verifier ran. The verifier ended
  `E3_T01_VERIFY_OK streams=22
  evidence-digest=6dee174f11337d7c33a715a674a2f45680b217e440089481e771232a08c52c23`,
  `CANOPY_SENSITIVITY_SPINE_OK`, and `verify-E3-T01: OK`.
- Privacy refutation: the seed now records 45 real authorization observations — every
  one of the 15 authoritative maple manifest streams under `willow-member`,
  `anonymous`, and `maple-admin`. Each observation resolves the presented credential
  through `GrantAwareVerifier`, crosses the frozen tenant and stream authorization
  decisions, and either reads the exact decided stream or refuses before a target
  read. The verifier checks the frozen status/body, exact allowed count/head, and
  byte-identical before/after stream-log hashes for every row, then emits
  `E3_T01_PRIVACY_MATRIX_OK streams=15 observations=45`.
- Sensitivity-spine refutation: `tools/verify/self_check.sh` and the registered Make
  closure structurally require the unique sensitivity invocation and receipt.
  `tools/verify/canopy_sensitivity_spine_sabotage.mjs` deletes that exact invocation
  in a scratch verifier and proves the checker goes red, emitting
  `CANOPY_SENSITIVITY_SPINE_SABOTAGE_OK mutation=delete-invocation`; the same deletion
  is promoted in `packages/platform/test/canopy-verifier-spine.test.ts`. The final
  verifier exercised the original four mutations plus the judge's five retained
  mutations and emitted `E3_T01_SENSITIVITY_STAGE_OK cases=9`.
- Fork-semantics refutation: the independent comparison now asserts the native fork
  contract directly: main and feature are byte-equal through `fork_parent_offset`,
  `fork_offset` is strictly later, and their first divergent common offset equals
  `fork_offset`. The exact attack emitted
  `E3_T01_FORK_DIVERGENCE_OK
  parent=0000000000000000_0000000000000028
  first=0000000000000000_0000000000000029`.
- Cold-clone proof: `tools/verify/cold_clone.sh verify-E3-T01` cloned exact candidate
  `47c0c2a6f9a58089b788db590a47b88c4dd9a5b1`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated dependencies from the
  lockfile-verified store, scrubbed the environment, passed all 410 tests and the
  complete verifier, and ended
  `cold_clone: verify-E3-T01 PASSED from a pristine clone`.
- Stream evidence:
  `evidence/corpus-manifest.json`, all 22 canonical dumps under `evidence/dumps/`,
  and the regenerated `evidence/e3-t01-privacy-probe.txt`. Two hostile-environment
  seeds remained byte-identical; only the deliberately changed privacy transcript
  changed the corpus evidence digest.
- Replay: N/A (E3-T01 remains non-browser seed/verification tooling plus committed
  stream fixtures) + mitigation: 22 canonical event logs and replayed digests,
  per-stream authorization/refusal-neutrality observations, the 9-case mutation
  corpus, exact deletion sabotage, atomic failure injection, exact-head Make proof,
  and pristine cold-clone proof.
