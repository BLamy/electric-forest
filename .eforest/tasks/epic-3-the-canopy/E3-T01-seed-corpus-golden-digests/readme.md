---
id: E3-T01
epic: 3
title: "Deterministic browse corpus: scripted seed dispatching orgs, repos, branches, and files to golden per-stream digests"
priority: 301
status: pending
depends_on: [E2]
estimate: M
capstone: false
---

## Goal

The single, frozen world every Epic 3 view task browses exists as committed, replayable
data. `tools/verify/seed-canopy.ts` (runnable as `make seed-canopy`) drives a **fixed
action sequence** against a fresh auth-enabled stream server + E2-T02 OIDC emulator,
entirely through `POST /dispatch` doors under real bearer tokens minted for named
emulator identities — never a direct store write, never an unauthenticated append. The
sequence builds: **two orgs** (`maple`, `willow` — two tenants, so cross-tenant
visibility is testable), **three repos** via E2-T06 `ns.*` dispatches (`maple/reading-room`
public, `maple/secret-garden` private, `willow/field-notes` public), **branches**
(`reading-room` gets `feature/typography` forked from `main` at a recorded offset via the
E1-T08 fork event, then both sides diverge), and a **small source tree** on
`reading-room@main` (nested directories, ≥8 files, one file rename, one directory
rename, one delete/tombstone, and ≥3 E1-T03 patch edits to one file so patch-aware
rendering has real material). Every stream the seed touches — identity, `__registry__`
(E2-T08 derived index), each repo's namespace/metadata stream, and each branch's
stream-fs metadata + content streams — is dumped to
`evidence/dumps/<stream-id>.jsonl` and pinned in `evidence/corpus-manifest.json`: one
entry per stream carrying `{stream, dump, head_offset, state_digest}` where
`state_digest` is the `ef replay <dump> --digest` output (E0-T04, with the stream's
reducer), plus named **anchors** (`fork_offset`, the offsets of each patch event, the
tombstoned path, the renamed paths) that later tasks cite by name instead of magic
numbers. The seed is deterministic end to end: two cold runs produce byte-identical
dumps and therefore byte-identical manifests — no wall-clock timestamps, random ids,
port numbers, or token bytes reach any event body. `make verify-E3-seed` proves all of
it from a cold clone: cold-start emulator + server, run the seed, diff every fresh dump
byte-exact against the committed dump, replay every committed dump and compare every
digest against the manifest, probe that `maple/secret-garden` is refused to a
non-member token (the corpus's privacy claim is live, not asserted), and run the
sensitivity check — flip one byte of one committed dump in a scratch copy and the
target must go red naming exactly that stream. Exit 0 only when every pinned digest
reproduces exactly.

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
separates orgs, not just repos. Dispatching under authenticated identities (rather than
replaying fixture logs straight into the store) is the point, not a flourish: it
re-proves the whole E2 gate stack — token mint, per-stream authorization, registry
derivation — as a side effect of seeding, and it means the corpus is exactly what a real
client session would have produced.

Builds on: E2-T02 (tokens minted at run time from the cold-started emulator for the
seed's named subjects — an org-admin of `maple`, a member of `maple`, an org-admin of
`willow`, plus a `willow` member used only as the cross-tenant probe), E2-T04/T05
(identity provisioning event shapes), E2-T06 (`ns.*` org/repo creation dispatches and
the `fs:<org>/<repo>` stream-id resolution), E2-T07 (public/private visibility the
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
  `{stream, dump, head_offset, state_digest}` per stream plus a top-level `anchors`
  map; no timestamps, ports, or token material anywhere in the file. Later tasks
  reference streams and anchors by manifest key.
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
  emulator, then dispatches the fixed action sequence in a fixed order: identity/org
  provisioning for `maple` and `willow`; `ns.repo.create` for the three repos with
  their visibility; the `reading-room@main` source tree (mkdirs, file creates with
  fixed content literals, one file rename, one directory rename, one delete); ≥3
  patch edits to `docs/chapter-one.md` (or the equivalent committed path); the
  `feature/typography` fork at the offset the manifest records as `fork_offset`; one
  post-fork edit on each side. Every mutation goes through `/dispatch` with the
  correct subject's token; the script fails loudly (nonzero, no partial evidence) on
  any refusal or unexpected offset.
- `Makefile`: `seed-canopy` (cold-start emulator + auth-enabled server on ephemeral
  ports and scratch data dir unless URLs are supplied, run the seed, print the
  per-stream head offsets and digests), `verify-E3-seed` (the full proof: seed a fresh
  server, byte-diff fresh dumps against `evidence/dumps/`, `ef replay` every committed
  dump and compare against the manifest digests, run the cross-tenant privacy probe,
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
- `evidence/dumps/<stream-id>.jsonl` — one committed dump per seeded stream: the
  identity stream, `__registry__`, each repo's namespace/metadata stream, and each
  branch's stream-fs metadata + per-file content streams for both `reading-room`
  branches, `secret-garden@main`, and `field-notes@main`.
- `evidence/corpus-manifest.json` — the pinned manifest per the frozen schema,
  including anchors: `fork_offset`, `patch_offsets` (the ≥3 patch events),
  `tombstoned_path`, `renamed_from`/`renamed_to` (file and directory), and the
  post-fork divergence offsets on each branch.
- `evidence/e3-t01-privacy-probe.txt` — the committed transcript of the cross-tenant
  probe: the `willow` member's token reading `maple/secret-garden` streams refused
  with E2-T07's frozen refusal shape, the same token reading `maple/reading-room`
  (public) allowed — statuses and error classes only, no token bytes.
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
- [ ] Seed determinism: two `make seed-canopy` runs against two fresh server data dirs
      produce dump sets that are byte-identical to each other and to the committed
      `evidence/dumps/` (`diff -r` empty). Evidence: committed determinism test + the
      critic's own double run.
- [ ] Dispatch-door-only, authenticated-only: every event in every committed dump
      carries an `actor` subject equal to one of the four named emulator subjects
      (literal equality, asserted by a committed sweep over the dumps), and the seed
      script contains no import of the store or server internals — it speaks only HTTP
      to `/dispatch` and the token endpoints. A tokenless replay of the seed's first
      mutating action against a fresh server is refused with E2-T03's 401 shape, log
      untouched. Evidence: committed sweep + committed refusal test.
- [ ] The corpus contains what Epic 3 needs, provably: committed anchor-validity tests
      assert the `fork_offset` event is an E1-T08 fork on `feature/typography`, both
      branches carry at least one post-fork event with digests that differ from each
      other at head (divergence is real), `patch_offsets` names ≥3 E1-T03 patch events
      on one file whose final content digest differs from its pre-patch digest, and the
      final `reading-room@main` tree contains `renamed_to`, lacks `renamed_from` and
      `tombstoned_path`. Evidence: committed tests reading only the dumps + manifest.
- [ ] Cross-tenant privacy is live: inside `verify-E3-seed`, a token minted for the
      `willow` member is refused reading every `maple/secret-garden` stream (E2-T07's
      frozen refusal, log-neutral: head offset + digest identical before/after the
      probe) and allowed reading `maple/reading-room`; transcript committed as
      `evidence/e3-t01-privacy-probe.txt`. Evidence: the transcript + the critic's own
      probe with a freshly minted token.
- [ ] Sensitivity: `tools/verify/seed_sensitivity.sh` (run inside `verify-E3-seed`)
      flips one byte of one dump in a scratch copy and the replay-vs-manifest
      comparison goes red naming exactly the mutated stream; committed tests cover ≥3
      distinct (stream, byte) choices including a byte inside a patch event's body and
      a byte inside an offset field. A flip that stays green, or a red that misnames
      the stream, fails the criterion. Evidence: committed red-path tests + the
      critic's own flips.
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

The claim under attack: "this corpus is deterministic, was built entirely through the
authenticated dispatch door, pins every stream to a digest that `ef replay` reproduces
from a cold clone, and cannot drift or be corrupted by a single byte without the target
going red on exactly the right stream." The corpus is the foundation every E3 golden
stands on — if it wobbles, every later view task's evidence is built on sand. Use your
own byte positions, subjects, and probes throughout; invent at least one angle beyond
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
3. **Dispatch-door honesty.** Read `tools/verify/seed-canopy.ts` and confirm it speaks
   only HTTP: no imports from the store or server packages, no filesystem writes into
   the server's data dir. Then sabotage in a scratch worktree: make the E0-T11
   dispatch validator refuse one of the seed's event types — the seed must fail
   loudly, not fall back to any side door; a seed that still produces dumps refutes
   the through-the-door claim. Separately, replay the seed's action sequence yourself
   with **no** token and with the `willow` member's token against `maple` streams:
   every mutation must be refused with the frozen E2-T03/E2-T07 shapes, log-neutral
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
   diverge after it (digest-bisect the two branch dumps — the first divergent offset
   must be > `fork_offset`), that the ≥3 patches actually change the file's content
   digest step by step (materialize at each `patch_offsets` prefix), and that the
   tombstoned path is present at some earlier offset and absent at head (a tombstone
   the tree never contained proves nothing about tombstone-awareness). A missing or
   mislabeled anchor is a finding: downstream tasks will cite it.
6. **Privacy probe from your own identity.** Mint your own token from the emulator for
   a subject the seed never used, and sweep every stream in the manifest: every
   `secret-garden` stream must refuse, every public stream must allow, and the
   refusals must be log-neutral under `ef replay --digest`. Diff your decisions
   against `evidence/e3-t01-privacy-probe.txt`'s classes. Any stream in the dumps
   that the manifest omits — enumerate the server's stream list after seeding and
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
dumps differ by one byte, an event whose actor is not a named subject, a digest the
manifest pins that `ef replay` cannot reproduce from the committed dump, a
`secret-garden` read that succeeds cross-tenant, or a seeded stream absent from the
manifest — each cited with the stream id, dump path, offset, and digest pair. "The
corpus should also contain merges" is a later task's row to add via `regen-E3-seed`,
not a finding. No refutation → promote your sharpest hand-picked flip (stream + byte +
predicted red) as an additional committed sensitivity case.

## Verification log
