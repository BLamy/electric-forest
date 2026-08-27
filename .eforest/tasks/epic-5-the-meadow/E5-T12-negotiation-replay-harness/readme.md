---
id: E5-T12
epic: 5
title: "Negotiation replay harness: multi-stream session dumps replayed to one composite digest, promoted to make verify-E5-negotiation"
priority: 512
status: implemented
depends_on: [E5-T07, E5-T10]
estimate: M
capstone: false
---

## Goal

`ef` (`packages/cli`) gains a **multi-stream session mode**: `ef replay --session
<sessionDir>` takes a directory containing a canonical-JSON `session.json` manifest plus
one `${encodeURIComponent(streamId)}.events.jsonl` dump per member stream, replays every member from offset
`-1` through its manifest-named registered reducer (issue workflow from E5-T01, PR
lifecycle from E5-T02, stream-fs branch reducer from E1 for source/target/wiki branches,
attachment content/reference reducers from E5-T10), **verifies every cross-link resolves
inside the session** (E5-T07 entity refs, `via.{prStream, prMergedOffset}` close
provenance, the PR's `(sourceBranch, targetBranch, forkOffset)` triple, E5-T10
attachment references with their content hashes), and prints one **canonical composite
digest** — SHA-256 over the canonically-encoded, stream-id-sorted list of per-stream
results — that is deterministic, manifest-order-independent, and sensitive to any single
byte of any constituent dump. A companion capture mode, `ef replay --session-dump
--server <url> --root <streamId> --out <sessionDir>`, walks the reference closure from a
root entity, dumps each member stream via plain offset GETs, writes the manifest, and
immediately replay-verifies what it wrote (a dump is born verified or the command exits
nonzero). A scripted issue→branch→PR→merge negotiation (with a wiki-page edit and one
evidence attachment along the way) is committed as the golden session fixture
`packages/cli/fixtures/sessions/issue-to-merge/`, and the whole apparatus is promoted to
`make verify-E5-negotiation` (with `verify-E5-T12` as the per-task target composing it):
from a cold clone the fixture replays to its committed composite digest, a one-byte
mutation of any constituent dump turns the harness red naming the exact stream and
offset, and `ef bisect` pins an injected divergence to the offset where it was injected.

## Context

This is the measuring apparatus the E5-T13 capstone's claim stands on, and no feature
task owns it. The capstone promises "the whole negotiation replays offset-by-offset with
`ef replay`" (ROADMAP.md, Epic 5 — the-meadow), but until now `ef replay` proves one
stream at a time: E0 gave dump→digest for a single log, E5-T07 verified a two-stream
PR/issue pair with bespoke script glue, and E5-T10 made evidence attachments their own
content streams. A negotiation is inherently multi-stream — issue stream, PR stream,
source and target branch streams, the wiki branch, attachment content streams — and its
correctness claims are _relational_: the issue's `via.prMergedOffset` must be a real
`pr/merged` event in the PR dump, the PR's `forkOffset` must exist on the target branch,
an attachment reference's `sha256` must equal the digest of the attachment content it
names. A set of individually green streams whose links dangle is a broken negotiation
that per-stream replay cannot see. This task makes the relational claim a first-class,
offline-checkable artifact with one digest, so the capstone (and E6's task-as-issue loop
after it) can cite a single number instead of a pile of scripts.

Per AGENTS.md, replay is ground truth (`replay(log)` from offset `-1`) and equality
claims are digest comparisons. Session mode stays inside that doctrine: it is a **pure
fold plus pure link checking** over committed files — no server, no network, no
dispatches during replay. The capture mode is the only part that touches a server, and
it uses only read paths (offset GETs and application projection bootstrap); the scenario script that generates
the fixture drives every mutation through the validated dispatch door.

Dependency note: E5-T07 supplies the frozen entity-ref and close-provenance shapes this
harness resolves (its golden two-stream fixture is the prior art being generalized), and
brings E5-T01/T02/T06 — and E1's branch/merge machinery — transitively. E5-T10 supplies
the attachment content/reference model so evidence can be a session member. The wiki
branch needs no dependency of its own: a wiki branch is an ordinary stream-fs branch
stream (E5-T08's browser surface is not touched — the scenario edits the wiki page
through stream-fs dispatch). E5-T04/T05/T09/T11 (UI) are not dependencies — this task
has no browser surface.

The golden closure has seven streams, not six: E5-T10 deliberately keeps the owning
entity's evidence index separate from both the PR lifecycle and the attachment-content
stream. Omitting that evidence-index member would make the content hash an orphan rather
than a replayed cross-link. Both evidence streams use the manifest's existing
`attachment` role and retain their distinct registered reducer ids (`evidence` and
`evidence-content`).

The two blocks below are frozen here and must be reproduced byte-for-byte in the
`packages/cli` README under identical marker pairs; changing them invalidates this
task's golden fixture and its committed composite digest.

<!-- frozen:E5-T12:session-manifest -->

A session is a directory holding `session.json` plus one
`${encodeURIComponent(streamId)}.events.jsonl` per member. The encoding is the standard
uppercase percent-encoding produced by JavaScript `encodeURIComponent`, so `/` never
creates an accidental directory and every filename is portable and derived rather than
trusted from the manifest. `session.json` is canonical JSON: `{ "session": <name>, "version": 1,
"root": <streamId>, "streams": [ { "stream": <streamId>, "role": "issue" | "branch" |
"wiki" | "pr" | "attachment", "reducer": <registered reducer id>, "head": <offset> } ] }`.
Stream ids and offsets are opaque strings (compared and echoed, never parsed or
coerced). `streams` is stored sorted lexicographically by `stream`, and `head` must
equal the offset of the last record in that member's dump file — a mismatch is the
typed failure `session/head-mismatch`. Unknown roles, duplicate stream entries, a
`root` not in `streams`, or a dump file present with no manifest entry (and vice versa)
are typed failures; session replay never guesses.
<!-- /frozen:E5-T12:session-manifest -->

<!-- frozen:E5-T12:composite-digest -->

Session replay hashes each accepted canonical JSONL member dump byte-for-byte to a
per-stream `dumpDigest`, then folds it from offset `-1` through its manifest-named
reducer to a per-stream state digest (SHA-256 over canonically-encoded reduced state),
then resolves links: (1) every E5-T07 entity ref appearing in any member's reduced
state names a member stream of the matching role; (2) every `via.{prStream,
prMergedOffset}` names a member PR stream whose dump contains a `pr/merged` record at
exactly that offset (string equality); (3) the PR's `(sourceBranch, targetBranch,
forkOffset)` names two member branch streams and an offset present in the target's
dump; (4) every E5-T10 attachment reference names a member attachment stream whose
replayed content digest string-equals the reference's `sha256`. Wiki members carry no
link rules — they are folded and enter the composite like any member. Any failure is
`session/unresolved-link` citing the referring stream, the referring offset, and the
rule number, and the command exits nonzero printing no composite digest. The composite
digest is the SHA-256 over the canonical JSON encoding of `{ "version": 1, "streams":
[ { "stream", "role", "reducer", "head", "dumpDigest", "digest" } ... sorted by stream ],
"links": { "resolved": <count> } }` — a pure function of every accepted dump byte,
including reducer-inert envelope fields, independent of manifest file ordering, machine,
and wall clock.
<!-- /frozen:E5-T12:composite-digest -->

Non-goals: no UI (E5-T11 already renders evidence; E5-T13 demos the browser side), no
new event kinds or reducers (this task only reads the frozen E5-T01/T02/T07/T10
shapes), no server-side session endpoint (sessions are a CLI/verify construct over
existing read paths), no snapshot-aware session replay (fixture streams are full
histories; snapshot interplay is out of scope and stated here so the critic's scope
audit has a line to hold), no cross-session or cross-repo link resolution.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T12-negotiation-replay-harness/`.

- `packages/cli/src/session/manifest.ts` — `parseSessionManifest` / `validateSession`
  enforcing the frozen manifest block (typed failures: `session/head-mismatch`,
  `session/unknown-role`, `session/orphan-dump`, `session/missing-dump`,
  `session/duplicate-stream`, `session/bad-root`), pure.
- `packages/cli/src/session/replay.ts` — the pure session fold: per-stream replay
  through the manifest-named registered reducers, the four frozen link-resolution
  rules, and `compositeDigest(results)` per the frozen encoding. Zero network, zero
  dispatch — a committed test asserts the module graph reachable from it imports no
  client/server/network module.
- `packages/cli/src/session/dump.ts` + CLI wiring — `ef replay --session <dir>
[--digest]` printing one `SESSION stream=<id> role=<r> head=<o> digest=<d> OK`
  line per member (sorted), one `LINKS resolved=<n> unresolved=0 OK` line, and one
  final `COMPOSITE digest=<d>` line; and `ef replay --session-dump --server <url>
--root <streamId> --out <dir>` computing the reference closure from the root's
  reduced state (bounded, cycle-safe, typed failure on refs leaving the namespace),
  dumping members via offset GETs, writing the manifest, then invoking the pure
  verifier on its own output before exiting 0.
- `tools/scenarios/issue_to_merge_session.ts` (run via a `pnpm` script) — the scripted
  negotiation against a fresh server: issue opened → labeled → `in-progress`; branch
  forked from main; two edits on the branch through stream-fs dispatch; one wiki-page
  edit on the wiki branch through stream-fs dispatch; PR opened with `closes: [issue]`
  and one E5-T10 evidence attachment (an event-log dump as a content stream plus its
  reference event on the PR); review comment; approval; merge — E5-T06 executes it,
  E5-T07 flips the issue to `done`. Every mutation through the dispatch door; the
  script ends by running `--session-dump` from the PR root.
- `packages/cli/fixtures/sessions/issue-to-merge/` — the golden fixture: the scenario's
  `session.json`, seven member dumps (issue, PR, source branch, target branch, wiki
  branch, the owning PR evidence-index stream, and attachment content), and
  `expected.json` pinning each per-stream dump digest and state digest, the
  resolved link count, the composite digest, and the `(via.prMergedOffset, pr/merged
offset)` pair.
- `packages/cli/test/session.replay.test.ts` — manifest validation rejects (every typed
  failure above, each asserting the exact type and nonzero exit), link rule rejects
  (one surgically broken fixture copy per rule 1–4, each producing
  `session/unresolved-link` citing the right stream/offset/rule), determinism (two
  folds of the golden fixture → byte-identical composite digest; manifest entries
  shuffled on disk → same digest), and composite-digest sensitivity (any single
  member's state digest change changes the composite; changing a reducer-inert canonical
  dump byte changes its dump digest and the composite).
- `packages/cli/test/session.dump.test.ts` — against a live server: run the scenario,
  `--session-dump`, and assert the dumped session replays to the same composite digest
  as the committed golden; closure discovery finds exactly the seven members (no more —
  an unrelated stream in the namespace must not be swept in); a dump raced by a
  concurrent append still self-verifies or fails typed (never writes a session that
  does not verify).
- `tools/verify/negotiation_session.sh` — the Makefile leg, cold-clone-safe, printing:
  the `SESSION`/`LINKS`/`COMPOSITE` lines from replaying the committed fixture,
  `COMPOSITE digest=<d> expected=<d> OK` after string-comparing against
  `expected.json`, `DETERMINISM session=issue-to-merge OK` (fixture replayed twice,
  composite digests byte-compared; plus the live scenario run twice from fresh servers
  when a server is available, loud-skip contract otherwise),
  one `MUTATION stream=<id> byte=<offset> EXPECTED-FAIL OK` line **per member stream**
  (flip one byte of a copy of each of the seven dumps in turn; each run must exit
  nonzero and its failure output must name that stream before the line prints), and
  `BISECT stream=<id> injected=<offset> found=<offset> OK` (append-divergent copy of
  one member log at a chosen record; `ef bisect` between committed and mutated must
  report exactly the injected offset — printed only after string-equality of the two
  offsets).
- `Makefile`: `verify-E5-negotiation` (the promoted named target running
  `negotiation_session.sh`) and `verify-E5-T12` (the per-task target composing the
  workspace gates plus `verify-E5-negotiation`); both in `verify-list`,
  `verify-E5-T12` joins `verify-all`; `tools/verify/self_check.sh` still passes.
- `packages/cli` README section "Session replay" carrying both frozen blocks under
  identical `<!-- frozen:E5-T12:* -->` markers plus the CLI flags and the
  golden-invalidation rule; doc-sync byte-diff of the delimited blocks enforced inside
  the test suite or `negotiation_session.sh`.
- `evidence/` — `e5-t12-verify.txt` (full `make verify-E5-negotiation` transcript),
  `e5-t12-composite.txt` (the composite digest plus all seven per-stream digests and
  head offsets), `e5-t12-mutations.txt` (the seven per-stream mutation failures with
  the harness's red output for each), `e5-t12-bisect.txt` (the bisect run: injected
  offset, found offset), `e5-t12-dump-parity.txt` (live `--session-dump` composite vs
  committed golden composite, byte-equal).

## Acceptance criteria

- [ ] `make verify-E5-negotiation` and `make verify-E5-T12` exit 0 from a pristine cold
      clone via `tools/verify/cold_clone.sh` (fresh server data dir, ephemeral port),
      zero skips — evidence: `make verify-E5-T12 2>&1 | grep -c '^SKIPPED:'` prints
      `0`, and the transcript ends `verify-E5-T12: OK`.
- [ ] **Golden composite.** The committed `issue-to-merge` session fixture replays
      offline (`ef replay --session`, no server running) to the composite digest pinned
      in `expected.json`, with all seven per-stream digests matching and
      `unresolved=0` — evidence: `make verify-E5-negotiation 2>&1 | grep -c
  '^COMPOSITE digest=.* expected=.* OK$'` prints `1`, and `grep -c '^SESSION
  stream=.* OK$'` prints `7`.
- [ ] **Links have teeth.** Each of the four frozen link rules, broken surgically in a
      fixture copy (a `via.prMergedOffset` retargeted to a real non-merge offset; an
      entity ref to a non-member; a `forkOffset` absent from the target dump; an
      attachment `sha256` off by one hex digit), makes session replay exit nonzero with
      `session/unresolved-link` citing the correct referring stream, offset, and rule,
      printing no composite digest — evidence: committed tests, `pnpm test` exit 0.
- [ ] **Determinism and order-independence.** The fixture replayed twice yields
      byte-identical composite digests; the manifest's `streams` array shuffled on disk
      yields the identical composite; the live scenario run twice from fresh server
      processes yields two dumps with byte-identical composite digests — evidence:
      `make verify-E5-negotiation 2>&1 | grep -c '^DETERMINISM
  session=issue-to-merge OK$'` prints `1`, shuffle case in committed tests.
- [ ] **Per-stream byte sensitivity.** For every one of the seven member dumps, a
      one-byte mutation of a copy turns the harness red before its `EXPECTED-FAIL OK`
      line prints, and the failure output names that stream — evidence:
      `make verify-E5-negotiation 2>&1 | grep -c '^MUTATION stream=.* byte=.*
  EXPECTED-FAIL OK$'` prints `7`, transcripts in `evidence/e5-t12-mutations.txt`.
- [ ] **Bisect pins the divergence.** `ef bisect` between a committed member log and a
      copy diverged at a chosen record reports exactly the injected offset (string
      equality, asserted before the OK prints) — evidence:
      `make verify-E5-negotiation 2>&1 | grep -c '^BISECT stream=.* injected=.*
  found=.* OK$'` prints `1`, with `injected=`/`found=` fields equal.
- [ ] **Dump is born verified.** `--session-dump` from the live scenario's PR root
      discovers exactly the seven member streams, self-verifies before exiting 0, and
      its composite digest byte-equals the committed golden; an unrelated stream in the
      same namespace is not included — evidence: committed test assertions plus
      `evidence/e5-t12-dump-parity.txt`.
- [ ] **Purity.** Session replay performs zero network calls and zero dispatches — the
      committed import-graph test passes, and the offline replay leg runs with no
      server process alive — evidence: committed test, `pnpm test` exit 0, the verify
      transcript's offline leg preceding any server start.
- [ ] **Frozen contract.** Both frozen blocks are reproduced byte-for-byte in the
      `packages/cli` README under identical markers and the doc-sync check goes red on
      drift — evidence: doc-sync green in the transcript, committed check.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint && pnpm
  typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows both
      `verify-E5-negotiation` and `verify-E5-T12`; `verify-all` green; the E5-T07 and
      E5-T10 suites re-run green unmodified.
- [ ] Durable evidence committed under `evidence/` as listed in Deliverables, cited by
      path and digest in the Verification log.
- [ ] Replay browser layer: N/A (CLI/verify infrastructure, no browser surface; E5-T13
      records the browser-side capstone) — mitigation: stream-layer evidence above is
      the currency; the Verification log entry declares this explicitly per AGENTS.md.

## Adversarial verification

The claim under attack: "one composite digest proves an entire multi-stream negotiation
— its per-stream folds and its cross-links — and cannot stay green past a single
corrupted byte, a dangling link, or a nondeterministic fold." Manufacture one green
composite over a broken session, one composite that drifts between identical runs, or
one mutation the harness shrugs off — any single success refutes. A harness that stays
green under sabotage is itself refuted. Use your own sessions, mutations, and offsets
throughout; invent at least one angle this list lacks.

1. **Composite honesty (mandatory).** Recompute the composite digest yourself from the
   committed dumps: fold each stream through the registered reducer via plain
   `ef replay --digest --reducer`, assemble the frozen canonical encoding by hand, and
   SHA-256 it. Any difference from the harness's composite refutes the frozen encoding
   or reveals hidden inputs (timestamps, paths, machine state) in the digest. Then
   regenerate `expected.json` from the committed logs with the committed code and
   byte-diff — drift refutes determinism or reveals check-time regeneration (a golden
   the code regenerates at test time proves nothing).
2. **Byte-mutation sweep, your offsets not theirs (mandatory).** The harness mutates
   one byte per stream; you mutate many: for each of the seven member dumps, flip bytes
   at positions the harness did not choose — inside a payload string, inside an offset
   field, inside a digest field of an attachment reference, inside a wiki patch body,
   in the final record, in the first record, and in `session.json` itself (a `head`, a
   `reducer` id, the `root`). Every mutation must go red with a failure naming the
   right stream (or the manifest); any green run refutes. Pay special attention to
   mutations that keep JSON well-formed — a harness that only catches parse errors is
   refuted by a semantic byte flip.
3. **Link-rule forgery.** Build sessions that satisfy per-stream replay but lie
   relationally: a `via.prMergedOffset` pointing at a `pr/review` event (right stream,
   wrong kind — rule 2 requires `pr/merged` at that exact offset); a mergeOffset that
   only matches after numeric coercion (`"07"` vs `"7"` — opaque offsets demand string
   equality; a resolver that coerces refutes opacity); an entity ref whose stream is a
   member but role-mismatched (an issue ref naming the wiki or attachment stream); an
   attachment reference whose `sha256` matches a _different_ member's content; two
   members claiming the same stream id with different dumps. Each must fail typed with
   the correct rule citation; any resolved lie refutes.
4. **Closure discovery abuse.** Run `--session-dump` against a namespace salted with
   traps: an unrelated issue stream, a second PR citing the same issue (must not be
   swept in unless reachable from the root's reduced state — verify against the frozen
   closure definition), a reference cycle (PR → issue → linked-by → same PR; the walk
   must terminate), and a dangling ref in the live state (dump must fail typed or
   record the resolution failure — a session written to disk that then fails its own
   verify refutes "born verified"). Race it: append to a member stream mid-dump and
   verify the output either self-verifies or fails typed — a torn session that
   verifies green refutes head accounting.
5. **Determinism under hostile conditions.** Replay the fixture on a second machine or
   under a different locale/timezone/`NODE_OPTIONS`; run the live scenario twice and
   diff not just composites but the full dumped logs canonically. Shuffle
   `session.json`'s array and re-verify the composite is unchanged; then _rename_ a
   dump file without touching the manifest and confirm `session/missing-dump` +
   `session/orphan-dump` fire. Any composite drift between identical inputs refutes.
6. **Bisect precision.** Inject divergences at your own offsets — first record, last
   record, a record in the middle of the merge propagation — and confirm `ef bisect`
   pins each exactly. Then inject two divergences and confirm it reports the _first_.
   A bisect that reports a neighboring offset, or the harness's `BISECT` line printing
   without the injected/found equality actually being asserted (read the script),
   refutes the measuring apparatus.
7. **Sensitivity, your sabotage not theirs.** In a scratch worktree: (a) make the
   composite skip link resolution (`links` hardcoded), (b) sort streams by manifest
   order instead of stream id, (c) compare `sha256` case-insensitively, (d) have
   `--session-dump` skip the self-verify, (e) drop one member (try the wiki — the one
   with no link rules pointing at it) from the composite encoding.
   `make verify-E5-negotiation` and/or `pnpm test` must go red under each; any
   sabotage that stays green refutes the apparatus for that property.
8. **Cold clone + scope audit.** Run only via `tools/verify/cold_clone.sh`, twice
   back-to-back, with no server running during the offline leg (kill anything on the
   port first — an offline replay that secretly needs the server refutes purity).
   Hold the diff against the evidence: manifest validation, all four link rules, the
   closure walk, the composite encoding, and the bisect leg must each have been
   executed by a test or transcript; check nothing out-of-scope was smuggled in (no
   server session endpoint, no new event kinds or reducers, no snapshot handling, no
   UI). Unexecuted diff is unproven or dead — the builder chooses which, you enforce
   it.

Refutation currency: a green composite over a session with a broken link or flipped
byte, a composite that differs between identical folds, a dump that fails its own
verify after exiting 0, a bisect pinning the wrong offset, a coerced-offset match, or
a sabotage run that stays green. Refutation → `status: refuted`, repro appended below.
No refutation → promote your surviving angle-3 forged sessions into the fixture corpus
as negative fixtures.

## Verification log

### 2026-08-27 — builder — implemented at `4ef30318`

- Added canonical seven-member session manifests and portable URI-encoded dump
  filenames, pure reducer-injected replay, all four relational link checks, sorted
  composite digests, transactional bounded closure capture, CLI wiring, and the
  committed `issue-to-merge` golden.
- `make --no-print-directory verify-E5-T12` passed at the implementation head: the
  focused CLI build passed, 2 files / 11 session tests passed, the offline golden
  produced composite `7818a1bb77c9295370eb1c282aa47ea92d76c2b361f5b736d973a41cb5a58e1a`,
  two official-server captures matched it, all seven semantic byte mutations failed
  while naming their member stream, and `ef bisect` pinned the injected issue
  divergence exactly at `0000000000000000_0000000000000001`.
- Frozen README blocks matched byte-for-byte. `make verify-list` now exposes focused
  targets for every implemented E5 ticket through T12; none of the earlier ticket
  targets was executed.
- Durable evidence: `evidence/e5-t12-verify.txt`, `evidence/e5-t12-composite.txt`,
  `evidence/e5-t12-mutations.txt`, `evidence/e5-t12-bisect.txt`, and
  `evidence/e5-t12-dump-parity.txt`.
- Replay: N/A (pure CLI/verification infrastructure with no browser surface) +
  mitigation: committed canonical stream dumps, reducer-state digests, cross-link
  checks, official-server dump parity, deterministic reruns, seven expected-red
  mutations, and exact bisect evidence. Per the human's direction, no dependency
  verifier, root suite, cold-clone gate, or browser/Replay gate was rerun.
