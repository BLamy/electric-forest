---
id: E6-T04
epic: 6
title: "Live task queue: a replay-built projection with deterministic eligibility and dependency proofs"
priority: 604
status: implemented
depends_on: [E6-T01]
estimate: M
capstone: false
---

## Goal

`packages/tasks` derives a project's ordered task queue from task streams, resolves task
and bare-epic dependencies, and exposes a deterministic `nextEligible` decision with a
proof containing all task heads consumed. Priority, dependency, one-in-flight, and sole
capstone rules are enforced without a database; deleting the projection and replaying
the source streams reconstructs identical queue bytes and digest.

## Context

The runnable agents need one answer to "what is next?" that cannot drift from task
truth. This task productizes `tools/build_queue.py` semantics on streams while retaining
the human-readable `.eforest/tasks/QUEUE.md` projection. It depends only on the task
event model so queue work can proceed in parallel with folder sync and project guards.

Ordering is ascending numeric priority then id. A dependency is satisfied only by a
verified task, or for bare `E<n>`, that epic's unique verified capstone. Exactly one
task may be in-progress/implemented at a time. Cycles, missing ids, duplicate ids,
multiple capstones, and a capstone that is not last are invalid queue proofs, not empty
queues.

## Deliverables

- `packages/tasks/src/queue/projector.ts`, `eligibility.ts`, `proof.ts`, and
  `render-markdown.ts`.
- A derived queue stream/reducer and query endpoint returning queue digest, source heads,
  blocked reasons, in-flight task, and `nextEligible`.
- Differential fixtures shared with `tools/build_queue.py` plus graph fuzz tests.
- `Makefile` target `verify-E6-T04` proving rebuild and decision parity.

## Acceptance criteria

- [ ] `make verify-E6-T04` exits 0 cold with zero skips and rebuilds the committed queue
      fixture from source task logs to byte-identical JSON, Markdown, and digest after
      deleting every derived queue artifact.
- [ ] For every valid frozen graph, the TypeScript projector and `tools/build_queue.py`
      select the same task id and render the same ordered task/status/dependency tuples;
      any semantic difference fails the differential test.
- [ ] Task and bare-epic dependencies unblock only after the referenced task or unique
      capstone is verified; implemented, refuted, missing, or duplicate references remain
      blocked with an exact reason in the projection.
- [ ] When one task is in-progress or implemented, no second task is eligible; after its
      verified event the next decision changes at the new source head and cites it.
- [ ] Cycles, duplicate ids, missing dependencies, multiple/no capstones per completed
      epic, fractional priority without a reason, and a non-final capstone produce a
      deterministic invalid proof rather than `nextEligible: null`.
- [ ] Replaying source logs in all permutations consistent with per-stream order yields
      the same queue digest, proving the projection does not depend on fetch order.
- [ ] Browser evidence is declared `Replay: N/A (queue projector/query contract; board
      rendering lands in E6-T06)`; mitigation is Python/TypeScript differential output,
      rebuilt projections, exact queue digests, and graph sensitivity fixtures.

## Adversarial verification

1. Generate random DAGs and cyclic graphs, feed them independently to the Python and
   TypeScript implementations, and byte-diff normalized decisions. One mismatch refutes.
2. Change a dependency status at a source head after obtaining an eligibility proof, then
   submit the old proof. Acceptance of the stale selection refutes proof fencing.
3. Construct two concurrently in-progress tasks and two capstones. A normal-looking queue
   or arbitrary winner instead of an invalid proof refutes honesty.
4. Delete the derived stream and `QUEUE.md`, rebuild from shuffled source fetches, and
   compare exact bytes/digest in fresh processes. Drift refutes rebuildability.
5. Sabotage bare-epic dependency resolution. The verify target must fail a fixture where
   a non-capstone verifies before the capstone; green refutes sensitivity.

## Verification log

### 2026-08-30 — builder — implemented, not yet verified

- Implementation commit `b2666f1a` (branch `e6-t04-task-queue-projection`, stacked on the
  verified E6-T03 tip `7006c7e6`). **The queue is a derivation, not a table:**
  `packages/tasks/src/queue/{projector,eligibility,proof,render-markdown,graph}.ts`
  (documented in `packages/tasks/README.md`, "Queue projection (`queue/v1`)").
  `projectQueue({ catalog, tasks })` replays the repository issue catalog
  `repo-issues:<org>/<repo>` and every task stream it lists under `tasks/v1`; membership
  is E6-T03's (any `task.*` event or an ever-applied `task`/`capstone` label); a member's
  spec (`epic`, `priority`, `title`, `depends_on`, `capstone`) is the E6-T02 readme in the
  issue body (`parseTaskReadme`), its status is the replayed `tasks/v1` state — the body's
  frontmatter `status` is text, never authority (test "ignores the body's frontmatter
  status"). Order is ascending priority (exact decimal compare, no floats) then id. A task
  dependency is satisfied only by `verified`; a bare `E<n>` only by that epic's unique
  `verified` capstone (`E6_T04_BARE_EPIC_GUARD`); every other case blocks the task with an
  exact reason (`dep/unverified`+status, `dep/missing`, `dep/duplicate-ref`,
  `dep/epic-missing`, `dep/epic-no-capstone`, `dep/epic-multiple-capstones`,
  `dep/epic-capstone-unverified`). The decision is `eligible {nextEligible}`,
  `in-flight {inFlight}` (one `in-progress`/`implemented` task; nothing else may start),
  `rework` (the one `refuted` task with verified deps is next — `build_queue.py`'s current
  gate), `exhausted`, or `invalid {violations}` with deliberately **no** `nextEligible`
  key: `dep/cycle` (all members), `dep/missing`, `dep/epic-missing`, `queue/duplicate-id`,
  `queue/multiple-active`, `capstone/multiple`, `capstone/not-final`,
  `capstone/none-in-completed-epic`, `priority/fractional-without-reason` (a fraction
  needs a `Queue-jump reason:` line in Context — frontmatter comments do not survive the
  E6-T02 render), `spec/unparseable`, `spec/id-mismatch`, `capstone/label-disagrees`,
  `catalog/corrupt`. `queueProof(projection)` = `{ v, queue: {stream, offset} (E6-T03
  `ProjectQueueRef`), heads[] (every task head consumed), tasks[] ({id, status, capstone}
  = E6-T03 `ProjectProofTask`), finalCapstone, digest, decision }`;
  `checkQueueProof(proof, sources)` re-derives and refuses a moved head as
  `queue/stale-proof` naming the stream with cited and current offsets *before* comparing
  anything else, a forged digest/decision as `queue/false-proof`;
  `admitSelection(proof, id, sources)` is the fence a runner passes before starting `id`
  (`queue/not-eligible`, `queue/invalid`). `renderQueueMarkdown` is `QUEUE.md`-shaped and,
  for a valid graph, byte-identical to `tools/build_queue.py`'s output generator line
  aside (links are the stream-side `epic-<n>/<id>/readme.md`); an invalid queue renders
  its violations in place of the gate/next-up/unlocks sections.
  `GET /api/repos/<org>/<repo>/queue` (`packages/platform/src/gateway.ts`,
  `repositoryQueueRoute`) rebuilds the projection on every call and returns
  `{ streamId, offset, digest, projection, proof, markdown }`.
- Differential apparatus: `QueueGraph` fixtures (`evidence/fixtures/graphs/*.json`, 27
  frozen graphs: 13 valid, 14 invalid) feed both sides — `queueSourcesFromGraph` builds the
  streams, `graphReadme` the folder tree — and `tools/verify/queue_differential.py` runs
  the **unmodified** `tools/build_queue.py` (copied into a scratch `tools/` beside the
  rendered `.eforest/tasks/` tree) and normalizes the `QUEUE.md` it writes into
  `{gate, nextUp, selected, tuples, unlocks, markdown}`; the Makefile greps that the
  normalizer contains no `eligible`/`done_refs`/`capstone_verified` re-implementation.
  `generateQueueGraph(seed, {cyclic})` is the seeded graph fuzzer (mulberry32, no host
  randomness).
- Exact commands: `pnpm format:check` (7 pre-existing files flagged, none mine),
  `pnpm lint` (18 errors = baseline, none in changed files), `pnpm typecheck` (41 = baseline),
  `pnpm test` in three foreground groups (`vitest run --maxWorkers=1`: 47 + 33 + 44 = 124
  files, 940 tests; exactly the 3 pre-existing failures — `packages/meadow/test/links.plan.test.ts`
  README drift, `packages/platform/test/issues.test.ts` workflow key count,
  `packages/pr/test/pr-property.fuzz.test.ts` timeout — nothing new), `pnpm build` (green),
  `make verify-E6-T04` (exit 0, zero `SKIPPED:`), sabotage run (below), then
  `bash tools/verify/cold_clone.sh verify-E6-T04` from pristine committed HEAD `b2666f1a`
  (exit 0, zero `SKIPPED:`, `DEPENDENCY_INTEGRITY_OK`, `E6_T04_DIGEST 1b4e09ec…75ec`,
  `MUTATION … EXPECTED-FAIL OK`, `verify-E6-T04: OK`, `PASSED from a pristine clone`).
- Evidence (all in `evidence/`, hashed before/after by the verifier so nothing regenerates
  at test time): `e6-t04-sources.jsonl` — the 8 source streams (catalog + 7 task streams
  over `maple/loom`, graph `mixed-epics-interleaved-priority`: two verified epics,
  a queue-jumping `150.25` task with a stated reason, three capstones) →
  `e6-t04-queue.json` / `e6-t04-QUEUE.md` (sha256
  `dae6f93c83215b4a195c56558968c5e034eaf1d19ac01ac5cfc906516c66cce3`, 1252 bytes) /
  `e6-t04-queue.digest` = **`1b4e09ecdf1c69bda02161d0a83f231fa542c67a77c7bfaceac88bd669d775ec`**
  (decision `eligible E2-T01`, catalog head `…0006`, 7 task heads) / `e6-t04-proof.json`
  (sha256 `f64b5a214a296e4b2fa5112798866202d0e1d97fcdd0f3e413a9c19dfdfd7a35`); `expected/` — for each of the 27
  graphs the frozen `queue.json`, `QUEUE.md`, `digest`, and for the 13 valid ones the
  frozen live-Python `python.json`; `e6-t04-endpoint.txt` (sha256
  `c9942f5a8ec053b1dcec56dcf819906a478af76e2561e4bf445eb50f121aed85`) — the real-gateway transcript
  (`packages/platform/test/task-queue.test.ts`, `EFOREST_E6_T04_PRINT=1` to re-emit): empty
  repo → `exhausted` at catalog `-1`; four tasks seeded through `/api/dispatch` (E1-T01
  implemented, E1-T02 [E1-T01], capstone E1-T03 [E1-T02], capstone E2-T01 [E1]) →
  `in-flight E1-T01`, E2-T01 blocked `dep/epic-capstone-unverified E1:pending`, every cited
  head equal to the substrate's, a second gateway process returning the byte-identical
  body, an independent `projectQueue` over re-read streams reproducing digest/proof/
  markdown; `task.verified` on E1-T01 → `eligible E1-T02` with E1-T01's head `…0003 → …0004`,
  the old proof refused `queue/stale-proof {stream: issue:maple/queue-live/E1-T01, cited …0003,
  current …0004}`, `admitSelection(old, E1-T02)` refused, `admitSelection(new, E1-T02)` ok,
  `admitSelection(new, E1-T03)` `queue/not-eligible`; `task.started` on E1-T02 →
  `in-flight E1-T02`, nothing eligible; `e6-t04-sabotage.txt` — with
  `E6_T04_BARE_EPIC_GUARD` set to `false` (any verified task of the epic satisfies `E<n>`),
  the frozen `bare-epic-noncapstone-first` fixture selects `E2-T01` instead of `E1-T02`:
  5 tests red (frozen projections, the bare-epic test, both Python differentials —
  `dag-13` diverges too — and the endpoint transcript), `e6_t04_evidence.mjs` exit 1,
  `make verify-E6-T04` exit 2.
- `make verify-E6-T04` = builds tasks/reducers/platform; fail-closed purity grep over
  `packages/tasks/src/queue` (`command grep …; test $? -eq 1`: no clock, RNG, env, fs, net,
  child_process); `build_queue.py` must still define its semantics and parse; the focused
  suite (19 tests in 4 files: eligibility 12, fuzz 3, differential 2, gateway 2); then
  `tools/verify/e6_t04_evidence.mjs`: (1) sources → projection/markdown/digest/proof equal
  to the committed bytes; (2) **delete-and-rebuild** in three fresh processes (foreign cwd +
  `Pacific/Kiritimati`; `--shuffle 7` from `packages/tasks` + `America/Sao_Paulo`;
  `--shuffle 12345` + UTC; `LANG=C`, `NODE_ENV`/`NODE_OPTIONS` scrubbed) writing
  `queue.json`/`QUEUE.md`/`queue.digest`/`proof.json` byte-identical to the committed
  artifacts; (3) all 27 frozen graphs to their committed projection/markdown/digest, invalid
  ones without `nextEligible`, 11 of 13 violation reasons reached from graphs (the other
  two — `queue/duplicate-id`, unreachable through a catalog, and `catalog/corrupt` — are
  covered by direct tests); (4) **Python/TypeScript differential**: the real
  `build_queue.py` over the 13 valid graphs (frozen `python.json` must equal the live run,
  zero warnings) plus 40 generated DAGs — 53 graphs, normalized decisions *and* markdown
  byte-identical, 0 mismatches; (5) permutation invariance: 120 generated graphs (60 valid,
  60 cyclic) × 3 orders (two seeded shuffles, reverse) = 360 identical digests; (6) fencing:
  a proof refused `queue/stale-proof` after E1-T02's stream moves (`…0005 → …0006`), and
  accepted against a shuffled fetch of the same heads; (7) the endpoint transcript's four
  steps and monotone head; (8) the sentinel fixture with the Python side agreeing on
  `E1-T02`; (9) one byte of the source log (`task` → `tasq` on E2-T01's label) moves the
  digest to `536219c4…73f4` — `MUTATION … EXPECTED-FAIL OK`; then `self_check`/`verify-list`.
  The vitest suite additionally proves: 150 seeds × (DAG, cyclic) × 4 fetch orders yield
  identical JSON/markdown/digest; every random DAG decides validly with the chosen task
  preceded by nothing eligible; every cyclic-mode violation is deterministic across two
  derivations; for 40 seeds a proof is refused after *each* task stream moves, naming it;
  two active tasks + two capstones → `invalid` with both violations and
  `admitSelection` → `queue/invalid`; a plain issue is not a member; a corrupt catalog is
  an invalid proof.
- Replay: N/A (queue projector/query contract; board rendering lands in E6-T06) +
  mitigation: the Python/TypeScript differential output (53 graphs), the rebuilt
  projections in fresh shuffled processes, the exact queue digests above, the real-gateway
  endpoint transcript, the graph sensitivity fixtures (sentinel + one-byte mutation), and
  the sabotage transcript are the evidence layer.
- Known seams (stated, not hidden): E6-T03's completion proof requires exactly one
  capstone repo-wide while this queue allows one per epic; `queueProof.finalCapstone`
  (the last capstone in queue order) is the field a completion should cite — reconciling
  the two is E6-T11/E6-T14's call, not changed here. The body-carried spec is fixed at
  `issue.opened` until E6-T05's `task/spec-revised` lands; `cancelled` exists only in
  folder frontmatter, never on a stream, so it does not appear in stream-derived queues.
- What the run demonstrates: "what is next" is a pure function of the repository's
  streams — same answer in any fetch order, in any process, after deleting every derived
  artifact — that agrees byte-for-byte with the board people already read; dependencies
  unblock only on `verified` and bare epics only on the verified capstone; one task is in
  flight at a time; every structural fault is an invalid proof rather than a quiet null;
  a proof is bound to every head it consumed and dies the moment any of them moves; and
  the apparatus goes red on one byte and on the removal of the bare-epic guard.
