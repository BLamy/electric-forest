---
id: E5-T10
epic: 5
title: "Evidence attachment model: logs, digests, and rr traces as content streams; Replay runs as reference events — attachable to any entity"
priority: 510
status: pending
depends_on: [E5-T01, E5-T02]
estimate: M
capstone: false
---

## Goal

Evidence on electric-forest is events like everything else: `@eforest/evidence`
(`packages/evidence`) freezes `ATTACHMENT_EVENT_VERSION = 1` — one attachment envelope
shared by **every** owning entity kind, so issues, PRs, and later Epic-6 tasks all cite
evidence through the same frozen contract instead of growing per-entity variants. Each
owning entity gets a dedicated attachment stream, id pattern
`evidence:<org>/<repo>/<entityType>/<entityId>` with `entityType ∈ { issue, pr }`
(extended additively per entity kind under a version bump — Epic 6 adds `task`), living
in the repo's E2-T06 namespace so Epic-2 authorization applies unchanged. Two ways
evidence exists: **uploaded artifacts** (event-log dumps, digest files, rr trace blobs —
arbitrary bytes) are stored as **content streams**, id pattern
`evidence-content:<org>/<repo>/<attachmentId>`, written through E0-T11's validated
`POST /streams/:id/dispatch` as a sequence of `content.chunk { v: 1, seq, bytes }`
events (base64 payload, decoded length 1..`MAX_CHUNK_BYTES` = 512 KiB, `seq`
consecutive from 0) terminated by exactly one
`content.sealed { v: 1, sha256, size, chunks }` whose claimed SHA-256/size the seal
validator **recomputes from the appended chunks and refuses on mismatch** — a lying
digest never becomes a fact; total decoded size is capped at `MAX_ATTACHMENT_BYTES` =
16 MiB with the oversize refusal typed and log-neutral. **External references** (Replay
browser-run recordings) are pure reference events — no bytes stored, an `https:` URL
recorded on the attachment stream. The attachment stream's frozen actions are
`evidence.attached { v: 1, attachmentId, kind, name, mediaType, size, sha256,
contentStream }` (legal only after the named content stream is sealed with byte-equal
`sha256`/`size`; `kind ∈ { event-log, digest, rr-trace }`),
`evidence.linked { v: 1, attachmentId, kind: "replay-recording", url, title? }` (the
Replay-link proof — an `https://app.replay.io/recording/<id>` URL recorded as a
reference event, the platform form of the AGENTS.md PR evidence rule),
`evidence.waived { v: 1, justification }` (the explicit "no browser session can
validate this" declaration — `justification` is mandatory and non-empty; this is what
E5-T06's `pr/merge-evidence-missing` gate accepts in place of an attachment or link),
and `evidence.detached { v: 1, attachmentId }`. The exported `attachmentReducer` (registered
`register('evidence', attachmentReducer, 1)`) and `contentReducer`
(`register('evidence-content', contentReducer, 1)`) are pure and total; the reduced
`AttachmentListState { v: 1, entityRef, attachments }` lists attachments in event-offset
order with `attachedAtOffset` and `detachedAtOffset` as offsets (never wall-clock), so
`ef replay <dump> --digest` reproduces an entity's evidence list to one canonical
SHA-256, twice, byte-identically — and the reduced content-stream state carries the
**reducer-computed** `sha256`, so replaying an uploaded artifact's content stream
independently re-derives its claimed digest from the bytes themselves. Every refusal is
an E0-T11 class (`schema-violation` 422, `unknown-action-type` 404,
`validator-rejected` 409 with a frozen `error.reason` from this task's code list) and is
log-neutral: head offset and dump digest byte-identical before and after.

## Context

This is the "evidence attachments — rr traces, Replay browser-run references, event-log
dumps, digests — reported into the durable filesystem as content streams / reference
events on their owning entity" line of ROADMAP.md Epic 5, and it is the platform
swallowing AGENTS.md's own evidence doctrine: the two-layer time-travel currency
(stream dumps + digests + rr traces + Replay recordings) becomes first-class data on
the entities it proves things about. E5-T11 renders exactly this model in the UI
(hashes shown and matching, links resolving); E5-T12's negotiation harness attaches its
composite-digest artifacts through it; Epic 6's builder/critic loop ("a task is an
issue with evidence") stores every claim's proof through this envelope. None of them
re-derive it.

Design decision frozen here: evidence lives on a **dedicated per-entity attachment
stream**, not by revving the E5-T01 issue or E5-T02 PR envelopes. Reasons, stated so
the critic can hold them: (a) the sibling contracts stay frozen — their goldens remain
valid, their terminal semantics intact (a merged PR's own stream can never grow, per
E5-T02, yet post-merge evidence must still be attachable — it lands on the evidence
stream, not the PR stream); (b) one reducer serves every entity kind — "shared across
entity reducers" means one envelope and one attachment reducer composed alongside any
entity, not N copies; (c) attachability to future entity kinds (Epic-6 tasks) is a
validator whitelist entry plus a version note, not a migration.

Builds on, without re-freezing: E0-T03 (canonical JSON, SHA-256 state digests — the
one hashing path), E0-T10 (reducer registry, `/state`), E0-T11 (the four-class
dispatch taxonomy — this task adds validators and reason codes, never classes or
status codes), E0-T04 (`ef replay --digest`), E1-T01 (content-on-streams precedent —
this task's content streams follow the same chunked-bytes doctrine but are a distinct
frozen stream type, `evidence-content`, because evidence blobs are immutable-once-
sealed, unlike files), E2-T06/E2-T07 (namespace + per-stream authorization apply by
pattern; unauthorized dispatch is refused by Epic-2 machinery before these validators
run), E5-T01/E5-T02 (the entity streams whose existence the `evidence` stream-id
validator checks).

Contract frozen by this task (version-bumped, never silently changed; changing it
invalidates every evidence golden and E5-T11/E5-T12's citations):

- **Stream-id patterns**: `evidence:<org>/<repo>/<entityType>/<entityId>` and
  `evidence-content:<org>/<repo>/<attachmentId>`; `attachmentId` is an opaque,
  client-generated, path-safe identifier, unique per attachment stream.
- **The five action types and their `v: 1` payload schemas** in the Goal. Unknown
  fields refused (`schema-violation` 422, per E0-T11 — never ignored). `bytes` is
  standard base64, no whitespace; `sha256` is 64 lowercase hex chars; `url` must parse
  as an `https:` URL ≤ 2048 chars (anything else — `http:`, `javascript:`, `data:`,
  relative — is `evidence/invalid-url`); `kind` values are the frozen enums in the
  Goal, nothing else.
- **Content-stream lifecycle**: chunks with consecutive `seq` from 0, then exactly one
  seal; the seal validator recomputes SHA-256 and total size over the decoded chunk
  bytes in `seq` order and refuses on any mismatch. After the seal, the content stream
  is terminal — every further action refused. Size caps: per-chunk
  `MAX_CHUNK_BYTES` = 512 KiB decoded, total `MAX_ATTACHMENT_BYTES` = 16 MiB decoded,
  enforced at the door (an oversized chunk, or a chunk that would push the running
  total past the cap, is refused with nothing appended).
- **Attachment legality**: `evidence.attached` is refused unless its `contentStream`
  names an existing, **sealed** content stream in the same repo namespace whose sealed
  `sha256` and `size` byte-equal the event's; `attachmentId` must be new on the
  stream; `evidence.detached` must name an existing, not-yet-detached `attachmentId`;
  the stream id's `<entityType>/<entityId>` must resolve to an existing entity stream
  (an `issue:` stream with ≥ 1 event, or a `pr:` stream with ≥ 1 event).
- **Refusal reason codes** (each `validator-rejected` 409): `evidence/unknown-entity`,
  `evidence/duplicate-attachment-id`, `evidence/unknown-attachment`,
  `evidence/already-detached`, `evidence/unsealed-content`,
  `evidence/content-not-found`, `evidence/digest-mismatch`, `evidence/size-mismatch`,
  `evidence/oversized`, `evidence/chunk-out-of-order`, `evidence/sealed-terminal`,
  `evidence/invalid-url`, `evidence/unknown-kind`, `evidence/unknown-entity-type`.
- **Reduced shapes**, canonical-JSON encoded and digested per E0-T03, no wall-clock or
  random fields anywhere: `AttachmentListState` as in the Goal, `attachments` an
  offset-ordered array of `{ attachmentId, type: "content" | "reference", kind, name?,
  mediaType?, size?, sha256?, contentStream?, url?, title?, attachedAtOffset,
  detachedAtOffset? }` (detached entries remain, tombstoned — the log is forever;
  hiding them is E5-T11's rendering choice); `ContentState { v: 1, size, chunks,
  sha256, sealed, sealError? }` where `sha256` is **computed by the reducer** from the
  chunk bytes (incremental hash — the reducer never trusts the seal's claim; a
  hand-built dump whose seal lies reduces deterministically to `sealed: false,
  sealError: "digest-mismatch"`).
- **Reducer totality**: both reducers are pure and total over any event sequence —
  door-illegal events in a hand-built dump reduce to deterministic no-ops or the typed
  `sealError` state, never a throw — because `replay(log)` must never depend on the
  door having existed.

Non-goals: rendering attachments in the web app and browser-side upload UX (E5-T11),
the negotiation-harness composite digest (E5-T12), attaching to Epic-6 task entities
(additive later), content dedup across attachments, resumable/parallel upload
protocols beyond the consecutive-`seq` contract, retention/compaction of sealed
content (E1-T07 semantics apply as-is), interrogating Replay URLs for validity beyond
the frozen URL syntax (liveness of a recording is not a stream fact), and any auth
changes (Epic 2 applies untouched). No database (bet 4): the attachment list surface
is `replay(evidence stream)`, full stop.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T10-evidence-attachment-model/`.

- `packages/evidence` (`@eforest/evidence`):
  - `src/events.ts` — `ATTACHMENT_EVENT_VERSION = 1`, the five payload schemas,
    `MAX_CHUNK_BYTES`, `MAX_ATTACHMENT_BYTES`, the kind enums, the stream-id
    pattern parsers.
  - `src/reducer.ts` — `attachmentReducer` (v1) and `contentReducer` (v1), pure,
    total, conforming to the `@eforest/protocol` reducer signature; the content
    reducer hashes chunk bytes incrementally via the E0-T03 hashing path (no second
    SHA-256 implementation, no `crypto` use outside the one sanctioned module).
  - `src/validate.ts` — one E0-T11 `ActionValidator` per action type emitting exactly
    the fourteen frozen reason codes; the `evidence.attached` validator resolves the
    named content stream through the server's own store (one lookup path) and the
    stream-id validator resolves the owning entity stream the same way.
  - `src/upload.ts` — `uploadAttachment(client, { entityRef, kind, name, mediaType,
    bytes })`: chunks, dispatches, seals, then dispatches `evidence.attached`;
    and `downloadAttachment(client, contentStreamId)`: reads the content stream and
    returns the exact original bytes (the round-trip mouth E5-T11 and tests reuse).
  - Module README: the payload field tables, the frozen reason-code list, the size
    caps, the stream-id patterns, both reduced-state shapes, the reducer-totality
    behavior on door-illegal dumps, and the additive-extension rule for new entity
    types and kinds (version bump + regenerate every evidence golden).
- Server registration: stream types `evidence` → `(attachmentReducer, 1)` and
  `evidence-content` → `(contentReducer, 1)` in the E0-T10 registry, all validators
  wired into the E0-T11 dispatch stage at startup, so `/state` serves both reduced
  shapes and `ef replay` resolves both reducers by stream type.
- `packages/evidence/test/attachment-lifecycle.test.ts` — real HTTP through
  `/dispatch` against a live server: create an issue (E5-T01 machinery) and a PR
  (E5-T02 machinery); upload a real event-log dump, a digest file, and a binary blob
  containing all 256 byte values (rr-trace stand-in) to each; link a Replay recording
  URL; detach one; assert the reduced list at every intermediate offset, offset-order,
  tombstone retention, and byte-parity of `downloadAttachment` output against the
  original bytes for every upload.
- `packages/evidence/test/attachment-refusals.test.ts` — every one of the fourteen
  reason codes triggered through the door (including: seal with a wrong `sha256`, seal
  with a wrong `size`, chunk with `seq` skipped/repeated, chunk after seal, attach
  before seal, attach naming a nonexistent content stream, attach whose event `sha256`
  differs from the seal's, chunk pushing total past 16 MiB, single chunk over 512 KiB,
  attach to a nonexistent issue, `http:` and `javascript:` URLs, unknown kind,
  duplicate `attachmentId`, detach twice), each asserting status 409 +
  `error.class === "validator-rejected"` + the exact frozen reason, and byte-identical
  head offset + dump digest before/after on **both** the attachment stream and the
  content stream.
- `packages/evidence/test/attachment-property.fuzz.test.ts` — seeded (seeds
  committed): random byte payloads (0 bytes up to past the cap, hostile
  non-UTF-8 content) chunked at random boundaries, random interleavings of the five
  action types; invariants: an accepted seal's stream always round-trips byte-equal
  and reducer-hashes to the sealed `sha256`; no accepted log has a post-seal event or
  a non-consecutive `seq`; every refusal is log-neutral; `replay(accepted log)` twice
  yields one digest; a hand-built lying-seal dump reduces to the typed `sealError`
  state without throwing.
- Committed evidence:
  - `evidence/e5-t10-attachments.jsonl` + `evidence/e5-t10-content.jsonl` — golden
    attachment-stream and content-stream logs produced through real dispatches
    (the content golden's payload is itself a real E5-T01/E5-T02 golden event log,
    eating our own dog food).
  - `evidence/e5-t10-digests.txt` — their committed `ef replay --digest` values,
    produced by two separate processes, plus the sealed artifact's SHA-256.
  - `evidence/e5-t10-roundtrip.txt` — transcript: upload → download → `cmp` exit 0
    against the original file → `shasum -a 256` equal to the sealed digest → the
    replayed `ContentState.sha256` equal to both.
  - `evidence/e5-t10-refusals.txt` — one block per reason code: dispatch body,
    response, before/after head offset + dump digest, byte-equal.
  - `evidence/e5-t10-sensitivity.md` — sabotage transcripts.
- `Makefile`: `verify-E5-T10` per the E0-T02 target contract — cold-clone runnable,
  joins `verify-all`, `make verify-list` maps it: (1) replays both goldens twice as
  separate processes and diffs against `e5-t10-digests.txt` (never regenerates); (2)
  round-trip parity — re-runs upload/download of the committed source artifact against
  a fresh server, `cmp` byte-equal, digests chained as in the round-trip transcript;
  (3) sensitivity — flip one byte inside one `content.chunk` payload of a temp copy of
  the content golden, assert the replay-digest comparison exits nonzero **and** the
  replayed `ContentState.sha256` no longer equals the sealed claim, printing
  `MUTATION fixture=e5-t10-content byte=<offset> digest-mismatch EXPECTED-FAIL OK`
  only after observing both; (4) re-drives every refusal fresh and diffs against the
  committed transcript; (5) re-runs `verify-E0-T11`, `verify-E5-T01`, and
  `verify-E5-T02` proving the door taxonomy and both sibling entity contracts are
  unperturbed.

## Acceptance criteria

- [ ] `make verify-E5-T10` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env — evidence:
      `make verify-E5-T10 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Replay determinism of the attachment list**:
      `ef replay evidence/e5-t10-attachments.jsonl --digest` (reducer resolved as
      `evidence`) run twice in two separate node processes prints one byte-identical
      digest equal to the committed value in `evidence/e5-t10-digests.txt`; same for
      the content golden under `evidence-content`; `/state` on live streams carrying
      the same event sequences matches — evidence: the Makefile steps plus a committed
      integration test asserting offline/online digest equality.
- [ ] **Byte-parity round trip**: an uploaded event-log artifact downloaded via
      `downloadAttachment` is byte-identical to the source file (`cmp` exit 0), its
      `shasum -a 256` equals the sealed `sha256`, equals the `sha256` recorded in the
      `evidence.attached` event, equals the reducer-computed `ContentState.sha256`
      from `ef replay` of the content dump — one unbroken digest chain — evidence:
      `evidence/e5-t10-roundtrip.txt` plus the in-target re-run.
- [ ] **Integrity sensitivity**: the in-target mutation step flips one byte of a chunk
      payload and both the state-digest comparison and the sha256-vs-seal comparison
      go red — evidence: `make verify-E5-T10 2>&1 | grep -c
      '^MUTATION .* digest-mismatch EXPECTED-FAIL OK$'` ≥ 1. A seal dispatched with a
      deliberately wrong `sha256` through the door is refused
      `evidence/digest-mismatch` with both logs untouched — evidence: committed
      refusal test + transcript block.
- [ ] **Every refusal is log-neutral**: all fourteen frozen reason codes produced
      through `/dispatch` by committed test, each with exact class/status/reason and
      byte-identical before/after head offset + dump digest on every touched stream;
      the fresh-driven set diffs byte-equal against `evidence/e5-t10-refusals.txt`.
- [ ] **Size caps hold at the boundary**: a chunk of exactly 512 KiB decoded is
      accepted and one of 512 KiB + 1 refused; a total of exactly 16 MiB seals and one
      of 16 MiB + 1 is refused at the offending chunk (`evidence/oversized`), log
      untouched — evidence: committed boundary tests green.
- [ ] **Attachable to both entity kinds**: the lifecycle test attaches content and
      reference evidence to a real issue and a real PR (including a **merged** PR —
      evidence lands on the evidence stream while the PR stream's head offset and dump
      digest stay byte-identical, preserving E5-T02's terminality); attach to a
      nonexistent entity and to entityType `wiki` are refused
      (`evidence/unknown-entity`, `evidence/unknown-entity-type`) — evidence:
      committed tests green.
- [ ] **Reference events carry no bytes**: `evidence.linked` with a valid `https:`
      Replay URL lands and appears in the reduced list with `type: "reference"` and no
      `contentStream`/`sha256`; the reference event round-trips byte-exact — dump the
      stream, replay it, and the event record and reduced entry are byte-identical to
      the dispatched payload; `http:`, `javascript:`, `data:`, and 2049-char URLs
      are each refused `evidence/invalid-url`, log untouched — evidence: committed
      tests green.
- [ ] **Reducer totality**: hand-built dumps containing a lying seal, a post-seal
      chunk, and an attach-before-seal each replay without throw to a deterministic
      digest, twice byte-identical, and the lying-seal dump's state reads
      `sealed: false, sealError: "digest-mismatch"` — evidence: committed test green.
- [ ] **Property suite green on committed seeds** (≥ 500 generated cases): zero
      invariant violations, including byte-parity and reducer-hash equality for every
      accepted upload including 0-byte and non-UTF-8 payloads — evidence: seed and
      case count in the committed run transcript.
- [ ] **Authorization applies**: dispatch to an evidence or content stream without a
      valid Epic-2 credential (and with one lacking write grant on the repo's
      namespace) is refused by Epic-2's frozen semantics, logs untouched — evidence:
      committed integration test green.
- [ ] No regression: `verify-E0-T11`, `verify-E5-T01`, `verify-E5-T02` re-run green
      inside the target; all root gates pass (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build`); `tools/verify/self_check.sh`
      passes.
- [ ] Replay browser layer: N/A — server/package task with no browser-reaching
      surface (evidence rendering is E5-T11); declared explicitly per AGENTS.md, with
      the golden logs, committed digests, round-trip transcript, and refusal
      transcripts as the stream-layer currency.

## Adversarial verification

The claim under attack: "an attachment is either bytes whose digest the platform
itself re-derived, or a well-formed reference — nothing else can enter the log, and
replaying any entity's evidence stream reproduces its attachment list exactly." Use
your own files, byte patterns, and seeds throughout — never the builder's fixtures —
and invent at least one angle this list lacks.

1. **Upload your own hostile bytes.** From a cold clone: a 0-byte file, a file of all
   256 byte values repeated, a file that is itself valid base64 (double-encoding
   trap), a file containing canonical-JSON event lines (confusion trap), a file of
   exactly 16 MiB. Upload each through `uploadAttachment`, download it back, and
   `cmp` against your original — one differing byte anywhere refutes. Independently
   `shasum -a 256` each original and hold it against the sealed digest, the attached
   event's digest, and the replayed `ContentState.sha256` — one broken link in the
   chain refutes the integrity story.
2. **The lying digest.** Chunk a file by hand and dispatch a seal whose `sha256` is
   off by one hex char, whose `size` is off by one byte, and whose `chunks` count is
   wrong — each must be refused with the exact frozen reason and both logs untouched.
   Then bypass the door: hand-write a dump with a lying seal and replay it — the
   reducer must land the typed `sealError` state, not the claimed digest and not a
   throw. A replay that reports the *claimed* sha256 as truth refutes the reducer's
   independence from the claim.
3. **Byte-flip sweep.** Take your own sealed content dump and flip one byte in every
   `content.chunk` payload, one at a time (script it — chunks are few). Every single
   flip must change the `ef replay --digest` output and break the sha256-vs-seal
   equality. Any flip that leaves verification green refutes the measuring apparatus.
   Do the same for one byte of the *attachment* golden and confirm the committed
   digest comparison in `verify-E5-T10` goes red, not regenerate-and-pass.
4. **Boundary artillery on the caps.** Probe 512 KiB ± 1 per chunk and 16 MiB ± 1
   total with your own payloads, including reaching the total cap via many small
   chunks (the running-total check, not just the per-chunk check). An accepted
   over-cap byte, or a refused at-cap byte, refutes; so does any oversize refusal
   that leaves a partial chunk appended (dump digest before/after must be
   byte-equal — a half-swallowed upload is a permanent garbage fact).
5. **Sequence and terminality attacks.** Fire chunks with `seq` skipped, repeated,
   negative, and starting at 1; a second seal; chunks after the seal; a seal on an
   empty content stream carrying the SHA-256 of the empty string (decide from the
   README whether 0-byte artifacts seal — the contract must pin it and behavior must
   match). After sealing, throw the whole vocabulary plus schema junk at the content
   stream — its log must not grow by one event across the barrage. Any append after
   seal refutes immutability; any refusal under the wrong E0-T11 class/status refutes
   the taxonomy claim.
6. **Dangling and cross-wired references.** Attach with a `contentStream` that
   doesn't exist, one that exists but is unsealed, one sealed in a *different repo's*
   namespace, and one whose seal matches but whose event `sha256` you altered.
   Each must be refused with its exact frozen reason. Then the entity side: attach to
   an issue id that was never opened, to entityType `wiki`, and to a merged PR —
   the first two refuse, the third **accepts** while the PR stream's own head offset
   and dump digest stay byte-identical (dump it before and after). Evidence leaking
   onto a terminal PR stream refutes E5-T02's frozen terminality.
7. **URL smuggling.** `evidence.linked` with `javascript:alert(1)`,
   `data:text/html,...`, `http:` (no s), `https://` followed by 3000 chars, a URL
   with embedded newlines/NULs, and a schemaless `//host/path`. Every one refused
   `evidence/invalid-url` (or 422 where schema-level), log untouched. One accepted
   smuggled URL refutes — it becomes E5-T11's XSS, forever, because the log is
   forever.
8. **Concurrency at the seal.** Two clients race: interleaved chunk writers on one
   content stream, and simultaneous seal + chunk, seal + seal (repeat under load).
   Whatever order the door serializes, every resulting accepted log must satisfy the
   machine (consecutive `seq`, ≤ one seal, nothing after it) and every final sealed
   digest must match the bytes actually in the log. Dump and check every run; one
   illegal accepted log refutes dispatch-time state reading.
9. **Second-implementation hunt.** Read `packages/evidence/` and the server wiring
   for a second SHA-256/canonical-encoding path outside the E0-T03 sanctioned module,
   a second copy of the size caps, or legality logic duplicated between validators
   and reducers rather than shared. One parallel truth — even behavior-identical
   today — refutes "one envelope, frozen".
10. **Sabotage the suite.** In a scratch worktree: (a) make the seal validator trust
    the claimed `sha256` without recomputing, (b) raise `MAX_ATTACHMENT_BYTES`
    silently to 32 MiB, (c) let the attachment reducer drop tombstoned entries from
    the list, (d) accept `http:` URLs. For each, `pnpm test` **and**
    `make verify-E5-T10` must go red. Any sabotage that stays green refutes whichever
    gate it slipped past. Check the diff for `.skip`/`.todo`/lint disables while
    there. Then the self-licking check: `git log evidence/e5-t10-digests.txt` — the
    committed digests must predate and never be rewritten by any verify run.
11. **Coverage vs. the diff.** Hold the claimed final run against the diff: all
    fourteen reason codes, both boundary sides of both caps, the round-trip on every
    committed upload, both replay mouths, the totality dumps, the authz refusal, and
    the sibling-target re-runs must each have been executed by a committed test or
    cited transcript. Unexecuted diff is unproven or dead — builder picks which, you
    enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your hostile byte corpus and any accepted-log shape
the fuzzer never generated into the committed corpora.

## Verification log
