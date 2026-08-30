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
