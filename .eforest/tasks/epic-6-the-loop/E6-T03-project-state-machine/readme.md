---
id: E6-T03
epic: 6
title: "Project state machine: server-enforced building, complete, paused, and invalid_loop"
priority: 603
status: implemented
depends_on: [E5]
estimate: M
capstone: false
---

## Goal

`packages/platform` gains a replay-derived project-state entity and a single validated
transition door for `building`, `complete`, `paused`, and `invalid_loop`. Every guarded
loop mutation consults that state at a cited offset: paused, complete, and invalid loops
cannot launch or advance agents; only an authenticated human transition can resume a
paused/invalid project; every transition records `statusReason`, actor, and `updatedAt`.

## Context

`.eforest/loop.md` defines project states as an enforcement contract, not a decorative
badge. Epic 3 rendered a badge, but Epic 6 must make forbidden work impossible at the
server. This task freezes the event/reducer and authorization boundary independently of
queue derivation and retry policy, which append transitions through this door later.

The authoritative record is a project-state stream. `.eforest/project.json` is a
deterministic projection for folder compatibility, never an independently writable
source. `updatedAt` is the accepted event timestamp and participates in replay; tests use
frozen timestamps.

## Deliverables

- `packages/platform/src/loop/project-events.ts`, `project-reducer.ts`,
  `project-transition.ts`, and `project-guard.ts`.
- Stable refusal reasons for paused, complete, invalid, stale-offset, unauthorized
  resume, and invalid transition attempts.
- Deterministic `.eforest/project.json` projector and frozen transition fixtures.
- Integration tests covering all state/actor/action combinations through real HTTP.
- `Makefile` target `verify-E6-T03` producing event logs, digests, and refusal goldens.

## Acceptance criteria

- [ ] `make verify-E6-T03` exits 0 cold with zero skips; replaying the committed state
      log twice yields the same digest and byte-identical `project.json` projection.
- [ ] The server refuses loop launch, task claim, verdict append, and automatic resume
      while `paused` or `invalid_loop`, and refuses launch/advance while `complete`; each
      refusal leaves all relevant stream heads byte-identical.
- [ ] Only a human-authorized dispatch can transition `paused -> building` or
      `invalid_loop -> building`; an agent token receives the frozen refusal status and
      reason with zero project-state events appended.
- [ ] Automatic `building -> complete` is accepted only with a supplied queue proof that
      every task including the sole capstone is verified at the cited queue offset;
      tampering one task status causes stale/false-proof refusal.
- [ ] Every accepted transition has nonempty `statusReason`, actor identity, and frozen
      timestamp, and projection of the same log is independent of host clock, locale,
      data path, and process id.
- [ ] No code path writes authoritative project status by editing `project.json` or any
      database/side table; a direct projection-file edit is overwritten by replay and
      cannot change the server guard decision.
- [ ] Browser evidence is declared `Replay: N/A (server state/guard contract; the live
      project controls and badge integration land in E6-T06)`; mitigation is the real
      HTTP authorization matrix, state logs, projection bytes, and replay digests.

## Adversarial verification

1. Enumerate every state x actor-role x loop-action tuple through real HTTP. Any action
   admitted outside the matrix or any allowed action refused refutes enforcement.
2. Race a human pause against an agent launch using the same expected offset. Exactly one
   append may win; a launched run after the accepted pause offset refutes atomicity.
3. Forge complete proofs with a missing capstone, pending optional-looking task, duplicate
   task id, and stale queue head. Any accepted proof refutes completion semantics.
4. Edit/delete `project.json` while the server is running, restart cold, and compare the
   guard state and projected bytes to replay. Influence from the file refutes stream
   authority.
5. Remove the invalid-loop guard in a scratch worktree. `verify-E6-T03` must fail on an
   attempted launch; green refutes sabotage sensitivity.

## Verification log

### 2026-08-30 — builder — implemented, not yet verified

- Implementation commit `58d7132c` (branch `e6-t03-project-state-machine`, stacked on the
  verified E6-T02 tip `3565c19c`). **The project state is a stream, not a file:** the
  authoritative status of a hosted repository is `replay(project:<org>/<repo>)` under the
  registered `project/v1` reducer (`packages/platform/src/loop/{project-events,
  project-reducer, project-transition, project-guard, project-projection}.ts`, documented
  in `packages/platform/src/loop/README.md`). Two event types ride that stream:
  `project.transitioned` — the single validated transition door (`to`, `expectedOffset`,
  nonempty `statusReason`, `by{actor,role}`, optional queue `proof`) — and
  `loop.launch.requested`, the guarded loop action that has no runtime yet (E6-T07/T11)
  but whose event and guard are frozen now so a launch outside `building` is impossible
  from the day the runtime exists. `ProjectState` records `status`, `statusReason`,
  `updatedAt` (= the accepted event's `ts`, replayed), `actor`/`actorRole`, `head` (the
  offset a dispatcher must cite), `transitions`, `launches`, `completion`, `lastLaunch`.
  `.eforest/project.json` is `projectProjectionBytes(state)` — canonical JSON derived from
  state alone, with a pure civil-date `updatedAt` (no `Date`, no TZ, no locale); replay
  writes it and the guard never reads it (purity grep in the target: no `node:fs`, clock,
  RNG, env, or net in `src/loop`).
- Dispatch contract (`packages/platform/src/gateway.ts`, `validation.ts`,
  `authz/decide.ts`): `project:<org>/<repo>` is a repo-scoped application stream on
  `main`, minted on its first event; the actor role is derived from the authorization
  basis of the presented credential — an owner/admin **web session** (`repo-owner` /
  `org-owner` / `membership:admin`, which `decideStreamAuthorization` grants only to
  `principal.session === true`) is `human`, a grant-backed bearer token (`grant:write`)
  is `agent`; `by.actor` must equal the stamped identity (`project/actor-mismatch`) and
  `by.role` the derived role (`project/role-mismatch`). Transition table per
  `.eforest/loop.md`: `building→paused` human-only (`project/human-required`),
  `building→invalid_loop` anyone, `building→complete` anyone with a queue proof,
  `paused→building` / `invalid_loop→building` / `complete→building` human-only
  (`project/unauthorized-resume`), `paused→invalid_loop` anyone, everything else
  `project/invalid-transition`; a moved head is `project/stale-offset`. The loop guard
  (`guardLoopAction`) runs for the launch on the project stream and — via
  `guardTaskLoopAction`, before the E6-T01 task validator — for `task.started`,
  `task.claimed`, `task.refuted`, `task.rework-started`, `task.verified` on the task's
  issue stream: `project/paused`, `project/complete`, `project/invalid-loop`. Every
  refusal is a 409 citing `error.project = {stream, offset, status}` — the exact project
  head it was decided at — and leaves every stream head byte-identical. A queue proof
  cites the repo issue catalog `repo-issues:<org>/<repo>` at its current head
  (`project/stale-proof` otherwise) and must list exactly the catalog's loop tasks (any
  `task.*` event, or labeled `task`/`capstone`) with their replayed status and capstone
  flag (label `capstone`); the door replays each task stream, so an omitted, invented,
  duplicated, or misreported task, a missing/doubled capstone, or a non-`verified` status
  is `project/false-proof`. `GET /api/repos/<org>/<repo>/project` returns the replayed
  state, digest, and projection bytes. `ef replay --digest --reducer project/v1
  --stream-id …` resolves the platform-registered reducer (CLI fallback, since the
  reducer registry cannot depend on the platform).
- Exact commands: `pnpm format:check` (7 pre-existing files flagged, none mine),
  `pnpm lint` (18 errors, the main baseline — `gateway.ts` `_closes` and `cli.ts`
  duplicate `else if` predate this branch), `pnpm typecheck` (41 errors = baseline, none
  in changed files), `pnpm test` (120 files run in foreground file groups because one run exceeds the 10-minute session budget on this loaded host: 117 passed; 3 failures pre-existing and untouched — `packages/meadow/test/links.plan.test.ts` README drift, `packages/platform/test/issues.test.ts` 7-vs-8 workflow keys, `packages/pr/test/pr-property.fuzz.test.ts` timeout; `evidence-contract.test.ts` passes 4/4 in 77 s uncontended; `project-state.test.ts` 6/6), `pnpm build` (green), `make verify-E6-T03`
  (exit 0, zero `SKIPPED:`), sabotage run (below).
- Evidence (all in `evidence/`, hashed before/after by the verifier so nothing regenerates
  at test time): `e6-t03-project.jsonl` — the 7-event frozen lifecycle on
  `project:maple/loom` produced through the real `/api/dispatch` door (agent launch →
  human pause → human resume → agent invalid_loop → human recovery → human launch → agent
  complete with the real queue proof over two verified tasks incl. capstone `loom-cap`);
  `e6-t03-project.state.json` + `e6-t03-project.digest` =
  `add332a3ba1cff9a28f11cca935e2a68a45e8deef7a123e73a9eae17ea32fe48` (status `complete`,
  5 transitions, 2 launches, `updatedAt` 2006, actor `agent-ash`); `e6-t03-project.json`
  — the projection bytes (sha256 `bdc7c02e079b0035466f7d5eea7117331f8e3556a33615652802be50c31693dc`,
  475 bytes); `e6-t03-matrix.txt` — 72 real-door tuples (4 states × {human, agent} ×
  {launch, →building, →paused, →invalid_loop, →complete, →complete+proof} plus agent ×
  5 task loop events and human × `task.started` per state): 54 refusals with `before ==
  after` on both the project and the task stream and the cited offset/status, 18
  acceptances each advancing exactly the target stream, plus 12 binding/shape/family
  refusals (404/422/409: actor-mismatch, both role forgeries, stale offsets, proof on a
  pause, empty proof); `e6-t03-proofs.txt` — 13 forged completion proofs refused without
  moving the head (missing capstone, stripped/doubled capstone flag, duplicate id, stale
  and future queue heads, foreign catalog, invented task, omitted pending task, honest
  pending, pending and implemented tampered to `verified`, stale after a new task) and
  the true proof accepted twice (agent; then human after a human replan, the agent
  self-resume refused `project/unauthorized-resume`); race (`E6_T03_RACE`, 3 rounds):
  a human pause and an agent launch dispatched concurrently at the same `expectedOffset`
  — exactly one 202, the loser `project/stale-offset`, head +1, and a launch after the
  accepted pause offset refused `project/paused`; projection tamper/delete + cold
  restart: with `project.json` edited to `building` the launch is still refused
  `project/complete`, replay overwrites the edit and restores the deleted file
  byte-for-byte, and a second gateway on the same streams returns the identical
  `/project` body and refusal; `e6-t03-sabotage.txt` — with the
  `E6_T03_INVALID_LOOP_GUARD` arm removed, `invalid_loop/human/launch` is admitted (202
  instead of 409), the pure-guard check and the verifier's `E6_T03_GUARD` step go red,
  4 other tests still pass.
- `make verify-E6-T03` = `tools/verify/e6_t03_evidence.mjs` + the focused suite (6 tests):
  builds tasks/reducers/platform/cli, fail-closed purity grep over `src/loop`, replays the
  frozen log to the frozen state/digest/projection, runs `ef replay --digest --reducer
  project/v1` in two fresh processes (foreign cwd + `Pacific/Kiritimati` vs repo cwd +
  UTC) and `e6_t03_project.mjs` in two more (`America/Sao_Paulo`, `LANG=C`) to
  byte-identical digest + projection, holds all 84 matrix rows and 15 proof rows to
  identical heads and full coverage of the 12 `PROJECT_REFUSAL_REASONS`, checks the
  admitted set is exactly the matrix, tampers/deletes a projection file and re-projects,
  asserts the pure guard and the pure validator refuse a launch against the frozen
  `invalid_loop` prefix, and prints two `MUTATION … EXPECTED-FAIL OK` sentinels (one byte
  in the last event of each kind changes the digest), then `self_check`/`verify-list`.
  Cold clone: `bash tools/verify/cold_clone.sh verify-E6-T03` passed from pristine committed HEAD `58d7132c` (exit 0, zero `SKIPPED:` lines, `DEPENDENCY_INTEGRITY_OK`, `E6_T03_DIGEST add332a3…fe48`, both `MUTATION … EXPECTED-FAIL OK` sentinels, `verify-E6-T03: OK`).
- Replay: N/A (server state/guard contract; the live project controls and badge
  integration land in E6-T06) + mitigation: the real HTTP authorization matrix, the
  frozen state log, projection bytes, two-process replay digests, forged-proof and race
  transcripts, and the sabotage transcript above are the evidence layer.
- What the run demonstrates: the project's status is replay of its own stream, refused
  or accepted at one door that cites the offset it decided at; no loop action can run and
  no loop can self-resume while `paused`, `complete`, or `invalid_loop`; only a session
  credential can resume; completion is accepted only against a proof the server re-derives
  from every task stream at the cited catalog head; the projection file is output only;
  and the measuring apparatus is sensitive to one byte and to the removal of the
  invalid-loop guard.

### 2026-08-30 — critic — VERDICT: refuted

- ORIENT — digest recomputed independently (`work/critic/digest.mjs`, TZ=Asia/Kolkata,
  LANG=fr_FR): state digest `add332a3…fe48`, projection sha256 `bdc7c02e…93dc` (475 bytes),
  `updatedAt` 2006 = `log[6].ts`; matches the committed artifacts. No `.skip`/`.todo`/
  `eslint-disable` in the diff; goldens are frozen (verifier hashes them before/after).
  `make verify-E6-T03` exit 0 locally and `bash tools/verify/cold_clone.sh verify-E6-T03`
  PASSED from pristine `99ef1c33` (`work/critic/cold.log`: zero `SKIPPED:`,
  `DEPENDENCY_INTEGRITY_OK`, both `MUTATION … EXPECTED-FAIL OK`). Criterion 1 holds.
- P2 pause-vs-launch atomicity (criterion 2 / attack 2) — **FAILED across gateways.**
  Predicted: after an accepted `building -> paused` on `project:maple/race`, no
  `task.claimed` on `issue:maple/race/*` is appended. Observed (`work/critic/attack.mjs`,
  log `work/critic/attack.log`): with two `PlatformGateway` instances on the same durable
  server — the exact configuration the builder's own cold-restart test runs — gateway B
  validates `task.claimed` (reads `project:` = `building`), gateway A appends the pause
  (202), then B appends the claim (202): append order
  `A:project.transitioned > B:task.claimed`, final state `project=paused`,
  `task tx=implemented`. Deterministic with a 200 ms read delay on B; **24 of 30** rounds
  with no delay at all. Within one process the single global `WriterLaneDispatcher.serial`
  (`packages/platform/src/writer-lanes.ts:174`) serializes the two streams, so the
  same-stream race (20 rounds, exactly one winner, loser `project/stale-offset`, late
  launch `project/paused`) and the single-gateway cross-stream race (0/10) are clean.
  Root cause: `guardTaskLoopAction` (`project-guard.ts:96-107`, called from
  `gateway.ts` `validateTaskDispatch`) decides on an unfenced read of the project stream
  and stamps nothing on the task event — the builder's own caveat "documented, not
  stamped". Demand: make every guarded task event cite the project head it was decided at
  (e.g. stamp `project: {stream, offset}` on the accepted task event, and refuse at append
  if the project head moved, or fence task-stream appends on the project stream) so the
  refusal holds for N gateways, and add a two-gateway race to the suite.
- P4 completion proof (criterion 4 / attack 3, "pending optional-looking task") —
  **FAILED.** Predicted: a repo with a pending task cannot reach `complete`. Observed on
  `project:maple/proofs` (cap verified+capstone, t1 verified, t2 opened+labeled `task`):
  the honest proof, tampered status, omitted t2, missing/doubled capstone, duplicate id,
  foreign catalog, invented task, empty proof, stale/future head are all refused with the
  frozen reasons and unchanged heads (`attack.log`, `work/critic/attack2.mjs`) — but the
  agent token then dispatched `issue.unlabeled {label:"task"}` on t2 and the same
  agent's proof listing only cap+t1 was **accepted (202)**; and on `project:maple/plain`
  (cap verified, `bug-7` opened with no label) the proof listing only cap was **accepted
  (202)**. `isLoopTask` (`project-transition.ts:181-187`) defines the completion universe
  by agent-mutable labels, while E6-T01 defines a task as any issue (`replayTaskLog`
  status `pending`). Demand: the set of tasks a proof must cover cannot be shrinkable by
  the proving credential — either every catalog issue is a task (E6-T01 identity) or
  membership is derived from something an agent cannot retract; add both forgeries
  (agent unlabel-then-complete, unlabeled pending issue) to `e6-t03-proofs.txt`.
- P3 human-only resume — held. Real `decideStreamAuthorization` audited for a dispatch on
  `project:maple/loom` over 14 principal classes (`work/critic/authz.mjs`): the only allowed
  bases are `repo-owner`/`org-owner` (session) and `grant:write` (bearer; also for a
  subject who is an org owner but presents a grant), so `projectActorRoleOf` is exhaustive.
  Through HTTP: unauthenticated launch 401; agent `by.role:"human"` and human
  `by.role:"agent"` `project/role-mismatch`; agent with a human-looking `by.actor`
  `project/actor-mismatch`; agent self-resume from paused/complete
  `project/unauthorized-resume`; admin/org-owner sessions pause/resume as `human`; all with
  heads unchanged.
- P5/P6 — held: `ts` is client-supplied and replayed (`updatedAt` = event `ts`); no clock/
  fs/env in `src/loop` (fail-closed grep in the target); a `project.json` on disk saying
  `building` changes nothing (launch still `project/paused`); a cold second gateway returns
  the byte-identical `/project` body and refusal.
- Sabotage — sensitive: worktree mutant 1 (invalid_loop arm returns `undefined`) turns
  `make verify-E6-T03` red (`invalid_loop/human/launch … expected 202 to be 409`, exit 2,
  `work/critic/sab1.log`); mutant 2 (drop the `guardTaskLoopAction` call in `gateway.ts`)
  fails the matrix test (`paused/human/task.started … expected 202 to be 409`,
  `work/critic/sab2.log`).
- COVERAGE — gateway dispatch wiring, `validateTaskDispatch` hook, 404/422/409 mapping,
  `/api/repos/<org>/<repo>/project`, validation registry, authz `project:` target, CLI
  `project/v1` fallback, projector: all executed by the frozen suite/verifier and my runs.
  `Makefile`, `index.ts` exports, `cold_clone_targets.txt`: waived (config).
- Hardening, not blocking (outside the stated contract): a whitespace-only `statusReason`
  (`"   \t"`) is accepted (literal "nonempty" holds; consider trimming); a launch citing
  `agent-run:otherorg/z` under `project:maple/misc` is accepted (the run stream should be
  the project's org); `GET /api/repos/Maple/roles/project` is a 500 under an allowing
  authz oracle because `projectInitialStateForStream` throws before the name is checked
  (the real decision refuses the malformed target first); `expectedOffset:"3"` is
  refused as `project/stale-offset` rather than a 422.
- SUITE: n/a until the two refutations clear; the critic harness and logs stay in
  `work/critic/` for the rework.
Commands: `node work/critic/digest.mjs`; `make verify-E6-T03`; `bash tools/verify/cold_clone.sh verify-E6-T03`; `node work/critic/attack.mjs`; `node work/critic/attack2.mjs`; `node work/critic/authz.mjs`; worktree mutants + `make verify-E6-T03` / `vitest run packages/platform/test/project-state.test.ts`.

### 2026-08-30 — builder — rework after critic run 1 (implemented, not yet verified)

- Rework commit `f557cb72` (on top of the refuted `58d7132c`/`99ef1c33`; verdict
  `39a02863`). Both refutations are closed by general invariants, not special cases:
- **Cross-process fence (P2).** The guard decision for a task loop event is no longer an
  unfenced read. Before `task.started` / `task.claimed` / `task.refuted` /
  `task.rework-started` / `task.verified` is appended, the door re-decides against a
  fresh replay of `project:<org>/<repo>` and *commits* that decision by
  compare-and-appending a `project.fenced` record (`project-guard.ts`
  `fenceTaskLoopAction`, appender in `gateway.ts` `projectFenceAppender`) at the project
  stream's durable sequence (`Stream-Seq`), bound to the task stream and the exact offset
  the event will occupy (`payload.target`). A pause — from any gateway process — that
  wins that sequence makes the fence conflict; the door re-reads and refuses with the
  winning state's reason (`project/paused`, …). The project stream is thus one linear
  history in which no fence, hence no task loop event, follows an accepted pause at that
  pause's sequence; eight lost races fail closed as `project/fence-contention`. The task
  event's payload is untouched (E6-T01 shapes, `isEvent`, and the writer lane's
  idempotent-recovery compare all forbid an extra field; the E6-T01 fixture digest is
  unchanged), and the binding lives on the project stream instead — documented in
  `packages/platform/src/loop/README.md`. Fences replay as `ProjectState.fences` and
  never move `head`, so `expectedOffset` citations stay stable for humans. Clients cannot
  dispatch `project.fenced` (404).
- **Non-shrinkable proof universe (P4).** `isLoopTask` / `expectedProofTask`
  (`project-transition.ts`) now derive membership from the task stream's append-only
  history: an issue is a task once any `task.*` event exists on it or once it has *ever*
  carried the `task` or `capstone` label; `issue.unlabeled` retracts nothing; capstone is
  likewise ever-labeled. A plain issue never started and never labeled is not a task and
  does not block completion (the critic's option 2, chosen so bug reports never gate a
  project). Omitting a started or ever-labeled task, or citing an issue outside the
  universe, is `project/false-proof`.
- Hardening closed: whitespace-only `statusReason` → 422; `expectedOffset` outside the
  strict `-1` / 16+16-digit grammar → 422; a launch citing `agent-run:<other-org>/…` →
  409 `project/foreign-run`; `GET /api/repos/<Org>/<repo>/project` → 404 (name checked
  before any state).
- Exact commands: `pnpm format:check` (7 pre-existing files, none mine), `pnpm lint`
  (18 = baseline), `pnpm typecheck` (41 = baseline), tests in foreground file groups
  (single run exceeds the session budget on this host): 119/120 files exercised — 116
  passed; `issues.test.ts` and `meadow/links.plan.test.ts` are the known baseline
  failures; `pr-property.fuzz.test.ts` is the known baseline timeout and was not re-run;
  `project-state.test.ts` 7/7, `evidence-contract.test.ts` 4/4; `pnpm build` green;
  `make verify-E6-T03` exit 0; `bash tools/verify/cold_clone.sh verify-E6-T03` PASSED
  from pristine `f557cb72` (exit 0, zero `SKIPPED:`, `DEPENDENCY_INTEGRITY_OK`).
- Evidence (regenerated, frozen, hashed before/after by the verifier):
  `e6-t03-project.jsonl` — now 13 events: six fences left by the two seeded tasks
  (offsets 0–5) then the 7-event lifecycle (6–12); state digest
  `9140f6711188cbffac0e3e79d79ac95b2cecd4563fac58d203a838472376b79b`, `fences: 6`;
  `e6-t03-project.json` sha256 `8a308f5beeafcc9dd40a56c5dccedd1eaf0027b836d14841aaa2915bee209edd`
  (475 bytes); `e6-t03-matrix.txt` — 72 tuples (54 refused with identical heads, 18
  admitted; each admitted task loop event now leaves exactly one `project.fenced`
  record bound to its receipt offset) + 15 binding/shape/family refusals (the three
  hardening rows added); `e6-t03-proofs.txt` — 15 forgeries refused incl.
  `unlabel-then-omit-pending` (agent retracts the `task` label, proof still false) and
  `cites-plain-issue`, true proof accepted twice; new suite test "never appends a task
  loop event after an accepted pause across two gateway processes": gateway B with a
  120 ms delayed project-stream read races A's pause over 8 rounds —
  `E6_T03_XGATEWAY_RACE` 8× `pause-then-refused`, zero fences after the pause index
  (also green in the cold clone); verifier `E6_T03_FENCE`: an appender that always loses
  refuses `project/fence-contention` after exactly 8 attempts, a pause landing mid-race
  is re-decided `project/paused`, the fence cites the task stream + target offset;
  three `MUTATION … EXPECTED-FAIL OK` sentinels (fence `action`, launch `run`, final
  transition `statusReason`); `e6-t03-sabotage.txt` regenerated (invalid_loop arm
  removed → `invalid_loop/human/launch` 202-vs-409, verifier red).
- Replay: N/A (server state/guard contract; the live project controls and badge
  integration land in E6-T06) + mitigation: the two-gateway race transcript, fence
  records on the frozen log, the real-HTTP matrix and forged-proof transcripts, and the
  two-process replay digests above.
- What the rework demonstrates: with N gateways on the same streams the pause and the
  claim are ordered by one durable sequence, so "a launched run after the accepted pause
  offset" is impossible by construction, not by timing; and the completion universe is a
  function of append-only history that no proving credential can retract.
