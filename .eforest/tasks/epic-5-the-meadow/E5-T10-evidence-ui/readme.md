---
id: E5-T10
epic: 5
title: "Evidence rendered in the UI: attachments appear live wherever their owning entity does, hashes shown and matching, links resolving"
priority: 510
status: pending
depends_on: [E5-T08, E5-T09]
estimate: M
capstone: false
---

## Goal

Evidence is **visible where its entity is**. The shell (`packages/webapp`,
`@eforest/webapp`) gains an attachment region rendered on both entity detail pages —
the E5-T04 issue detail at `/orgs/:org/repos/:repo/issues/:issueId` and the E5-T08 PR
detail at its frozen route — reading exclusively through E3-T03's `useServerReducer`
over the owning entity's stream folded by E5-T09's registered attachment reducer, with
the region carrying the E3-T02 DOM contract attributes (stream, replayed offset, state
digest) plus the reducer id per the E5-T04 names-its-source convention. Both frozen
E5-T09 attachment kinds render: a **content-stream attachment** (event-log dump,
digest file, rr trace) shows its filename, byte size, and the SHA-256 recorded in its
E5-T09 attachment event — displayed in the DOM (`data-testid="attachment-sha256"`) and
**verified**, the UI recomputing the hash over the bytes it fetched from the content
stream and flagging any mismatch loudly (`data-ef-hash-verified="true|false"`, a
mismatch rendering a visible integrity error, never a silent green) — viewable inline
for text kinds and downloadable byte-exactly; an **external Replay run reference**
renders as an anchor whose `href` string-equals the reference event's recorded URL
verbatim (opaque echo, per E0-T03 discipline — never parsed, never rewritten) and
resolves when followed. Attaching evidence from the browser is one event through the
one door: an upload control on both pages streams the file's bytes onto a new E5-T09
content stream and appends the attachment event to the owning entity via E5-T04's
`useDispatch` — no other write path, no blob store, no optimistic render (the
attachment appears only when the tail replays its event, per the E5-T04 reconciliation
contract). Headline proof, inside `make verify-E5-T10`: session A holds an issue and a
PR page open; session B attaches a content-stream log dump and a Replay reference to
each; every attachment appears in A without reload within the frozen 2000 ms live
budget with its DOM-shown SHA-256 string-equal to the committed golden; the same file
downloaded through A's UI is byte-identical to B's source; and `ef replay --digest`
over the downloaded event-log attachment reproduces exactly the digest its attachment
event claims.

## Context

ROADMAP.md, "Epic 5 — the-meadow" and "One model to hold them all": evidence — rr
traces, Replay browser-run references, event-log dumps, digests — "render in the UI
wherever their entity does." E5-T09 froze the model (content streams for bytes,
reference events for external Replay runs, attachment events on the owning entity's
stream, recorded SHA-256 digests); this task makes it visible and writable from the
browser. It is the last UI surface before the E5-T12 capstone and the surface Epic 6
leans on hardest: the loop's builder/critic evidence (E6) renders through exactly
these components, so an attachment list that can show a hash the bytes don't have —
or hide an attachment the log contains — poisons the platform's entire evidence
story. The doctrine's own currency (AGENTS.md: "here is the session where it worked
... interrogate it") is only honest in the product if the rendered hash provably
belongs to the rendered bytes.

Builds on: **E5-T09** (the frozen attachment event model, content-stream layout,
recorded-digest field, and the registered attachment reducer — this task renders that
reduced state and adds zero attachment-derivation logic; any attachment row the
reducer's fold can't account for is a finding against whichever side diverged),
**E5-T08** (the PR detail page and route this task extends), **E5-T04** (`useDispatch`
and the no-optimistic-apply reconciliation contract every browser write inherits),
**E5-T01/E5-T02** (the issue and PR streams attachments hang off), **E3-T03/E3-T02**
(hooks, DOM attribute contract, Playwright harness), **E0-T03** (SHA-256 digests,
offset opacity).

Contract frozen here: the attachment region's DOM shape — the region attributes above
plus per-attachment `data-testid="attachment-row"`, `data-testid="attachment-sha256"`
(the recorded hash, lowercase hex, verbatim), `data-ef-hash-verified`, and for
references `data-testid="attachment-link"` with the verbatim `href`. Downstream tasks
(E5-T12, Epic 6's task board) assert against these test ids; changing them later
invalidates those suites.

Non-goals: no changes to the E5-T09 model (any gap found in it is a queue-jumping
finding against E5-T09, not a patch here), no new server endpoints beyond what E5-T09
landed, no rich rendering of trace contents (rr traces list and download; they do not
open), no attachment deletion/editing UI, no wiki or board attachment surfaces
(entities beyond issue and PR render attachments when their pages exist), no
paginated attachment lists, and no proxying or validation of external Replay URLs
server-side — the reference is opaque and rendered verbatim, sanitized only by the
scheme allowlist below.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T10-evidence-ui/`.

- `packages/webapp/src/evidence/AttachmentList.tsx` — the one attachment region,
  mounted on both detail pages: rows for both kinds, recorded SHA-256 shown verbatim,
  client-side recomputation over the fetched content-stream bytes (Web Crypto
  `crypto.subtle.digest("SHA-256", …)`) setting `data-ef-hash-verified` and rendering
  the integrity error state on mismatch, inline text viewer, byte-exact download,
  reference anchors with an `https:` scheme allowlist (any other scheme renders as
  inert text plus a visible warning, never a live link, never a crash).
- `packages/webapp/src/evidence/AttachmentUpload.tsx` — the upload control on both
  pages: reads the file, computes its SHA-256 in the browser, streams the bytes onto
  a fresh E5-T09 content stream and dispatches the attachment event through
  `useDispatch`, pending until reconciled per E5-T04; plus a "attach Replay run" form
  dispatching a reference event with a URL field.
- `packages/webapp/src/evidence/useAttachments.ts` — the one thin binding of
  `useServerReducer` + `useDispatch` to the owning entity's stream and the imported
  E5-T09 attachment reducer; no other webapp module touches attachment data, bytes,
  or hashing.
- Wiring diffs in `packages/webapp/src/routes/IssueDetail.tsx` and the E5-T08 PR
  detail route mounting the region — mount-only; entity pages gain no attachment
  logic of their own.
- `packages/webapp/test/evidence.spec.ts` — the Playwright suite (E3-T02 harness):
  upload a fixture log dump and attach a Replay reference on an issue and on a PR
  through real pointer/keyboard events; two-context live sync (B attaches, A renders
  each within 2000 ms, zero reloads asserted); DOM-shown SHA-256 string-equal to the
  committed golden hash and `data-ef-hash-verified="true"`; download intercepted and
  byte-compared to the source fixture; reference `href` byte-equal to the dispatched
  URL; a `javascript:` reference rendered inert; write-path audit from the captured
  network log (every mutation through the one door, zero non-dispatch state writes);
  zero console errors throughout.
- `packages/webapp/fixtures/evidence/` — the committed upload fixtures: a real
  event-log dump (`golden-run.events.jsonl`, itself replayable by `ef replay`), a
  small binary blob, and `expected.json` pinning each fixture's SHA-256 (lowercase
  hex) and the log dump's replay digest — frozen committed artifacts, never computed
  at test time.
- `Makefile`: `verify-E5-T10` per the E0-T02 target contract — fresh server + data
  dir, seed an issue and a merged-lineage PR, build, Playwright (final pass under
  `tools/replay/record-run.sh -o e5-t10-final`), then the verdict phase:
  `HASH kind=content shown=<h> golden=<h> OK` (string-compare DOM hash vs
  `expected.json`), `BYTES kind=content downloaded=<h> source=<h> OK` (byte parity of
  the UI download), `REPLAY-PARITY digest=<d> claimed=<d> OK` (`ef replay --digest`
  over the downloaded log vs the attachment event's claimed digest),
  `LINK href=verbatim OK`, `LIVE budget=2000ms OK`, plus the sensitivity legs below,
  each greppable; nonzero exit naming the failing comparison on any mismatch.
- `evidence/` — `e5-t10-digests.txt` (DOM-shown hashes vs goldens vs recomputed, both
  entities, both sessions), `e5-t10-byte-parity.txt` (source vs downloaded hashes plus
  the `ef replay` parity line), `e5-t10-write-audit.txt` (per-mutation network
  accounting), `e5-t10-session.events.jsonl` (dumped owning-entity logs from the run),
  `e5-t10-hostile-link.txt` (the `javascript:` reference rendered inert, transcript),
  and `e5-t10-sensitivity.md`. The Replay recording is cited by URL in the
  Verification log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T10` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env, zero `SKIPPED:` lines, all
      state created in-run — evidence:
      `make verify-E5-T10 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Rendered where the entity is, from the one fold.** The attachment region
      renders on both the issue detail and the PR detail, its DOM attributes name the
      owning entity's stream, replayed offset, state digest, and the E5-T09 attachment
      reducer id, and the rendered rows literal-equal the reduced attachment state at
      the region's published offset (asserted from hook state, not a screenshot) —
      committed Playwright assertions, `pnpm test` exit 0.
- [ ] **Hash shown and matching.** For each uploaded content-stream fixture, on both
      entities and in both sessions: the DOM-shown SHA-256 string-equals the committed
      golden in `fixtures/evidence/expected.json`, string-equals the digest recorded
      in the attachment event in the dumped log, and `data-ef-hash-verified="true"`
      (client recomputation over the fetched bytes agrees) — evidence:
      `make verify-E5-T10 2>&1 | grep -c '^HASH kind=content .* OK$'` prints ≥ `2`,
      all values in `evidence/e5-t10-digests.txt`.
- [ ] **Byte parity through the UI, and the log replays.** The event-log attachment
      downloaded through session A's UI is byte-identical to the committed source
      fixture (hashes compared), and `ef replay --digest` over the downloaded file
      reproduces exactly the digest its attachment event claims — evidence:
      `grep -c '^BYTES kind=content .* OK$'` and
      `grep -c '^REPLAY-PARITY .* OK$'` each print ≥ `1` on the transcript,
      committed in `evidence/e5-t10-byte-parity.txt`.
- [ ] **References resolve, verbatim.** The Replay reference row's anchor `href`
      byte-equals the URL in the dispatched reference event (dumped log compared),
      following it resolves (HTTP 200 against the harness-controlled target used in
      the hermetic run; the real `app.replay.io` URL exercised in the recorded
      walkthrough), and a dispatched reference carrying a `javascript:` or `data:`
      URL renders as inert text with a visible warning — no live anchor, no
      navigation, no console error — evidence: `LINK href=verbatim OK` in the
      transcript, `evidence/e5-t10-hostile-link.txt`.
- [ ] **One door, no echo.** The captured network log shows every attachment mutation
      as E5-T09 content-stream appends plus exactly one attachment/reference dispatch
      through the door, zero other state-writing requests and zero blob/storage APIs;
      the uploading session's row appears only at/after its tail replays the confirmed
      offset (E5-T04 counters: `dispatches-reconciled` equals `dispatches-confirmed`
      at quiesce) — accounting in `evidence/e5-t10-write-audit.txt`.
- [ ] **Live across two sessions.** Each of B's four attachments (content + reference,
      on issue + PR) renders in A within 2000 ms of dispatch-accept with zero
      reloads/re-navigations (navigation count asserted); after quiesce both sessions'
      region `(offset, digest)` pairs string-equal the server heads and
      `ef replay --digest` over `evidence/e5-t10-session.events.jsonl` — evidence:
      `LIVE budget=2000ms OK` in the transcript, values in `e5-t10-digests.txt`.
- [ ] **Zero console errors** and zero uncaught exceptions across the entire suite,
      including the integrity-mismatch and hostile-link paths — asserted by the
      Playwright harness, red on any console error.
- [ ] **Sensitivity inside `make verify-E5-T10`.** (a) Flip one byte of the content
      stream's stored bytes after upload (direct append/store manipulation in the
      harness) — `data-ef-hash-verified` must go `false` and the integrity error must
      render, red otherwise; (b) in a scratch worktree, make the UI display the
      recomputed hash instead of the recorded one — the golden string-compare must go
      red; (c) hardcode `data-ef-hash-verified="true"` — the byte-flip leg must go
      red; (d) drop one live frame in A's tail — the 2000 ms criterion goes red. Each
      prints `EXPECTED-FAIL OK` only after observing red —
      `grep -c 'EXPECTED-FAIL OK'` prints ≥ `4`; transcripts in
      `evidence/e5-t10-sensitivity.md`.
- [ ] Replay (browser layer): one recording
      (`tools/replay/record-run.sh -o e5-t10-final`) containing the upload, the
      hash-verified render, the download, the resolving reference link, and the
      second-session live appearance on both an issue and a PR, zero console errors
      anywhere in it; URL plus point/time anchors at (a) B's attachment dispatch
      confirming, (b) the row appearing in A with its hash, (c) the reference link
      resolving, cited in the Verification log; if `tools/replay/preflight.sh` fails,
      declared per AGENTS.md with the Playwright transcript + network/console
      interrogation standing in.
- [ ] No regression: `verify-E5-T04`, `verify-E5-T08`, the E5-T09 verify target, and
      all root gates (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
      && pnpm build`) re-run green on this tree; `make verify-list` shows
      `verify-E5-T10`.

## Adversarial verification

The claim under attack: "every hash the UI shows provably belongs to the bytes the UI
serves, every attachment row is a replay of the owning entity's log and nothing else,
references render verbatim and resolve, and all of it stays true live across
sessions." Use your own files, your own entities, your own sessions; invent at least
one angle this list lacks.

1. **Your bytes, your hash.** Ignore the builder's fixtures. Upload your own files —
   empty (0 bytes), a multi-megabyte binary, a file whose content is itself a valid
   attachment event, unicode and quote-laden filenames — compute each SHA-256
   yourself out-of-band, and compare against the DOM in both sessions and against
   the attachment event in your own dump of the owning stream. Any of the three
   values disagreeing refutes. Then download each through the UI and byte-diff
   against your source; a single differing byte refutes byte parity.
2. **Hash theater hunt.** The deadly failure mode: the UI computing the "recorded"
   hash from the bytes it fetched, making the comparison self-licking. Read the diff:
   the displayed value must come from the replayed attachment event, the verified
   flag from an independent recomputation. Then prove it dynamically — tamper the
   stored content-stream bytes underneath a committed attachment (your own byte, your
   own offset, not the harness's) and reload: the shown hash must still be the
   recorded one, `data-ef-hash-verified` must flip false, and the integrity error
   must render. A UI that shows a fresh hash matching the tampered bytes, or stays
   verified, refutes the entire integrity apparatus.
3. **Second-store hunt.** Grep the diff and the built bundle for blob/object-storage
   APIs, IndexedDB/localStorage of attachment bytes, or any state-writing request
   that isn't the door. Block `/dispatch` and the content-stream append route at the
   network layer: the upload must fail loudly with the region digest unmoved; an
   attachment that lands anyway found another door and refutes. Reload with the
   server killed: any attachment row rendered refutes "no side store".
4. **Reference forgery.** Dispatch your own reference events by raw authenticated
   POST: `javascript:alert(1)`, `data:text/html,…`, protocol-relative `//evil`,
   an `https:` URL with embedded HTML/quotes in it, a 10 kB URL, an empty string.
   Every render must be either a verbatim-`href` `https:` anchor or inert text with
   a warning — a live anchor with a non-allowlisted scheme, any script execution,
   any crash, or any console error refutes. Confirm the verbatim rule with a
   byte-diff of `href` against your dispatched payload: any normalization,
   truncation, or rewriting refutes opacity.
5. **The fold, not a cache.** In a scratch worktree, inject a sentinel field into the
   E5-T09 attachment reducer: every region digest (issue and PR, both sessions) must
   change and parity with the equally-mutated server must hold; any digest unchanged
   proves a second reduction path and refutes. Separately grep
   `packages/webapp/src/evidence/` for any event-folding, digest-recording, or
   attachment-shaping logic that isn't an import from the E5-T09 package.
6. **Live sync, adversarially.** Sever A's tail, attach from B (both kinds, both
   entities), reconnect: exactly-once, in order, digest-equal — bisect any
   divergence with `ef bisect`. Race two sessions uploading to the same entity
   simultaneously (≥10 trials): both attachments must land, both hashes correct,
   both sessions converging to the identical digest; a lost row, a duplicated row,
   or divergent digests refutes.
7. **Apparatus sensitivity, your own sabotage.** Re-run the committed legs, then add
   yours: swap two fixtures' golden hashes in a copy of `expected.json` — the HASH
   leg must go red; make the download handler serve the first N bytes only — the
   BYTES leg must go red; point the REPLAY-PARITY leg at a stale claimed digest —
   red. Any green run under sabotage refutes the measuring apparatus and every
   transcript this task committed.
8. **Cold clone + recording sufficiency.** `tools/verify/cold_clone.sh
   verify-E5-T10`, scrubbed env, twice back-to-back. Hold the cited Replay recording
   against the diff via the Replay MCP: the upload, the verified hash render, the
   download, the resolving link, the hostile-link inert render, and the two-session
   appearance must actually be in it — evaluate at points, pull the fetched content
   bytes from network events and match their hash against the claim. A recording
   missing a claimed scene fails sufficiency; a changed hunk no run executed is
   unproven or dead — the builder chooses which, you enforce it.

Refutation currency: a DOM hash the bytes contradict (both values quoted), a
downloaded file differing from its source at a named byte offset, a tampered stream
the UI still shows as verified, a reference `href` differing from its event payload,
an attachment row matching no truncation of the dumped log (offset-cited), divergent
two-session digests after quiesce, a sabotage run that stayed green, or a Replay
point link where the DOM contradicts the stream. "The attachment list looks right"
is not a finding. No refutation → promote your hostile-reference corpus and your
tamper-detection probe into the committed suite.

## Verification log

(appended over time by builders and critics)
