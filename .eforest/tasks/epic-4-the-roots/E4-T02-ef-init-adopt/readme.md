---
id: E4-T02
epic: 4
title: "ef init: adopt a local directory — create project, repo, and main stream through authenticated dispatch and upload the tree, digest-verified"
priority: 402
status: pending
depends_on: [E4-T01]
estimate: M
capstone: false
---

## Goal

`ef init` (`packages/cli`, the same binary and package E2-T05 established) adopts an
existing local directory into the platform: run in a directory with no `.ef/`, it
(1) resolves credentials from `$EF_HOME/credentials.json` per E2-T05 (no
credentials ⇒ **local** typed refusal, exit nonzero, no request sent — same
local-refusal discipline E2-T05 froze for `ef logout`); (2) creates the namespace
through the one authenticated dispatch door: `ns.project.create { v: 1, name }` (skipped
with a note if the project already exists in the E2-T06 resolver view) and
`ns.repo.create { v: 1, name, project, visibility }` appended to `ns:org:<org>`,
bearer-verified per E2-T03, actor stamped by the server per E2-T06 — the repo name
defaults to the directory basename, overridable with `--repo`; (3) creates the main
branch as a stream-fs entity under the resolved frozen prefix
(`fs:<org>/<repo>:main:meta` plus per-file content streams, E1-T01's envelope,
`FS_EVENT_VERSION` respected) — the single branch-genesis fs event that brings the
meta stream into existence is constructed and dispatched by `init.ts` itself (its one
permitted fs-event dispatch; the tree-upload engine's contract assumes the branch
stream target already exists); (4) uploads the working tree as ordinary stream-fs
create/write dispatches via a **tree-upload engine**
(`packages/cli/src/sync/tree-upload.ts`, exported — E4-T06's uplink composes this exact
function, it is not init-private) that walks the tree under E4-T01's frozen enumeration
and exclusion rules (`.ef/` never uploaded, exactly the same exclusion set
`ef tree-digest` applies — one walker, imported, never a second implementation); and
(5) **verifies before it commits locally**: it dumps the main meta stream, replays it
through `ef replay --worktree-digest` (E4-T01's one exported `worktreeDigest`
projection — the only digest a directory walk can reproduce, since the raw E1-T01 tree
digest carries session-scoped `contentStreamId`s), and only if that digest
is byte-identical to `ef tree-digest .` (E4-T01) does it write the `.ef/` workspace —
E4-T01's frozen format, checkpointed at the exact head offset of the meta stream with
that digest recorded as the base. On any mismatch or any failed dispatch it exits
nonzero with a typed error and writes **no `.ef/`**. A tokenless or bad-token run is
refused with the pinned typed error (local `no-credentials`, or E2-T03/E2-T05's 401
taxonomy for a presented-but-invalid token) and is **log-neutral everywhere**: no
namespace event, no meta stream, no content stream — before/after head offsets and
digests of `ns:org:<org>` and the registry byte-identical. After a successful init the
repo appears in the E2-T08 `__registry__` derived stream and therefore in the E3-T04
repo list, live. `make verify-E4-T02` proves all of it from a cold clone.

## Context

This is the moment the CLI stops being a credential holder (E2-T05) and becomes a
version-control tool: the first command that mints platform state from a local
filesystem. Everything downstream of it in Epic 4 stands on the two properties frozen
here. First, **init is digest-verified adoption, not hopeful copying**: the acceptance
currency is `ef tree-digest .` (E4-T01) equalling `ef replay --worktree-digest` of the
uploaded meta stream — the same equation E4-T03 (clone), E4-T09 (two-machine convergence), and
the E4-T12 capstone settle in. Second, **the tree-upload engine is the uplink
primitive**: E4-T06 syncs live edits by calling the same walk/diff/api/dispatch machinery
with a base ledger instead of an empty one; if init grows a private uploader, Epic 4
forks its most load-bearing code path on day two.

Builds on: E4-T01 (`ef tree-digest`, the frozen `.ef/` workspace format, the frozen
enumeration/exclusion rules — this task adds no digest logic and no `.ef/` schema of
its own; if init needs a field `.ef/` doesn't have, that is a versioned E4-T01 format
change, done there); E2-T05 (credentials file, bearer injection, local-refusal
discipline); E2-T06 (namespace creation events, typed pre-append refusals like
`ns/name-taken`, the `fs:<org>/<repo>` prefix contract); E2-T03 (bearer verification
and the 401 taxonomy at every door); E2-T08/E3-T04 (the registry derived stream this
repo must appear in, and the page that shows it); E1-T01 (fs event envelope, `fsReducer`,
canonical tree digest); E0-T11 (the validated dispatch door — init introduces **no new
append path**; every mutation in this task is a dispatch).

Contracts frozen here, versioned from this task forward: the `tree-upload` engine's
exported signature and its guarantee (given a directory and a branch stream target, it
dispatches exactly the events whose replay reproduces the E4-T01 tree digest of that
directory — the engine is defined by that equation, not by its event count); the rule
that `.ef/` is written **only after** the server-side replay digest has been fetched and
matched locally; init's typed error classes (`no-credentials` local, reuse of the
E2-T03/E2-T05/E2-T06 taxonomy for door refusals, `init/digest-mismatch` and
`init/already-initialized` as new CLI-local classes with distinct nonzero exit codes);
and `.ef/`-never-uploaded as a property of the shared walker, not an init-side filter.

Non-goals: resumable/transactional init across a mid-upload crash (an interrupted init
exits nonzero and writes no `.ef/`; the namespace events it already appended are real
history — rerunning gets E2-T06's `ns/name-taken` and the operator picks a new name or
targets the E4-T03 clone path; offline reconciliation is E4-T10); ignore rules beyond
E4-T01's frozen exclusion set (no `.efignore` here); watch/sync (E4-T06+); creating
orgs (E2-T06's door exists, but `ef init` takes `--org` as a resolvable existing org —
an unknown org is E2-T06's typed `ns/org-not-found` refusal, surfaced verbatim).

## Deliverables

- `packages/cli/src/commands/init.ts` — `ef init [--org <org>] [--project <name>]
  [--repo <name>] [--visibility public|private]`: credential load, namespace dispatches,
  main-branch stream creation, tree upload via the shared engine, digest verification,
  `.ef/` write. Refuses `init/already-initialized` (distinct exit code, no request) if
  `.ef/` already exists.
- `packages/cli/src/sync/tree-upload.ts` — the shared uplink engine: walks the tree
  with E4-T01's enumerator (imported), dispatches stream-fs create/write events through
  the E0-T11 door with E2-T05 bearer injection, returns the final meta-stream head
  offset. No init-specific behavior inside; E4-T06 is its second caller.
- Typed error surface: `no-credentials`, `init/already-initialized`,
  `init/digest-mismatch`, plus pass-through of door refusals with their frozen
  `error.class`; each mapped to a distinct documented exit code in the package README's
  exit-code table (extending E2-T05's rows, never renumbering them).
- Tests (committed, green under `pnpm test`):
  - `packages/cli/test/init.happy.test.ts` — seeded fixture tree (nested dirs, empty
    file, binary file, unicode filename) → init → dumped meta stream replays to a
    digest equal to `ef tree-digest` of the fixture; `.ef/` checkpoint offset equals
    the dumped head; `.ef/` contents absent from every uploaded event.
  - `packages/cli/test/init.refusals.test.ts` — no credentials (local refusal, zero
    HTTP requests asserted via a request-counting test server, exit code pinned);
    already initialized (`ef init` in a fixture that already has `.ef/`, against the
    same request-counting server: **zero** HTTP requests asserted, the pinned
    `init/already-initialized` exit code — "without any dispatch" is a counted
    assertion, not a comment); revoked token (E2-T05's 401 `token-revoked` surfaced,
    exit nonzero); name collision (`ns/name-taken` surfaced); each refusal
    log-neutral by before/after head offset + digest of `ns:org:<org>` and no `fs:`
    streams created; no `.ef/` written in any refusal case (and in the
    already-initialized case the pre-existing `.ef/` is byte-identical afterward).
  - `packages/cli/test/init.verify-gate.test.ts` — fault injection: corrupt one
    uploaded content digest (test-double door), assert `init/digest-mismatch`, exit
    nonzero, no `.ef/`.
- `Makefile`: `verify-E4-T02` per E0-T02's per-task contract — cold-clone via
  `tools/verify/cold_clone.sh`, seeded emulator + pinned clock, scripted `ef login`,
  transcript script (`evidence/e4-t02-transcript.sh`): init a committed fixture tree,
  dump `fs:<org>/<repo>:main:meta`, `ef replay --worktree-digest` equals
  `ef tree-digest .`, `.ef/` checkpoint fields match, `GET /registry/me` names the
  repo; then a **second-repo step**: init a second committed fixture tree into the
  same org/project with a fresh repo name, assert the full digest equation for it,
  and diff the before/after dump of `ns:org:<org>` — exactly one new
  `ns.repo.create` and **zero** new `ns.project.create` events, offsets cited; then
  the tokenless, already-initialized (rerun `ef init` in the initialized fixture:
  typed `init/already-initialized` error, pinned exit code, before/after digests of
  `ns:org:<org>` and `__registry__` byte-identical), and name-collision refusal
  steps with before/after digests. Nonzero exit on any step.
- `evidence/` — `e4-t02-init-golden.jsonl` + `e4-t02-init-golden.digest` (the meta
  stream dump of the fixture init and its replay digest), `e4-t02-tree.digest`
  (the `ef tree-digest` output it must equal), `e4-t02-transcript.txt`,
  `e4-t02-sensitivity.md`, and the Replay recording URL (repo list showing the new
  repo) cited in the Verification log.

## Acceptance criteria

- [ ] `make verify-E4-T02` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env — no warm server state, no pre-existing `.ef/`, no ambient
      credentials.
- [ ] The digest equation: in the transcript, `ef replay
      evidence/e4-t02-init-golden.jsonl --worktree-digest` prints exactly
      the digest in `evidence/e4-t02-init-golden.digest`, and that digest is
      byte-identical to `ef tree-digest .` run in the fixture directory
      (`evidence/e4-t02-tree.digest`). Three artifacts, one hash.
- [ ] Checkpoint exactness: `.ef/` (E4-T01 format) records the main meta stream id,
      a head offset equal to the dumped stream's actual head, and a base digest equal
      to the digest above — asserted field-by-field in the transcript.
- [ ] `.ef/` hygiene: a grep of every dumped event (meta + all content streams) for
      any path beginning `.ef/` finds zero hits, asserted as a transcript step and in
      the committed happy-path test.
- [ ] Registry visibility: after init, `GET /registry/me` under the initiating
      identity includes the new repo with `repoStreamPrefix` equal to the exact string
      `fs:<org>/<repo>` (no trailing colon, no branch segment) per E2-T06's frozen
      prefix contract — a transcript string-equality assertion, no interpretation — and the
      `__registry__` dump contains the derived entry — both in the transcript with
      offsets.
- [ ] Tokenless refusal, log-neutral: with `$EF_HOME` empty, `ef init` exits with the
      pinned `no-credentials` code having sent **zero** HTTP requests
      (request-counting server assertion in the committed test); with a revoked token,
      the run is refused with E2-T05's 401 `token-revoked`; in both cases no `.ef/`
      exists afterward and the before/after head offsets and `ef replay --digest`
      digests of `ns:org:<org>` and `__registry__` are byte-identical, and no
      `fs:<org>/<repo>:*` stream exists — all in
      `evidence/e4-t02-transcript.txt`.
- [ ] Verify-before-commit: the committed fault-injection test shows a corrupted
      upload producing `init/digest-mismatch`, exit nonzero, and no `.ef/` directory.
- [ ] Re-init refusals: `ef init` in a directory with `.ef/` exits
      `init/already-initialized` without any dispatch — pinned in **both** layers:
      the committed refusals test runs the already-initialized case against the
      request-counting server and asserts **zero** HTTP requests plus the pinned
      exit code, and a transcript step reruns `ef init` in the initialized fixture
      and asserts the typed error, the exit code, and byte-identical before/after
      digests of `ns:org:<org>` and `__registry__`. Name collision, two pinned
      cases: (a) rerun against the **same org/project** with a colliding repo name, so
      `ns.project.create` is skipped (project already exists in the resolver view) and
      `ns.repo.create` is the first and only dispatch, refused pre-append with
      `ns/name-taken` — this run is log-neutral by before/after digest of
      `ns:org:<org>`; (b) run with a **fresh project name** and a colliding repo name —
      the `ns.project.create` event is appended and is honest history (per Non-goals),
      then `ns.repo.create` is refused pre-append with `ns/name-taken`; this run is
      **not** log-neutral (exactly one new `ns.project.create` event, nothing else),
      and in both cases no `fs:*` stream is created and no `.ef/` is written.
- [ ] Skip path succeeds, not just refuses: the transcript's second-repo step inits
      a second fixture tree into the **same org/project** with a **fresh** repo
      name and it must fully succeed — the digest equation holds for the second
      repo (`ef replay --worktree-digest` of its dumped meta stream byte-identical
      to `ef tree-digest` of its fixture), and the before/after dump of
      `ns:org:<org>` shows **exactly one** new `ns.repo.create` and **zero** new
      `ns.project.create` events, with the offsets cited in the transcript. A skip
      branch that only works on the collision path, or that re-appends
      `ns.project.create` on every run, fails this step.
- [ ] Shared-engine proof: `packages/cli/src/commands/init.ts` contains no tree walk
      and no fs-event construction of its own **except the single branch-genesis
      dispatch** that creates `fs:<org>/<repo>:main:meta` (Goal step 3) — that one
      call site in `init.ts` is the only fs event init constructs; every tree-content
      create/write flows through the exported `tree-upload` engine (whose signature
      takes the already-created branch stream target), and the walker/exclusion logic
      is imported from E4-T01's module (checked by the critic against the diff, not by
      a grep the builder wrote).
- [ ] Sensitivity proof: in a scratch worktree, (a) flip one byte of
      `e4-t02-init-golden.jsonl` — `make verify-E4-T02` MUST go red at the replay
      step; (b) make the walker stop excluding `.ef/` — the hygiene and digest steps
      MUST go red. Both red transcripts committed as `evidence/e4-t02-sensitivity.md`.
- [ ] Replay (browser layer): a Replay recording showing the E3-T04 repo list gaining
      the new repo after init (live or on load, with the DOM-exposed registry offset
      at or past the creation event), zero console errors, cited by URL in the
      Verification log — or the loud `Replay: N/A (<reason>) + mitigation` fallback
      per AGENTS.md.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0, and `make verify-E4-T01` re-runs green (the
      shared walker gained a second caller; E4-T01's parity must not have moved).

## Adversarial verification

The claim under attack: "what `ef init` put on the stream **is** the directory — same
digest, nothing extra, nothing missing — and without a valid credential it puts
*nothing* anywhere." Use your own directories, org names, and tokens throughout; invent
at least one angle not listed.

1. **Adversarial trees, your fixtures not theirs.** Init directories the builder's
   fixture didn't dare include: a file named `.ef` (file, not directory — must upload;
   only the `.ef/` workspace directory is excluded, per E4-T01's frozen rules —
   whichever behavior E4-T01 froze, digest and upload must agree on it), deeply nested
   paths, filenames with spaces/unicode/newline-adjacent characters, a 0-byte file, a
   multi-megabyte binary, hundreds of small files, an empty directory (E4-T01's rules
   decide representation — digest parity must hold either way). For every tree:
   `ef tree-digest .` before, `ef replay --worktree-digest` of the dump after. One
   unequal pair
   refutes the task. If the CLI crashes on a legal filename, that is a finding.
2. **The exclusion differential.** Put content inside `.ef/` *before* watching init
   finish? You can't — so instead: pre-create a decoy `.ef/`-lookalike (`.ef2/`,
   `x/.ef/`), run init, and check the dump — E4-T01's exclusion rules are the oracle;
   any divergence between what `ef tree-digest` counts and what the upload shipped
   refutes the one-walker claim. Then grep every event for the real `.ef/` paths after
   a successful init: one hit refutes hygiene.
3. **Tokenless and forged-token totality.** Run init with: no `$EF_HOME`, an empty
   credentials file, a truncated token, a well-formed token whose grant was revoked
   mid-run (revoke between the project dispatch and the repo dispatch if you can time
   it — any events that landed before revocation are honest history, but everything
   after the revoke event must be 401 and the run must exit nonzero with no `.ef/`).
   For every failure mode: dump `ns:org:<org>`, `__registry__`, and enumerate `fs:*`
   streams before and after — for the fully-refused runs, one new event, one new
   stream, or one changed digest refutes log-neutrality. Confirm the no-credentials
   refusal sends zero requests by pointing `EF_SERVER_URL` at a closed port: a
   connection error instead of the pinned local exit code refutes the local-refusal
   claim.
4. **Verify-gate sabotage.** In a scratch worktree: (a) make the tree-upload engine
   silently skip files over some size, (b) make init write `.ef/` before fetching the
   server digest, (c) make the digest comparison case-insensitive or
   whitespace-tolerant. Run `make verify-E4-T02` and the suite after each; any
   mutation that stays green refutes the measuring apparatus for that path. Re-run the
   builder's committed sensitivity proofs yourself — a sensitivity transcript that
   doesn't reproduce is itself a finding.
5. **Partial-failure honesty.** Kill the server (or the process) mid-upload. The exit
   must be nonzero and no `.ef/` may exist. Then rerun: the name collision must be the
   typed `ns/name-taken`, not a crash, not a silent adopt of the half-uploaded stream.
   A rerun that writes `.ef/` checkpointed against a stream whose replay digest does
   not equal the local tree digest refutes the core equation.
6. **Registry and browser cross-check.** After your own init, hit `GET /registry/me`
   as the initiating identity and as a *different* identity (for a private repo, the
   other identity must not see it — E2-T08's filter, not init's job, but init passing
   `visibility` wrong would surface here). Open the E3-T04 repo list and interrogate
   the cited Replay recording: the new repo row, the registry offset in the DOM at or
   past the creation event, zero console errors. A recording that doesn't contain the
   claimed appearance fails the claim immediately.
7. **Cold-clone + golden replay yourself.** Run everything through
   `tools/verify/cold_clone.sh`. Replay the golden log independently in two processes;
   `ef bisect` any divergence to its offset. Then regenerate the whole transcript with
   a different emulator seed and a different repo name: ids and hashes may differ, but
   the digest equation, the event sequence shape, and every typed refusal must hold —
   a transcript that only passes under the builder's exact seed refutes
   determinism-by-design.

Refutation currency: a digest pair that should be equal and isn't, an offset where a
tokenless run appended, a `.ef/` path found in a dumped event, a stream that exists
after a fully-refused run, or an exit 0 over a mismatched tree. "The upload was slow"
is a note, not a finding.

## Verification log
