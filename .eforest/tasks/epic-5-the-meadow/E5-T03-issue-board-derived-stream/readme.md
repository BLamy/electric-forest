---
id: E5-T03
epic: 5
title: "Labels and the issue board as a derived stream: reducer-materialized, rebuilt from replay, losing it loses nothing"
priority: 503
status: pending
depends_on: [E5-T01]
estimate: M
capstone: false
---

## Goal

The repo's **label catalog** and its **issue board** exist as pure reductions with no
storage of their own. Labels are a per-repo label stream (reducer kind `repo-labels`,
registered in the server's reducer registry with a version and loadable standalone by
`ef replay --reducer`) whose frozen events — `label.created { labelId, name, color }`,
`label.renamed { labelId, name }`, `label.recolored { labelId, color }` — reduce to the
catalog keyed by `labelId`; issues carry label membership by `labelId` via the
`issue.labeled` / `issue.unlabeled` events of the E5-T01 envelope (if E5-T01's frozen
envelope did not include them, this task adds them under that envelope's documented
extension/versioning rule — never by silently mutating a frozen shape). The **issue
board** is a named reducer-materialized view (`BOARD_REDUCER = "issue-board@1"` in
`packages/issues`, named in code and in the package readme's list-view registry per
ROADMAP.md bet 4): a pure function `deriveBoard(labelLog, issueLogs)` folding the repo's
label stream and the full set of its per-issue event streams into one canonical board
state — one column per workflow state (`open` / `in-progress` / `done` / `closed` /
`wont-do`), each with an exact `count` and its member issue ids sorted ascending by UTF-8
byte order, plus the resolved label catalog and per-label membership so
`filterBoard(board, labelId)` is a deterministic pure function. The board state's
canonical-JSON shape is **frozen here** (`BOARD_VIEW_VERSION = 1`); its digest is SHA-256
over the `@eforest/protocol` canonical encoding, so "same logs ⇒ same board" is a
byte-equality claim. The server maintains the board incrementally (updated on dispatch,
served as canonical JSON + digest from `GET /repos/:repoId/board`) but the materialized
copy is disposable by construction: `make verify-E5-T03` **destroys it and rebuilds it
purely by replay of the streams, to a byte-identical digest**. The board is additionally
a pure function of the *set* of input logs — folding the issue streams in any order, or
replaying interleaved arrivals in any interleaving consistent with each stream's own
offsets, produces the identical digest. No database, no side table, no index that cannot
be deleted: losing the view loses nothing (bet 4).

## Context

Epic 5 rebuilds the GitHub surface as pure event streams (ROADMAP.md, "Epic 5 —
the-meadow" and "One model to hold them all"): issues are per-issue event streams whose
workflow state is reduced state, and "the issue board is a derived stream over the repo's
issues." Bet 4 is explicit: anything that looks like a query index is a derived stream or
reducer-materialized view, rebuildable from the logs by replay, and **every list view
names the derived stream or reducer it reads**. This task is where that bet is first
cashed for the meadow: E5-T01 froze the issue event envelope and the validated workflow
reducer registered with `ef replay`; this task adds the label vocabulary and proves the
first cross-stream derived view. E5-T04 (the browser write path) proves its dispatch
hook live on this task's label events; E5-T05 (issues in the web app) renders exactly
this board and must name `issue-board@1` as the reducer it reads; E5-T07's exactly-once
issue-close and the E5-T13 capstone's live board both stand on the rebuild-equals-live
property proven here. This is a stream-layer task: no browser surface changes (browser
dispatch is E5-T04, the web app board is E5-T05), so the Replay browser layer is
declared N/A with stream-layer evidence as the currency, per AGENTS.md.

Contracts frozen here, documented verbatim in the `packages/issues` readme with the
invalidation rule (any field addition/removal/rename or semantic change bumps the
version and regenerates every dependent golden — a loud, deliberate event):

- **Label events** (`LABEL_EVENT_VERSION = 1`), on the repo's label stream, validated at
  dispatch: `label.created` refuses a duplicate `labelId` or duplicate live `name`;
  `label.renamed` / `label.recolored` refuse an unknown `labelId`; a log containing an
  event dispatch-validation would refuse is corrupt and `ef replay` exits nonzero on it.
  `name` comparison is exact byte equality (no case folding, no unicode normalization —
  documented). Labels are identified everywhere by `labelId`; `name` and `color` are
  display attributes a rename/recolor rewrites in the catalog without touching any
  issue's membership.
- **Board view** (`BOARD_VIEW_VERSION = 1`), canonical JSON, sorted keys:

  ```json
  {
    "v": 1,
    "reducer": "issue-board@1",
    "columns": {
      "open":        { "count": 0, "issues": [] },
      "in-progress": { "count": 0, "issues": [] },
      "done":        { "count": 0, "issues": [] },
      "closed":      { "count": 0, "issues": [] },
      "wont-do":     { "count": 0, "issues": [] }
    },
    "labels": { "<labelId>": { "name": "…", "color": "…", "issues": [] } }
  }
  ```

  All five columns always present (empty ones included); every `issues` array is issue
  ids sorted ascending by UTF-8 byte order (ids per E5-T01's scheme); `count` always
  equals `issues.length` (redundant by design — a mismatch is self-evident corruption);
  an issue appears in exactly one column (its E5-T01 reduced workflow state); `labels`
  keys sorted, each label's `issues` array listing current members regardless of column.
  `filterBoard(board, labelId)` returns the same shape restricted to that label's
  members, exact per-column counts recomputed; unknown `labelId` is an error, never an
  empty board. Board digest = SHA-256 over the canonical encoding. The provenance of a
  materialized copy (input stream ids + the exact offsets consumed) is recorded
  alongside it and returned by the endpoint — a board that cannot say which offsets it
  reflects is unfalsifiable and therefore wrong.

Non-goals: dispatching from the browser (E5-T04), rendering the board (E5-T05), label
deletion/archival (not in v1 — documented), PR streams (E5-T02), cross-entity closing
(E5-T07), pagination or search, and any persistence beyond the disposable materialized
copy whose loss this task proves harmless. Human-friendly sequential issue numbering —
which E5-T01 explicitly defers to this task — is resolved here as **not part of
`BOARD_VIEW_VERSION = 1`**: the board keys issues by their opaque E5-T01 ids; a
numbering view, if ever wanted, is a separate registered derived view, and the
`packages/issues` readme states this disposition so the deferral does not dangle.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T03-issue-board-derived-stream/`. Makefile recipes
reference them repo-root-anchored (e.g. via `$(CURDIR)`).

- `packages/issues/src/labelReducer.ts` — pure reducer (no I/O, `Date`, `Math.random`,
  env) for the repo label stream, conforming to the `@eforest/protocol` reducer
  signature; registered in the server reducer registry as `repo-labels` with an explicit
  version; dispatch-side validation for the refusal cases in Context; a standalone built
  reducer module (path documented in the package readme) loadable by
  `ef replay <dump> --digest --reducer <path>`.
- `issue.labeled` / `issue.unlabeled` handling in the E5-T01 issue reducer per that
  envelope's extension rule (or a cited pointer to where E5-T01 already froze them),
  with dispatch validation refusing an unknown `labelId` against the repo's label
  catalog and refusing double-label / unlabel-of-absent.
- `packages/issues/src/board.ts` — `deriveBoard(labelLog, issueLogs)` and
  `filterBoard(board, labelId)`: pure, deterministic, fold-order-independent;
  `BOARD_REDUCER = "issue-board@1"` and `BOARD_VIEW_VERSION = 1` exported; the frozen
  shape, ordering rules, provenance record, and invalidation rule documented in the
  package readme, and `issue-board@1` entered in the list-view registry the readme keeps
  (the bet-4 ledger every later list view joins).
- Server: incremental board maintenance on dispatch (label and issue events) and
  `GET /repos/:repoId/board` returning `{ board, digest, provenance }` as one canonical
  JSON body; the materialized copy lives in a documented, deletable location (file or
  in-memory + snapshot) and the server rebuilds by replay when it is absent or fails its
  own digest check — never trusts a copy it cannot re-derive.
- `evidence/golden-board/script.ts` — committed, deterministic seed: from a fresh server
  data dir, create a repo, create ≥ 3 labels, rename one and recolor one, open ≥ 7
  issues spread across ≥ 4 workflow states via E5-T01 events, label/unlabel several
  (including labeling with a since-renamed label), dump all input logs to
  `evidence/golden-board/logs/`, and record the board digest.
- `evidence/golden-board/board.digest` and `evidence/golden-board/board.json` — the
  frozen golden board state and digest for the seed; plus
  `evidence/golden-board/after-state-change.digest` — the second golden after exactly
  one further `issue.state-changed` dispatch, with the offset it landed at recorded in
  `evidence/golden-board/live-update.txt` (the live-update transcript: pre-digest,
  dispatched event, cited stream + offset, post-digest).
- `Makefile`: `verify-E5-T03` in the marker section composing the frozen helper recipes
  (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus, against a fresh server data
  dir: (a) run the seed script, assert the endpoint's board and digest are byte-equal
  to the committed goldens; (b) **destroy-and-rebuild** — delete the materialized view
  out from under the running server, hit the endpoint again, assert the rebuilt digest
  is byte-identical and provenance offsets equal the stream heads, print
  `REBUILD digest=<d> identical OK`; (c) **live update** — dispatch exactly one
  `issue.state-changed`, assert the digest moves to `after-state-change.digest` and the
  transcript's cited offset matches the server's head for that issue stream, print
  `LIVE offset=<o> digest=<d> OK`; (d) **fold-order permutation** — rebuild via
  `deriveBoard` over the dumped logs in ≥ 3 distinct stream orderings, all digests
  byte-identical. Joins `verify-all`; `tools/verify/self_check.sh` still passes.
- Tests in `packages/issues/test/`: unit — label reducer (every event, every refusal,
  rename/recolor leaving membership intact, byte-exact name uniqueness), `deriveBoard`
  (empty repo = all-empty five-column board, one issue per state, UTF-8 ordering with
  ids that collate differently under locale, count==length, exactly-one-column,
  `filterBoard` counts and unknown-label error), fold-order independence
  (property-style: random event sets, shuffled fold orders, equal digests);
  integration — against a real `packages/server` on an ephemeral port: incremental
  digest equals cold `deriveBoard` digest after every event of a scripted ≥ 50-event
  mixed sequence, endpoint canonical-JSON purity, rebuild-after-deletion, rebuild after
  the materialized copy is corrupted in place (garbage bytes ⇒ rebuilt from logs, not
  served), and label-stream `ef replay --digest --reducer` determinism (two separate
  process invocations, identical digests).

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E5-T03` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E5-T03 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Golden board: running `evidence/golden-board/script.ts` against a fresh server
      data dir yields a `GET /repos/:repoId/board` body whose board and digest are
      byte-identical to the committed `board.json` / `board.digest` — evidence: the
      in-target comparison plus the committed goldens and input logs under
      `evidence/golden-board/logs/`.
- [ ] Destroy-and-rebuild: deleting the materialized view under the running server and
      re-requesting the board yields a byte-identical digest with provenance offsets
      equal to the independently probed stream heads — evidence:
      `make verify-E5-T03 2>&1 | grep -c '^REBUILD digest=.* identical OK$'` ≥ 1, plus
      the committed corruption-rebuild integration test.
- [ ] Live update at a cited offset: exactly one `issue.state-changed` dispatch moves
      the board digest from `board.digest` to `after-state-change.digest`, and
      `evidence/golden-board/live-update.txt` cites the stream id and offset the event
      landed at, matching the server head — evidence:
      `make verify-E5-T03 2>&1 | grep -c '^LIVE offset=.* digest=.* OK$'` ≥ 1, plus the
      committed transcript.
- [ ] Fold-order independence: `deriveBoard` over the dumped logs in ≥ 3 distinct stream
      orderings produces byte-identical digests, and the property-style shuffled-fold
      unit test is green — evidence: the in-target check plus the committed test.
- [ ] Incremental-equals-cold: the committed integration test drives a scripted
      ≥ 50-event mixed label/issue sequence and asserts, after **every** event, that the
      server's incremental digest equals a cold `deriveBoard` over freshly dumped logs —
      evidence: the test, green under `pnpm test`.
- [ ] Rename/recolor semantics: renaming and recoloring a label changes the catalog
      entry and the board digest without changing any column's or label's `issues`
      membership arrays, and `filterBoard` by the renamed label's `labelId` returns the
      same members before and after — evidence: committed unit test plus the golden seed
      (which includes a rename and a recolor).
- [ ] Label-stream replay determinism: `ef replay <label log> --digest --reducer
      <documented path>` twice in separate processes prints identical digests, and a log
      containing a dispatch-refusable event (duplicate `labelId`, rename of unknown
      label) makes `ef replay` exit nonzero — evidence: committed tests.
- [ ] The reducer is named: `BOARD_REDUCER = "issue-board@1"` is exported, appears in
      the endpoint's response (`reducer` field), and is documented in the package
      readme's list-view registry with the frozen `BOARD_VIEW_VERSION = 1` shape,
      ordering rules, and invalidation rule — evidence: the committed files.
- [ ] No database: the diff introduces no relational store, no embedded DB, and no
      persisted state outside the streams except the documented disposable materialized
      copy — evidence: the destroy-and-rebuild target above plus critic inspection
      (angle 6).
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E5-T03` to this task; `verify-all` (all earlier
      targets) still green.
- [ ] Replay browser layer: N/A (stream/server surface only; browser dispatch is
      E5-T04 and the browser board is E5-T05) — the Verification log entry must declare
      this explicitly per AGENTS.md; stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that the board is a pure, disposable reduction of the
streams. Bet 4 rides on this task — if any answer the board gives cannot be re-derived
from the logs alone, the epic's "no database" claim is already dead. Use your own repos,
labels, issues, and event sequences, never the builder's seed. Any single success
refutes.

1. **Cache poisoning (mandatory).** Build your own repo and snapshot the board digest.
   Then attack the materialized copy directly: (a) delete it — the re-served digest must
   be byte-identical; (b) overwrite it with a *well-formed but wrong* board (valid
   canonical JSON, plausible counts, wrong membership) — if the endpoint ever serves
   your poison, the server trusts the cache over the logs and bet 4 is refuted; (c)
   truncate it mid-byte and kill/restart the server — a crash without rebuild, or a
   served board that fails your own `deriveBoard` cross-check, refutes. At every step
   re-derive the digest yourself from dumped logs via `deriveBoard`; disagreement
   between the endpoint's mouth and the pure function refutes the apparatus.
2. **Incremental drift.** Fuzz a long sequence (≥ 200 events: creates, renames,
   recolors, opens, label/unlabel, state changes across all five states, in randomized
   but dispatch-valid order) and after every K events compare the incremental endpoint
   digest to a cold `deriveBoard` over fresh dumps. Any divergence at any prefix
   refutes — the incremental path is only legitimate as an optimization of replay.
3. **Fold-order and interleaving.** Take your fuzzed repo's dumped logs and fold them in
   adversarial orders: reverse stream order, label stream last, one issue stream split
   and interleaved event-by-event with another (each stream's own offsets preserved).
   Any digest difference refutes fold-order independence. Also probe the ordering trap:
   create issue ids and label names that collate differently under locale vs UTF-8 bytes
   (`a`, `B`, `ä`) and run under `TZ=Pacific/Kiritimati LANG=C` vs defaults — any
   environment-dependent byte in board JSON refutes.
4. **Rename/recolor laundering.** Apply a label to issues, rename it, then: filter by
   the old name anywhere the API admits a name (it shouldn't — id-only), check
   membership survived byte-identically, recolor and confirm only the catalog entry
   moved. Then attack validation: dispatch `label.created` with a duplicate live name
   (byte-equal) and with a case-variant name (must be *accepted* — uniqueness is
   byte-exact and documented; refusal here means undocumented folding), rename to a
   colliding name, label an issue with an unknown `labelId`, double-label, unlabel an
   absent label. Any refusal case that appends, or any accepted event `ef replay` later
   chokes on, refutes the validation story.
5. **Sabotage the gates.** In a scratch worktree: (a) make `count` read
   `issues.length - 0` but membership drop one issue — goldens and the
   incremental-equals-cold test must go red; (b) swap the column sort to locale
   collation; (c) make the rebuild path read the surviving cache file; (d) delete
   `board.digest` and run `make verify-E5-T03` — it must fail red, never
   regenerate-and-pass (inspect the recipe and git history for regeneration laundering).
   Any sabotage that stays green refutes whichever gate it slipped past. Check the diff
   for `.skip` / `.todo` / inline lint disables while there.
6. **The hidden database.** Read the diff and the running data dir: any sqlite/level/
   lmdb/indexeddb import, any persisted file besides the streams and the one documented
   materialized copy, any query the endpoint answers that you cannot reproduce from
   `deriveBoard` over dumps, refutes bet 4. Confirm the naming discipline: the endpoint
   response says `issue-board@1`, the readme's list-view registry lists it, and the
   exported constant matches — an unnamed or mismatched reducer name refutes the
   documented contract even if the bytes are right.
7. **Live-update honesty.** Dispatch your own single `issue.state-changed` and verify
   the digest transition lands exactly at the offset the server head reports — then
   dispatch an `issue.commented` (board-irrelevant per the frozen shape) and confirm the
   board digest does **not** move. A digest that moves on board-irrelevant events, or a
   cited offset that doesn't match the head you probe via `GET /events`, refutes the
   transcript's evidentiary value.
8. **Cold clone.** Run everything only via `tools/verify/cold_clone.sh` with
   `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*` scrubbed. "Works on the builder's machine"
   is a refutation.
9. **Coverage.** Hold the claimed final run against the diff: label reducer refusals,
   both rebuild triggers (absent and corrupt), `filterBoard`, the extension of the
   E5-T01 reducer, and the provenance record must each have been executed by a committed
   test or cited transcript. Unexecuted diff is unproven or dead — builder picks which,
   you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your poisoned-cache case, your fuzz sequence (as a seeded fixture),
and any collation or validation input that found interesting surface into the test
corpus.

## Verification log
