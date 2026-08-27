---
id: E5-T13
epic: 5
title: "Capstone: issue-to-merge — file, branch, PR, review, merge; the issue flips to done via the merge, watched live, replayed offset-by-offset, zero databases"
priority: 513
status: implemented
depends_on: [E5-T08, E5-T11, E5-T12]
estimate: L
capstone: false
---

## Goal

The Epic 5 roadmap demo runs end-to-end from a **cold start** — fresh clone via
`tools/verify/cold_clone.sh`, scrubbed env, fresh server data dir, ephemeral port, two
fresh browser profiles — as one command: `make verify-E5-issue-to-merge`. The scenario
(driven by a committed demo script; this task _composes and proves_ E5-T01…T12, it
implements no new meadow behavior): browser **A** (the actor) files an issue through
the E5-T04 dispatch hook, flips it to `in-progress` on the E5-T05 board, forks a fix
branch from `main` at a recorded offset (E1-T08 fork through the platform), lands a
small fix on the branch (stream-fs patch events), opens a PR whose `pr/opened` payload
carries a `closes` reference to the issue (E5-T07 frozen entity-ref), leaves a review
comment, receives approval from B, and merges through the E5-T09 PR page — the accepted `pr.merged`
event drives the E5-T06 log-aware merge onto `main` **and** its E5-T07 close
propagation appends `issue.state-changed { to: "done", via: { prStream, prMergedOffset } }`
to the issue, exactly once. Browser **B** (the witness, a separate profile, separate
authenticated identity) holds the issue board, the issue detail, and the PR page open
across the whole run and observes **every** step live with zero reloads and zero
document navigations per watched surface — issue appears, flips to `in-progress`, PR
appears with its backlink, review comment and approval land, merge lands, issue flips
to `done` — each observation checkable via the E3-T02 DOM-exposed offset/digest
contract. In the same session, B attaches a piece of evidence (an event-log dump as an
E5-T10 content stream) to the PR and A sees it resolve live with its hash rendered
and matching (E5-T11); A edits a wiki page on the wiki branch (E5-T08) and B's open
wiki view updates live. **Verdict:** the full negotiation — issue stream, PR stream,
fix-branch stream, and `main` — is dumped and replayed offset-by-offset through the
E5-T12 negotiation harness to one composite digest; that composite digest byte-equals
the value recomputed from the DOM-exposed per-entity digests captured in browser B at
final quiescence; the issue's `done` flip sits at exactly the offset whose event cites
the merge (`via.prMergedOffset` string-equal to the `pr.merged` offset in the PR dump,
E0-T03 opacity: string comparison only). And the founding bet is audited mechanically:
**Application database count: zero** — a repo-wide dependency and source scan proves no
application database client or app-level persistence outside the official Durable Streams
boundary, while separately and honestly disclosing the official transport server's
transitive LMDB implementation substrate. Every artifact — per-entity logs, the composite
digest, the DOM captures, the wiki and evidence transcripts, and the database-boundary
audit — is committed under this task's `evidence/`. The captured session is fed to E5-T12's
existing replay and composite implementation; T13 does not rewrite or mutate T12's frozen
fixture or digest recipe.

## Context

ROADMAP.md, "Epic 5 — the-meadow", capstone **issue-to-merge**: "file an issue, flip
it to `in-progress`, fork a branch, fix, open a PR referencing the issue, review +
approve, merge — the issue flips to `done` via the merge's closing event, a second
browser watches every step live, and the whole negotiation replays offset-by-offset
with `ef replay`. Postgres count: zero." This task is that paragraph made executable
and hostile-critic-proof.

Everything it needs exists and is cited, never re-derived: the issue event model and
workflow reducer (E5-T01), the PR lifecycle stream (E5-T02), the derived board
(E5-T03), the browser write path with confirmed offsets and typed refusals (E5-T04),
the live issue UI (E5-T05), merge execution through the PR door (E5-T06), close
propagation exactly-once (E5-T07), the wiki branch and its live browser sync (E5-T08),
the PR pages with review timeline and backlinks (E5-T09), evidence attachments as
content streams (E5-T10) rendered live with matching hashes (E5-T11), and the
multi-stream negotiation replay harness with its composite digest and
`verify-E5-negotiation` target (E5-T12). `depends_on: [E5-T08, E5-T11, E5-T12]` is the
transitive frontier: E5-T12 pulls in the entity/merge/linking chain (T01–T07 via its
own deps), E5-T11 pulls in the PR pages and the attachment model (T09, T10), E5-T08
stands as the wiki leg (pulling the issue UI, T05). If the demo needs any frozen
contract changed — an event envelope, the entity-ref shape, the composite-digest
recipe, the DOM offset/digest exposure — that is a refutation of the earlier task,
not a patch here.

Per `.eforest/tasks/README.md`, a capstone requires the demo performed end-to-end
from a cold start — no state left over from development. The run that produces the
committed evidence is itself the cold-start run: fresh clone, fresh server data dir,
two fresh browser profiles, both browser sessions inside **one** Replay recording
(one recording, two contexts/pages — the witness's live observations must be
interrogatable in the same timeline as the actor's dispatches).

Non-goals: no new event types, reducers, or UI surfaces (any gap discovered is filed
against the owning task); no multi-conflict merge drama (the fix branch merges clean —
conflict surfacing is E5-T06/T09's proven ground); no third browser; no CLI watcher
involvement (the fix lands through the platform's own write paths — browser dispatch
and/or authenticated stream-fs appends — keeping the demo inside Epic 5's surface);
no performance claims beyond the pinned liveness bound below.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T13-issue-to-merge/`.

- `apps/web/test/capstone-e5.pw.ts` (E3-T02 Playwright harness) — the **demo
  script**: two isolated browser contexts (fresh profiles, distinct authenticated
  identities), the full actor sequence above, and witness-side assertions after every
  actor step — each step gated on B observing the change live (DOM offset advanced to
  at least the dispatch's returned offset, expected content present) within a pinned
  bound `LIVENESS_BOUND_S` (a named constant committed in the scenario config, stated
  in the transcript, never derived from the run), with zero console errors and zero
  document navigations asserted per context across the whole run. The script records
  every dispatch's returned offset and B's per-surface DOM offset/digest at each gate
  into a machine-readable timeline.
- `tools/verify/capstone_e5.sh` — the composed verdict: run the demo script against a
  fresh server; dump the four streams (issue, PR, fix branch, main) plus the wiki
  branch and the evidence content stream; replay the negotiation through the E5-T12
  harness to the composite digest; recompute the composite from B's captured DOM
  digests and byte-compare; assert the `done` flip's `via.prMergedOffset` string-equals
  the `pr.merged` offset in the PR dump and that exactly one `issue.state-changed`
  with that `via` exists; assert the attachment hash rendered in B equals the SHA-256
  of the attached content stream's replayed bytes; print one greppable line per check
  (`STEP n=<step> offset=<o> witnessed<=<bound>s OK`, `COMPOSITE digest=<d> dom=<d>
OK`, `CLOSE offset=<o> via=<o> count=1 OK`, `ATTACH sha256=<h> dom=<h> OK`,
  `WIKI offset=<o> witnessed OK`).
- `tools/verify/no_database_audit.sh` — the bet-4 audit, two halves. Half one scans
  every workspace `package.json` and application source for database clients/engines
  (`pg`, `postgres`, `mysql`, `sqlite`, `better-sqlite3`, `node:sqlite`, `knex`,
  `prisma`, `typeorm`, `sequelize`, `mongodb`, `redis`, `leveldb`, connection-string
  patterns), prints `NO-APPLICATION-DATABASE dependencies=0 sources=0 persistence=0
OK` or fails listing every hit, and includes planted `pg` and `node:sqlite`
  expected-red probes. It inspects the lockfile separately and must print
  `DURABLE-STREAMS-TRANSPORT package=@durable-streams/server substrate=lmdb ...
DISCLOSED`: LMDB and its native packages are the official transport package's
  transitive implementation substrate, not an application database dependency and not
  something this audit may hide or misclassify. Half two walks every list view touched
  (issue board, PR list, review timeline, evidence list, wiki index) and prints one
  `LIST-VIEW <route> stream=<derived-stream-or-reducer> OK` line per view, failing on
  any view that cannot name its source.
- `Makefile`: `verify-E5-issue-to-merge` inside the marker section — cold-clone
  semantics (scrubbed env, fresh server data dir, ephemeral port, fresh browser
  profiles), runs the demo script, the verdict script, the no-database audit, the
  sensitivity legs below, and re-runs `verify-E5-negotiation` (E5-T12) unmodified in
  the same clone; joins `verify-all`; `make verify-list` maps it to this task;
  `tools/verify/self_check.sh` still passes. The capstone must not fork the E5-T12
  harness — it feeds it.
- **Captured T13 session**: the run's seven per-entity dumps are committed under
  `evidence/e5-t13-session/` with the composite pinned in `expected.json`. The T13
  verifier invokes E5-T12's existing session replay and imports its frozen
  `compositeDigest`; no E5-T12 fixture, reducer, or recipe is copied or changed.
- Browser evidence: `tools/replay/record-run.sh -o e5-t13-final` — **one** Replay
  recording containing both browser sessions across the entire flow, fresh profiles,
  zero console errors. URL cited in the Verification log; `Replay: N/A` is not
  available to a capstone.
- `evidence/` from the recorded cold-start run:
  - `e5-t13-transcript.txt` — the full `make verify-E5-issue-to-merge` transcript,
    including `LIVENESS_BOUND_S`, every greppable verdict line, and the
    `verify-E5-negotiation` re-run.
  - `e5-t13-issue-log.jsonl`, `e5-t13-pr-log.jsonl`, `e5-t13-branch-log.jsonl`,
    `e5-t13-main-log.jsonl`, `e5-t13-wiki-log.jsonl`, `e5-t13-evidence-stream.jsonl`
    — the complete dumps, each with a `.sha256` sibling.
  - `e5-t13-digests.txt` — the composite digest from the E5-T12 replay, the composite
    recomputed from B's DOM captures, per-entity digests and head offsets at final
    quiescence, the `via.prMergedOffset` / `pr.merged` offset pair, and the attachment's
    content hash from both instruments.
  - `e5-t13-timeline.txt` — the machine-readable step timeline: each actor dispatch's
    offset, B's witnessed offset and wall-clock latency per surface, wiki and
    attachment observation marks.
  - `e5-t13-no-database.txt` — the full audit output including the
    planted-dependency self-test and every `LIST-VIEW … OK` line.
  - `e5-t13-sensitivity.md` — the sabotage transcript (below).

## Acceptance criteria

- [ ] Cold start: `make verify-E5-issue-to-merge` exits 0 from a pristine clone via
      `tools/verify/cold_clone.sh` — scrubbed env, fresh server data dir, ephemeral
      port, fresh browser profiles created during the run, zero skips — evidence:
      `make verify-E5-issue-to-merge 2>&1 | grep -c '^SKIPPED:'` prints `0`;
      transcript committed as `evidence/e5-t13-transcript.txt`.
- [ ] **Every step witnessed live.** For each of the nine causal steps (issue filed,
      in-progress, branch forked, fix landed, PR opened with backlink, review
      comment, approval, merge, evidence attached) plus the wiki edit, browser B
      observes the change with its DOM offset ≥ the dispatch's returned offset within
      `LIVENESS_BOUND_S`, with zero document navigations and zero reloads on any
      watched surface for the whole run and zero console errors in either context —
      evidence: `make verify-E5-issue-to-merge 2>&1 | grep -c '^STEP .* OK$'` prints
      ≥ `10`, per-step latencies in `evidence/e5-t13-timeline.txt`, the bound a
      committed constant that predates the run (git history), and the
      navigation/console assertions in the committed spec.
- [ ] **The merge closes the issue, exactly once, at the cited offset.** The issue
      dump contains exactly one `issue.state-changed { to: "done" }` whose
      `via.prMergedOffset` string-equals the `pr.merged` event's offset in the PR dump;
      the issue's reduced state is `done`; no manual close event exists anywhere in
      the issue dump (the flip came from E5-T07 propagation, not a hand edit) —
      evidence: `make verify-E5-issue-to-merge 2>&1 |
grep -c '^CLOSE offset=.* via=.* count=1 OK$'` prints `1`, offsets in
      `evidence/e5-t13-digests.txt`.
- [ ] **Composite digest, two instruments.** The E5-T12 harness replays the committed
      multi-stream dumps offset-by-offset to a composite digest, and the composite
      recomputed from browser B's DOM-exposed per-entity digests captured at final
      quiescence byte-equals it — evidence:
      `make verify-E5-issue-to-merge 2>&1 | grep -c '^COMPOSITE digest=.* dom=.* OK$'`
      prints `1` with the two fields equal; both values in
      `evidence/e5-t13-digests.txt`.
- [ ] **Merge integrity.** `ef replay` of the committed main dump yields a tree digest
      equal to the merged tree (the fix is present on main), and the fix-branch dump's
      fork offset resolves in the main dump to the recorded fork point — asserted by
      the verdict script, values in `evidence/e5-t13-digests.txt`.
- [ ] **Evidence attachment resolves.** The attachment rendered in browser B shows a
      hash byte-equal to the SHA-256 of the attached content stream's replayed bytes,
      and the attachment link resolves in B without error — evidence:
      `make verify-E5-issue-to-merge 2>&1 | grep -c '^ATTACH sha256=.* dom=.* OK$'`
      prints `1` with the fields equal.
- [ ] **Wiki live-sync in the same session.** A's wiki edit appears in B's open wiki
      view within `LIVENESS_BOUND_S`, no reload, and the wiki branch dump replays to
      the rendered content's digest — evidence:
      `make verify-E5-issue-to-merge 2>&1 | grep -c '^WIKI offset=.* witnessed OK$'`
      prints `1`.
- [ ] **Captured logs use the frozen replay implementation.** The run's seven dumps
      and pinned expected composite are committed under `evidence/e5-t13-session/`;
      T13's DOM composite calls E5-T12's exported recipe and byte-equals an independent
      `ef replay --session` result. The E5-T12 fixture and replay implementation remain
      unmodified.
- [ ] **Application database count: zero, official substrate disclosed, and every list
      view names its stream.** `tools/verify/no_database_audit.sh` scans every workspace
      `package.json` and application source and prints
      `NO-APPLICATION-DATABASE dependencies=0 sources=0 persistence=0 OK`; the planted
      dependency and import probes go red first; the audit also prints the official
      `@durable-streams/server` LMDB substrate as `DISCLOSED`, without flagging or hiding
      it; every list view the demo touches prints its `LIST-VIEW … OK` line — evidence:
      `make verify-E5-issue-to-merge 2>&1 |
grep -c '^NO-APPLICATION-DATABASE dependencies=0 sources=0 persistence=0 OK$'`
      prints `1`, both `NO-APPLICATION-DATABASE EXPECTED-FAIL` lines print once, and
      `grep -c '^LIST-VIEW .* OK$'` prints ≥ `5`; full output in
      `evidence/e5-t13-no-database.txt`.
- [ ] **One recording, both sessions.** The cited Replay recording (fresh profiles,
      `-o e5-t13-final`) contains both browser contexts across the entire flow:
      checkable at points, A's dispatches and B's corresponding live updates appear in
      the same timeline, B's DOM offset strictly advances across the run with no
      navigation events on watched surfaces, zero console errors in both contexts,
      and B's final DOM digests equal `evidence/e5-t13-digests.txt`. URL cited in the
      Verification log.
- [ ] **Sensitivity.** `verify-E5-issue-to-merge`'s sabotage step runs in a scratch
      worktree under each of: (a) E5-T07 close propagation disabled — must redden the
      `CLOSE` count assertion (issue never flips); (b) one byte flipped in a copy of
      the committed issue dump — the E5-T12 replay leg must go red at that offset;
      (c) browser B's live tail replaced by a reload-on-poll — must redden the
      zero-navigations assertion; (d) the DOM digest exposure frozen at a stale offset
      — must redden the `COMPOSITE` two-instrument equality; each leg must show the
      named assertion's failure line before its `EXPECTED-FAIL OK` — evidence:
      `make verify-E5-issue-to-merge 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ `5` (four
      legs plus the no-database self-test), transcript in
      `evidence/e5-t13-sensitivity.md`.
- [ ] Nothing forked: the full E5-T01…T12 verify targets re-run unmodified and green
      in the same cold clone; all workspace gates pass repo-wide (`pnpm format:check
&& pnpm lint && pnpm typecheck && pnpm test && pnpm build` exit 0);
      `make verify-list` maps `verify-E5-issue-to-merge` to this task; `verify-all`
      green — evidence: each target's name and exit status appended to
      `evidence/e5-t13-transcript.txt`.

## Adversarial verification

The claim under attack: "a complete issue-to-merge negotiation ran from a cold start,
a second independent browser witnessed every step live, the merge — not a hand —
closed the issue, the whole thing replays to one composite digest matching the DOM,
and there is no application database outside official Durable Streams." You are
refuting a _demo_, so your first suspicion
is choreography: staged state, a witness that polls-and-reloads, a close event
dispatched by the script instead of propagation, a composite digest computed once and
echoed twice. Use your own identities, your own edit content, your own timing. Any
single success refutes.

1. **Cold start or it didn't happen (mandatory).** Run `make verify-E5-issue-to-merge`
   only via `tools/verify/cold_clone.sh` on a machine/profile the builder didn't
   prepare: scrub `EF_*`/`REPLAY_*` env beyond the script's scrub, point `HOME` at a
   temp dir, verify the server data dir and both browser profiles are created during
   the run (`find` before/after). Any pre-created org/repo/issue, cached token, or
   warm profile refutes the cold-start claim outright.
2. **Witness independence.** Prove B actually watches the stream, not the script:
   (a) read the spec and the recording's network activity — any reload, refetch loop,
   or document navigation on a watched surface during the run refutes "live without
   reload"; (b) check B's context shares nothing with A's (separate profile dirs,
   separate auth identity — same-identity sessions refute "independent"); (c) at
   points in the recording, confirm B's DOM offset was _behind_ A's dispatch and then
   advanced — a witness whose DOM was written by the test harness rather than the
   live tail (grep the spec for any direct DOM manipulation or state injection into
   B's page) refutes the whole witness layer.
3. **Provenance of the flip.** Dump the issue stream yourself from the run's data dir
   and from the committed golden: the `done` flip must be the _only_ `state-changed
(done)`, its `via` must cite the real merge offset, and no `issue.state-changed`
   dispatched directly by the demo script may exist (hold the script against the
   dump: every issue event must trace to a scripted user action, and the close to
   E5-T07 propagation alone). A script that dispatches the close itself — even
   redundantly — refutes the headline moment.
4. **Two-instrument honesty.** The COMPOSITE check is only as good as its
   independence: read the verdict script and confirm the DOM-side composite is
   computed from values captured out of browser B's live DOM during the run (present
   in the recording — evaluate at the capture point and match), not re-derived from
   the same replay output. Then perturb: append one extra event to a copy of any
   entity dump and confirm the composite check goes red; capture B's DOM digests
   yourself at a point _before_ final quiescence and confirm they do NOT match the
   final composite (a digest that never changes is decorative and refutes the
   apparatus).
5. **Your own negotiation, same skeleton.** Re-run the demo with your own content:
   hostile issue titles (unicode, markdown injection), a review comment posted by B
   (the witness writes too — both identities are real), a wiki page with a large
   patch, an attachment of several megabytes. The verdict must still hold end-to-end.
   Then replay your run's dumps through the E5-T12 harness twice from scratch —
   composite digests must be byte-identical; divergence refutes determinism and is
   filed against E5-T12 with your dumps as the repro.
6. **Database hunt beyond the audit.** Run the no-database audit, then go past it:
   inspect the lockfile yourself for any storage engine the pattern list misses,
   `lsof`/`ss` the running server for connections to any port besides its own and the
   ephemeral test ports, and check the server data dir contains only stream-store
   files per the E0-T07 format. Then sabotage: add `pg` to a leaf package in a
   scratch worktree — the audit must go red; an audit blind to transitive deps or to
   a `node:sqlite` import refutes the bet-4 apparatus. Finally, hold the `LIST-VIEW`
   lines against the code: pick one at random and trace the route's data source —
   a view whose named stream is not what it actually reads refutes the audit's
   second half.
7. **Kill it mid-negotiation.** SIGKILL the server between the PR approval and the
   merge, restart it, and continue the demo: the merge and the close must still land
   exactly once (E5-T06/T07 claim crash-safety through the door; the capstone
   inherits it). A double close, a lost close, or a witness that silently reloads to
   recover refutes; file the finding against the owning task with this scenario as
   the repro.
8. **Replay interrogation.** Open the cited recording via the Replay MCP: confirm
   both contexts exist in one recording; jump to each STEP gate and verify B's DOM
   state matches the committed timeline (offset and content); confirm zero console
   errors and zero watched-surface navigations across the whole timeline; pull the
   attachment fetch from network events and hash the bytes against the ATTACH line.
   A recording missing either session, or whose final DOM digests disagree with
   `e5-t13-digests.txt`, refutes the browser claim.
9. **Evidence provenance.** Re-derive everything committed: replay each committed
   dump to its `.sha256`, run the E5-T12 harness on the captured T13 session and match
   the pinned composite, cross-check the timeline's offsets against the dumps (every
   STEP offset must resolve to a real event), and confirm the fork offset, merge
   offset, and `via` are mutually consistent across the four logs. Committed evidence
   that cannot be re-derived, or inconsistent by one offset, refutes its provenance.

Refutation currency: a reload in the witness's timeline, a close event with script
provenance, a composite that survives a mutated dump, an application database client or
an undisclosed transport substrate, a list view that lies about its stream, an offset in the evidence
that resolves to nothing, or a cold clone that needed warm state. "The demo felt
smooth" is a caption, not a finding.

## Verification log

### 2026-08-27 — builder — superseded static composition at `44fd18de`

- Invalidated: this checkpoint statically composed E5-T12 fixture logs and did not rerun
  the two-browser witness. Its generated evidence was removed and none of its success
  claims are current T13 evidence.

### 2026-08-27 — builder — causal browser implementation checkpoint

- Added a scoped BrowserWorld authenticated-context door backed by `IdentityStore.login`
  and the platform's internal signed `ef_session` cookie, plus focused unit coverage.
- Replaced fixture composition with a fresh-world, two-distinct-identity browser oracle:
  real issue and StreamFS dispatches, branch registration, PR review/evidence/approval,
  the `pr.merge` command and persisted outcome, exact merge-driven issue close, live wiki,
  DOM offsets/digests, clean lifecycle checks, seven-stream session capture, E5-T12 replay
  reuse, and causal sensitivity.
- Replaced the misleading database claim with an application-boundary audit that
  explicitly discloses the official Durable Streams server's transitive LMDB substrate.
- Validation intentionally pending by instruction: no browser gate, final
  `make verify-E5-T13`, cold clone, Replay recording, dependency-ticket verifier, queue
  rebuild, or root/full suite was run. This is an implementation checkpoint, not a
  verified claim; `status` remains `in-progress`.

### 2026-08-27 — builder — implemented with focused causal evidence

- Browser code head `7ef8cb0b`; final verifier head `e5ba5e7e`. The fresh-world run used
  two distinct signed identities and ten live causal steps. It finished with
  `BROWSER contexts=2 identities=2 bound_ms=5000 navigations=0 console=0 requests=clean OK`.
- `node tools/verify/capstone_e5.mjs` independently replayed seven captured streams and
  resolved four causal links. Replay and DOM composites both equal
  `06f7a48efbae1fc54bcbba0394e7de9bdd4e88b06a75eeb7baf77bf3d1f64fae`; the merge and
  exactly-once issue close both cite offset `0000000000000000_0000000000000003`.
- The focused sensitivity legs reddened a close-offset mutation, stale DOM digest,
  witness navigation, and manual close request. `node tools/verify/no_database_audit.mjs`
  also passed both planted failures, disclosed the official LMDB substrate, and proved
  five list-view stream declarations.
- Evidence: `evidence/e5-t13-transcript.txt`, `evidence/e5-t13-browser.json`,
  `evidence/e5-t13-timeline.txt`, `evidence/e5-t13-digests.txt`,
  `evidence/e5-t13-sensitivity.md`, and `evidence/e5-t13-session/`.
- Replay: N/A (installed Replay CLI lacks the required MCP/upload command) + mitigation:
  the committed two-context Playwright artifact, screenshots, request inventory,
  zero-error lifecycle assertions, deterministic stream dumps, composite replay, and
  mutation-sensitive verifier above. No dependency verifier, cold clone, root suite, or
  full workspace gate was rerun.
