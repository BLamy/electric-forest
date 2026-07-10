---
id: E3-T07
epic: 3
title: "File viewer with patch-aware rendering: content reduced from the per-file stream, a second session's patch edit lands live in the open viewer"
priority: 307
status: pending
depends_on: [E3-T06]
estimate: L
capstone: false
---

## Goal

The web app (`apps/web`, the E3-T02 shell) serves a **blob route** —
`/:org/:repo/blob/:branch/:path*` — that renders a file's content by folding its
**per-file content stream** (`fs:<repo>:<branch>:file:<fileId>`, E1-T01's split-stream
layout) through the E3-T03 `useServerReducer` hook: hydrate from `GET /state` at an
offset, live-tail `/events`, and fold **the same content reducer module from
`@eforest/streamfs` that `ef replay --reducer` loads** — the one that applies E1-T01
full-content writes AND E1-T03 `fs.file.patch` events (`baseDigest` check, byte-level op
apply, `resultDigest` check, typed refusal on mismatch), with full-write fallback events
folding identically. There is no browser re-implementation of patch apply, hashing, or
path resolution. The path in the URL resolves to a `fileId` through the branch's
metadata stream (`fs:<repo>:<branch>:meta`) folded by the same `fsReducer` E3-T06
mounted — a renamed file keeps its content-stream identity and stays readable at its new
path only; a **tombstoned path renders a typed absence state** (a distinct, testable
"gone" element carrying the metadata region's offset/digest, never a spinner, never a
crash, never stale content). The viewer region exposes, per the E3-T02 frozen DOM
contract, `data-ef-stream` (the content stream id), `data-ef-offset` (the content-stream
offset it has replayed to), and `data-ef-digest` — the canonical content digest of the
reduced content state, byte-equal to what `ef replay <dump> --digest --reducer` prints
for the same content-stream dump folded to the same offset; per E3-T02, every sampled
offset/digest pair is a consistent snapshot. The headline behavior: with the viewer
open, a **second session** dispatches an edit through stream-fs `writeFile` that the
E1-T03 writer encodes as a patch event, and the open viewer converges **live — no
reload, no refetch-the-world**: rendered text updates, the DOM offset equals the patch's
append offset on the content stream, and the DOM digest equals `ef replay` at that
offset. This is the E3-T10 capstone's core behavior ("a second session edits the file
through stream-fs and the open viewer updates live"), proven here first. Zero console
errors across hydration, patch application, tombstone, and navigation.

## Context

This is the epic's centerpiece surface — the number E3-T01 (whose corpus carries a ≥3
patch chain on `docs/chapter-one.md` specifically to feed it), E3-T06 (whose file rows
link to this route), and E4-T12 (whose two-machine capstone keeps this viewer open as
its browser-layer instrument) already cite. It unblocks E3-T08 (the branch switcher
re-anchors this viewer across branch streams) and E3-T10 (org → repo → tree → **file**
with the live edit is the capstone demo; the live-patch convergence is de-risked here).
Downstream, E4's watcher and E7's keystroke-granular AI sessions ride the same patch
events — this task is the first proof that a browser can fold them live.

What this task **consumes as frozen** (it freezes nothing new itself):

- **E1-T03's patch contract**: `fs.file.patch` payload `{ path, baseDigest, ops,
  resultDigest }`, the byte-level op grammar, the refusal taxonomy (mismatched
  `baseDigest` / malformed ops / `resultDigest` mismatch → typed refusal, log
  untouched), and the writer's patch-vs-full-write fallback rule. The viewer folds
  whatever the log contains; it never gets to choose or normalize.
- **E1-T01's split-stream layout and content digest**: per-file content streams
  `fs:<repo>:<branch>:file:<fileId>`, content digest = lowercase-hex SHA-256 of the
  UTF-8 content bytes, and the canonical state digest `ef replay --digest --reducer`
  prints for a content-stream dump. **The apply-and-verify path must be the shipped
  `@eforest/streamfs` module** — a reducer in the page that trusts `resultDigest`
  without applying `ops` violates E1-T03's "reducer output is checked, not trusted".
- **E3-T02's DOM exposure contract**: the viewer region registers under region id
  `viewer` with the `data-ef-stream` / `data-ef-offset` / `data-ef-digest` triple on
  its root element; harness and critics read offset and digest from those attributes
  and nowhere else.
- **E3-T03's hook contract**: `useServerReducer(streamId, reducer, { offset })`
  hydrate → tail → client-replay and its digest-parity guarantee. Parity failures here
  are triaged against T03, not papered over in the page.
- **E3-T06's meta reduction**: path → `fileId` resolution, rename re-keying, and
  tombstones come from the same `fsReducer` fold the tree uses (shared, not duplicated
  per route); the tree's file rows are this route's inbound links.
- **E3-T01's browse corpus**: `evidence/corpus-manifest.json` anchors — `patch_offsets`
  (the ≥3 patch events on `docs/chapter-one.md`), `tombstoned_path`,
  `renamed_from`/`renamed_to` — are this task's baseline fixtures, cited by manifest
  key, never regenerated.

Non-goals: syntax highlighting, binary/image rendering (a non-UTF-8 or NUL-bearing file
renders a typed "binary" placeholder that still carries the correct offset/digest triple
— content parity is asserted, pretty-printing is not), editing from the viewer (browsing
epic; edits arrive only from other clients), branch switching UI (E3-T08), history view
(E3-T09), merge/conflict rendering (E1-T09/T10 events on the meta stream must not crash
resolution but get no viewer UI).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-3-the-canopy/E3-T07-file-viewer-patch-aware/`.

- `apps/web/src/routes/blob/` — the blob route: resolves `:path*` to a `fileId` via the
  shared meta-stream reduction, mounts
  `useServerReducer(fs:<repo>:<branch>:file:<fileId>, contentReducer)` with the content
  reducer imported from `@eforest/streamfs`, renders the reduced content as text with
  the region triple on the root element. Distinct, testable elements for: tombstoned
  path (typed absence state), path that never existed (app 404), binary/non-UTF-8
  content (typed placeholder), unauthorized branch (the platform's refusal, never
  partial content).
- Rename fidelity: navigating to `renamed_to` renders the file with its pre-rename
  content history intact (same content stream id in `data-ef-stream`); `renamed_from`
  renders the absence/404 path per the reduced meta state.
- No second implementation: patch apply, SHA-256 hashing, path resolution, and digest
  computation reach the page **only** via `@eforest/streamfs` /`@eforest/protocol`
  imports. A committed check (script or test) scans **all of `apps/web/src`** — not just
  the route directory — for `createHash`, `sha256`, op-grammar handling
  (`"="`/`"+"`/`"-"` switch/case over patch ops), and reducer-shaped `switch` on `fs.`
  event types outside `@eforest/streamfs`/`@eforest/protocol`, and returns nothing.
  Stronger is better: if the build makes it practical, the check should scan the built
  client bundle (or the blob route's resolved import graph) instead of source globs, so
  that no directory placement inside `apps/web` can host a parallel implementation the
  check cannot see.
- Playwright spec `apps/web/e2e/blob.spec.ts` (headless, zero-console-error assertion
  wrapping every test):
  1. **Corpus hydration parity**: open the blob route on `docs/chapter-one.md` in the
     E3-T01 corpus (`maple/reading-room@main`), wait for quiescence, read the DOM
     offset `o` and digest `d`; dump the content stream, assert `d` byte-equal to
     `ef replay <dump> --digest --reducer` folded to `o`, `o` equal to the server head,
     and the rendered text equal to the corpus's final content.
  2. **Patch-chain step parity**: for each offset in the manifest's `patch_offsets`,
     mount the viewer hydrated at that offset (the hook's `{ offset }` parameter) and
     assert the DOM digest equals `ef replay` folded to exactly that prefix — three or
     more distinct intermediate contents, none equal to the final, proving the fold is
     event-by-event and not a head snapshot.
  3. **Live patch, no reload**: with the viewer open at head, a second client
     (Node-side `StreamFs` in the test) calls `writeFile` with an edit small enough
     that the E1-T03 writer emits `fs.file.patch` (the spec asserts the appended event
     is a patch, not a full write, by dumping the log); the open viewer's rendered text
     converges to the new content, the DOM offset equals the patch's append offset, the
     DOM digest equals `ef replay` at that offset, and no document navigation occurred.
     Then a second edit that trips the fallback rule (e.g. content replaced wholesale)
     lands as a full write and converges identically — both encodings fold live.
  4. **Tombstone and re-create**: second client deletes the open file — the viewer
     transitions to the typed absence state (no stale content, no crash); second client
     re-creates the path — the viewer renders the new content under a **fresh** content
     stream id in `data-ef-stream` (identity is not resurrected, per E1-T02 as
     surfaced by E3-T06).
- `evidence/e3-t07-content.jsonl` — the dumped content stream from the recorded final
  run, plus `evidence/e3-t07-digests.txt`: one `<offset> <digest>` line per checkpoint
  (hydration head, each `patch_offsets` prefix, the live patch's append offset, the
  post-fallback-write offset), every digest produced by `ef replay` (never by the web
  app) — the committed cross-reference the critic replays.
- Replay recording of the final run (`tools/replay/record-run.sh -o e3-t07-final`): one
  session showing hydration on the corpus file, the second session's patch landing live
  in the open viewer at its exact offset, the tombstone transition, and zero console
  errors — URL cited in the Verification log.
- `Makefile`: `verify-E3-T07` in the marker section — build the app, cold-start a fresh
  server, seed the E3-T01 corpus, run `apps/web/e2e/blob.spec.ts` headless, then a
  sensitivity step: rerun the hydration-parity assertion against a dump with one patch
  event's `ops` mutated (one inserted byte in an insert op) — the fold must go red
  (E1-T03's `resultDigest` check refusing, or the digest comparison failing). The step
  must **capture the observed failure and print it** — the typed refusal error, or the
  mismatched digest pair (`expected <digest> got <digest>`) — immediately before
  printing `MUTATION fixture=e3-t07 patched-ops digest-mismatch EXPECTED-FAIL OK`; a
  step that reaches the marker without a captured failure to print must itself exit
  non-zero (missing expected failure). Joins `verify-all`;
  `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env, fresh
      server data dir): `make verify-E3-T07` exits 0 with zero skips — evidence:
      `make verify-E3-T07 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Corpus hydration parity: on `docs/chapter-one.md`, the DOM digest at the DOM
      offset is byte-identical to `ef replay <dump> --digest --reducer` folded to the
      same offset, the DOM offset equals the server head at quiescence, and the
      rendered text equals the corpus's final content — evidence: the committed
      Playwright spec green, checkpoints in `evidence/e3-t07-digests.txt`.
- [ ] Patch-chain step parity: at every manifest `patch_offsets` prefix, the viewer
      hydrated at that offset shows a DOM digest byte-equal to `ef replay` at that
      exact prefix, with ≥3 distinct intermediate contents — evidence: committed spec
      assertions plus the same offsets in `evidence/e3-t07-digests.txt`.
- [ ] Live patch, no reload: a second session's `writeFile` that the E1-T03 writer
      encodes as `fs.file.patch` (spec-verified against the dumped log) lands in the
      open viewer — text converges, DOM offset equals the patch's append offset, DOM
      digest equals `ef replay` at that offset, zero document navigations — and a
      subsequent fallback full write converges identically — evidence: the Playwright
      spec green plus both checkpoints visible in the cited Replay recording.
- [ ] Tombstone semantics: deleting the open file flips the viewer to the typed
      absence state with no stale content rendered; re-creating the path renders new
      content under a fresh content stream id in `data-ef-stream` — evidence:
      committed spec assertions.
- [ ] Rename fidelity: the corpus's `renamed_to` path renders the moved file with its
      original content stream id; `renamed_from` renders absence/404 — evidence:
      committed spec assertions against manifest anchors.
- [ ] Binary/refusal edges: a non-UTF-8 file renders the typed placeholder with a
      correct offset/digest triple; an unauthorized branch renders the platform's
      refusal and no content bytes — evidence: committed spec assertions.
- [ ] No second implementation: patch apply / hashing / path resolution reach the
      route only via `@eforest/streamfs`/`@eforest/protocol` imports — evidence: the
      committed check green over **all of `apps/web/src`** (or, stronger, over the
      built client bundle / the route's resolved import graph), finding no op-grammar
      handling, hashing, or reducer-shaped `switch` on `fs.` event types outside
      those packages.
- [ ] Sensitivity: the `verify-E3-T07` mutated-ops step goes red before printing
      `EXPECTED-FAIL OK` — evidence: the `verify-E3-T07` output shows the **captured
      observed failure** (the typed refusal error or the mismatched digest pair)
      printed immediately before the `EXPECTED-FAIL OK` marker line; the marker alone
      is not evidence, and a run of the step against an unmutated dump exits non-zero
      with a missing-expected-failure error.
- [ ] Zero console errors across hydration, both live edits, tombstone, and
      navigation — evidence: the Playwright console assertion green AND the cited
      Replay recording showing an empty error console for the full session.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E3-T07` to this task; `verify-all` still green.
- [ ] Replay browser layer: **mandatory** (browser-reaching surface) — the
      Verification log cites the recording URL; `Replay: N/A` is not acceptable
      unless `tools/replay/preflight.sh` fails on the machine, in which case the loud
      fallback (Playwright + console/network interrogation) and the reason are logged
      per AGENTS.md.

## Adversarial verification

Your mission: refute the claim that the browser's viewer is the same fold as
`ef replay` over the per-file content stream — same patch apply, same digest, live.
Use your own repos, files, and edit sequences, never the builder's. Any single success
refutes.

1. **Digest parity, your own session (mandatory).** Ignore the corpus. Create your own
   repo, write a file, then drive an edit chain from a second client: small patches,
   a fallback full write, a patch after the full write, unicode content (astral-plane,
   combining marks), an edit that shrinks the file to empty and one that regrows it —
   viewer open the whole time. At three arbitrary quiescent points, read the DOM
   offset/digest pair, dump the content stream yourself, run `ef replay --digest
   --reducer` folded to that offset. Any byte of disagreement refutes. Any sampled
   pair where offset and digest belong to different fold points refutes the E3-T02
   consistency contract.
2. **Trusting-reducer probe.** E1-T03's cardinal sin is a reducer that copies
   `resultDigest` into state without applying `ops`. Forge it: dispatch (or splice
   into a dump for the offset-mounted parity path) a patch whose `ops` do **not**
   produce content hashing to its `resultDigest`, and a patch whose `baseDigest`
   mismatches the current content. The viewer must surface the same typed refusal
   behavior as `ef replay` (refused event, state unchanged, digests still matching
   `ef replay` on the same log) — a viewer that renders the forged `resultDigest`'s
   claim, or diverges from `ef replay`'s verdict in either direction, refutes.
3. **Second-implementation hunt.** Pull the JS bundle the session fetched (from the
   Replay recording's network events or the built `apps/web` output) and search for a
   parallel patch applier (`"="`/`"+"`/`"-"` op handling outside the shipped
   `@eforest/streamfs` module), any hashing outside `stateDigest`/the protocol digest,
   any ad-hoc path→fileId resolution. A re-implementation that agrees today refutes
   the architecture claim even with green digests. Run the builder's committed check,
   then try to defeat it: plant a trivially-renamed applier variant anywhere under
   `apps/web/src` (a helper in `apps/web/src/lib/`, not just the route directory) and
   import it from the route. If the committed check stays green, that refutes the
   no-second-implementation criterion — the check is that criterion's named evidence
   and must be widened until it catches the plant.
4. **Reload smuggling and snapshot fraud.** Interrogate the recording's network
   traffic across the live-edit phase: any document navigation, or a full `/state`
   re-hydration per edit (polling dressed as tailing), refutes "live". Then test that
   step parity isn't a head snapshot in disguise: mount the viewer at each of your own
   mid-chain offsets and diff the rendered text between consecutive prefixes — if two
   prefixes that `ef replay` distinguishes render identical content or identical DOM
   digests, the viewer is snapshotting, and that refutes patch-aware rendering
   wholesale.
5. **Tail partition.** Kill the tail mid-session (pause the server or drop the
   connection), dispatch two patches from the second client, resume. The viewer must
   catch up to head with digest parity intact, without a reload; a viewer rendering
   pre-partition content while its offset claims head — or vice versa — refutes offset
   honesty.
6. **Tombstone/rename identity surgery.** Delete the open file, then re-create the
   path with different content: hunt the DOM and `data-ef-stream` for the retired
   content-stream id (resurrection refutes). Rename the open file from the second
   client mid-view: whatever the builder chose (re-anchor or typed absence at the old
   path), stale content silently persisting at the old path as if current refutes.
   Rename onto a tombstoned path and open it: content and digest must match `ef
   replay`'s state, tombstone cleared.
7. **Encoding edges.** Feed the viewer files at the fallback boundary: content with a
   NUL byte (must take the binary placeholder path with correct triple), a file whose
   patch chain interleaves patches and full writes, CRLF vs LF bodies, a
   multi-kilobyte patch. For each, DOM digest vs `ef replay` at head; any divergence
   or console error refutes.
8. **Sabotage the suite.** In a scratch worktree, break the page four ways: (a) skip
   the `baseDigest` check client-side, (b) render the patch's `resultDigest` claim
   without applying ops, (c) compute the DOM digest from the rendered DOM text instead
   of the reduced state, (d) freeze the tail after hydration, and (e) sabotage the
   verify apparatus itself: neutralize the mutation — run the sensitivity step against
   the unmutated dump — and confirm `verify-E3-T07` goes red for a missing expected
   failure rather than printing the `EXPECTED-FAIL OK` marker unconditionally. For
   each, `make verify-E3-T07` (and/or `pnpm test`) must go red. Any sabotage that
   stays green refutes whichever gate it slipped past. Check the diff for
   `.skip`/`.todo`/inline lint disables while there.
9. **Cold start.** Fresh clone via `tools/verify/cold_clone.sh`, fresh server data
   dir, fresh browser profile: seed, run the spec, independently re-derive one
   checkpoint digest with `ef replay` on your own dump. Any dependence on a warm
   server, cached bundle, or builder-machine state is a refutation, not an excuse.
10. **Console sweep and coverage.** Walk the full Replay recording: any uncaught
    exception or console error — including during your partition recovery and forged
    patches — refutes the zero-console-error criterion; cite the point link. Then hold
    the recording and committed spec against the diff: hydration, step parity, the
    live patch, the fallback write, tombstone, re-create, rename, binary, and the
    no-second-implementation check must each have executed in a committed test or the
    cited recording. Unexecuted diff is unproven or dead — the builder picks which,
    you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your own-session parity chain as a committed e2e
fixture (edit script + expected digests), and any forged-patch or encoding-edge cases
that reached interesting surface into the harness suite.

## Verification log
