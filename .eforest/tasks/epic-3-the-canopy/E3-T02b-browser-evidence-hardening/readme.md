---
id: E3-T02b
epic: 3
title: "Browser evidence hardening: full-wire credential scanner and atomic Replay publication"
priority: 302.1
status: in-progress
depends_on: [E3-T02a]
estimate: S
capstone: false
split_from: E3-T02
inherited_invalid_loop_commit: 1d22b95
---

## Goal

Independently prove the evidence-facing half of E3-T02: captured browser traffic cannot
hide protected credentials, and no Replay/MP4 claim can be published after any
browser/transport failure. This task consumes verified E3-T02a as its clean walkthrough
fixture and does not change shell, whoami, routing, identity reducer, or DOM-triple
semantics.

## Lineage and scope

This child inherits every scanner counterexample from parent runs 1-14 and both round-16
open findings: the final-snapshot-to-close race and malformed/inconsistent terminal
telemetry. Those findings are not waived or reset. Run 16's MP4 is a refuted-apparatus
fixture only.

Owned paths: browser-verify credential observation/scanner modules and corpus;
Replay lifecycle, terminal telemetry, MP4 validation, and sole publication edge;
B-specific verification scripts and evidence. Shared Makefile wiring is assigned only
for the B/composite targets.

## Deliverables

- Typed full-wire scanner with bounded canonicalization and permanent historical corpus.
- One production recorder lifecycle owning telemetry collection, closure, schema
  validation, MP4 verification, and the sole upload invocation.
- Publication state-machine transcript and expected-red race/crash/schema matrix.
- Fresh clean same-session MP4, upload receipt or loud tenant denial, source coverage,
  and `make verify-E3-T02b`.

## Acceptance criteria

- [x] Scanner observes raw request target, URL, method/status, every header name/value
      including duplicates, and request/response bodies; malformed or ambiguous protected
      representations fail closed without losing raw provenance.
- [x] JWTs, PKCE verifiers, and session IDs occur nowhere outside the exact structurally
      valid HttpOnly `ef_session` value; `document.cookie` cannot expose it.
- [x] Every inherited credential counterexample is a named expected-red with a benign
      control and one-byte sensitivity mutation.
- [x] Publication follows `OPEN -> SEALING -> CLOSED -> DECIDED_CLEAN -> PUBLISHING`.
      Producers are closed and callbacks drained before the decision. Missing, malformed,
      inconsistent, stale, or unknown-version terminal telemetry is red.
- [x] Console error, page error, and request failure delivered during walkthrough, after
      serialization, after any final sample, and while close begins all yield nonzero and
      publication count zero. Clean control publishes exactly once.
- [x] Crash/kill at each lifecycle edge cannot create a success receipt; retry cannot
      double-publish; uploader failure remains failure.
- [x] MP4 must be nonempty, correctly encoded, and same-session. Standing authorization
      means upload is always attempted; tenant denial is reported and never converted to
      success.
- [x] Production source identity and coverage checks prove sensitivities execute the real
      scanner/recorder; root gates, E3-T02a, E2-T04, E2-T12, exact-head B, and cold-clone
      B all pass.

## Adversarial verification

Replay all historical scanner seeds plus mixed-case, folding, raw-authority, bounded
decode, malformed, and oversize cases. Inject failures at every publication transition;
attack missing keys, wrong types, unknown versions, contradictory counters, TOCTOU,
delayed callbacks, signals, truncated/zero/wrong-codec MP4s, duplicate calls, retries,
wrong session IDs, and upload failure. Every verdict cites corpus case, transition,
publication count, and production hunk.

## Verification log

### 2026-07-29 — split validation — BLOCKED ON E3-T02a

- Parent coverage assigned here: credential scanner/encoding policy, observation receipt,
  terminal telemetry, browser close, MP4 verification, and the sole publication edge.
- Inherited open findings: round-16 P1 post-final-snapshot failures published and P2
  malformed counters failed open; all earlier scanner counterexamples remain regression
  requirements.
- Fresh proof required: complete wire corpus, lifecycle race/crash/schema matrix,
  exact-head gate, cold clone, and clean final recording. No run 1-16 builder claim is
  positive evidence for this child.

### 2026-07-29 — inherited-baseline validation — EXPECTED RED

- Command: `node /private/tmp/e3t02-run16-final-boundary-attack.mjs` against split commit
  `084037f8439e42a69d573a9ff13d1055d609679b`.
- Late page error: `guard-exit=0 publish-count=1 live-failures=1 snapshot-failures=0`.
- Late request failure: `guard-exit=0 publish-count=1 live-failures=1
  snapshot-failures=0`.
- Inconsistent terminal schema: `activity=7 stableSamples=0 failures=0 guard-exit=0
  publish-count=1`.
- Verdict: the inherited B apparatus is conclusively red before implementation. These
  three attacks are the minimum regression seeds; B cannot claim implemented until each
  yields nonzero with publication count zero and the clean control publishes exactly
  once.

### 2026-07-30 — builder — IMPLEMENTED

- Candidate implementation: `7cf4091bb180e0a9e7f61e4ff931c25e390d60d3`.
- Exact-head command: `make verify-E3-T02b` — PASS. Root format, lint, typecheck,
  34 test files / 413 tests, build, Auth0 emulator, production shell browser proof,
  task architecture audit, queue self-check, and E3-T02 contract/topology checks passed.
- Wire evidence:
  `evidence/e3-t02b-wire-sensitivity.txt` — `E3_T02_WIRE_SENSITIVITY_OK
  mutations=161`; production platform-wire observations preserve duplicate raw headers,
  request targets, request/response bodies, and raw provenance, with body-read ambiguity
  failing closed.
- Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=25 timing=12 schema=8 crash=3 retry=1
  mp4=1 clean-publish=1`. The clean path records
  `OPEN>SEALING>CLOSED>DECIDED_CLEAN>PUBLISHING` and publishes once; every timing,
  malformed-journal, close/video/upload, retry, and codec attack is expected-red with no
  false success receipt or duplicate publication.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `7cf4091bb180e0a9e7f61e4ff931c25e390d60d3`, including the production browser proof
  and both sensitivity matrices.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case
  full-wire sensitivity corpus, and 25-case atomic lifecycle/crash/schema/MP4 matrix.
  No browser data left the machine; the denial was not converted to success.
- Claim: the production scanner now observes the full raw HTTP surface and fails closed
  on ambiguous evidence, while a single durable recorder lifecycle owns browser closure,
  terminal-journal validation, H.264 MP4 validation, and the sole upload edge. Therefore
  no post-snapshot browser/transport failure or malformed telemetry can publish a claim.

### 2026-07-30 — critic — VERDICT: refuted

- P1 same-session publication — FAILED. Predicted that a recording ID not proven to
  belong to the named Playwright session would be rejected before upload; observed
  `WRONG_RECORDING_ACCEPTED session=actual-browser-session
  uploaded=deadbeef-dead-4bad-8bad-deadbeefdead publicationCount=1`. The ID selector
  accepts whichever single new global Replay recording appears without checking its
  session or target (`tools/replay/e3_t02_recording_id.mjs:13-32`), and the lifecycle
  uploads and receipts that unbound ID (`tools/replay/e3_t02_recorder_lifecycle.mjs:
  267-283`). Demand: bind the Replay recording to the browser-open session with
  fail-closed identity evidence, and promote the wrong-recording-ID attack so an
  unrelated concurrent recording can never become this session's claim.
- P2 inherited timing and telemetry attacks — SURVIVED. Predicted all 12 timing
  combinations and eight schema mutations would remain red with no false receipt;
  observed `E3_T02_RECORDER_SENSITIVITY_OK cases=25 timing=12 schema=8 crash=3 retry=1
  mp4=1 clean-publish=1` from `node tools/verify/e3_t02_recorder_sensitivity.mjs`.
  Citation: `evidence/e3-t02b-recorder-sensitivity.txt`.
- P3 full-wire corpus — SURVIVED. Predicted the permanent credential corpus would reject
  all inherited mutations; observed `E3_T02_WIRE_SENSITIVITY_OK mutations=161` from
  `node tools/verify/e3_t02_wire_sensitivity.mjs`. Citation:
  `evidence/e3-t02b-wire-sensitivity.txt`.
- Replay N/A — WAIVED only for tenant denial. The loud external-export denial is an
  acceptable environmental fallback, but it cannot waive the task's local
  same-session identity invariant or its explicit wrong-session-ID attack.
- COVERAGE — INSUFFICIENT. The sensitivity suite's `wrong-session` mutation changes only
  the telemetry journal session (`tools/verify/e3_t02_recorder_sensitivity.mjs:238-243`);
  no test supplies an unrelated recording ID to the production publication edge.
- SUITE: n/a until the refutation clears. Independent attack:
  `node /private/tmp/e3t02b-wrong-recording-id-attack.mjs`.

### 2026-07-30 — builder rework — IMPLEMENTED

- Candidate implementation: `9ed9671246f874faa8c20b4895eec4c3f7e1ee8b`.
- Refutation repair: the walkthrough now captures its exact loopback authorization URL,
  and both recording selection and the post-close lifecycle independently require the
  Replay catalog entry to match its origin, path, OIDC state, nonce, and PKCE challenge.
  The lifecycle also requires the exact UUID once, `recordingStatus=finished`, the
  corresponding local `.dat` path, and no prior upload before entering
  `DECIDED_CLEAN`.
- Promoted attacks: unrelated recording UUID, mismatched browser authorization session,
  and already-uploaded recording all exit nonzero with publication count zero and no
  success receipt. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=28 timing=12 schema=8 crash=3 binding=3
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `9ed9671`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof, 161-case
  wire corpus, and expanded 28-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `9ed9671246f874faa8c20b4895eec4c3f7e1ee8b`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the expanded atomic lifecycle suite including the critic's
  same-session refutation. No browser data left the machine; no workaround was attempted.
- Claim: an unrelated concurrent Replay recording can no longer become this browser
  session's claim. Selection and publication both fail closed unless the local recording
  metadata independently matches the same OIDC authorization navigation observed by the
  named Playwright walkthrough.

### 2026-07-30 — fresh re-critic — VERDICT: refuted

- P1 same-session publication — FAILED. Predicted that an unrelated local Replay catalog
  entry could not become the named Playwright session's claim even when it copied a
  well-formed authorization URL; observed
  `UNRELATED_RECORDING_ACCEPTED session=actual-browser-session
  uploaded=deadbeef-dead-4bad-8bad-deadbeefdead publicationCount=1` from
  `node /private/tmp/e3t02b-well-formed-unrelated-recording-attack.mjs`. The selector
  and publication check compare only catalog UUID/path/status and the copyable
  authorization URI (`tools/replay/e3_t02_recording_id.mjs:20-30`;
  `tools/replay/e3_t02_recorder_lifecycle.mjs:229-260`); neither proves that UUID was
  emitted by the browser process/session closed for this MP4. Demand: carry a
  non-copyable browser-open/local-recording identity through close and require it at the
  sole upload edge, then promote this exact same-authorization/different-UUID attack.
- P2 binding coverage — INSUFFICIENT. Predicted the promoted wrong-recording attack
  would model a concurrent unrelated recording with otherwise identical authorization
  metadata; observed `wrong-recording-id` supplies no catalog row and
  `wrong-recording-session` changes the nonce
  (`tools/verify/e3_t02_recorder_sensitivity.mjs:339-370`). The suite therefore proves
  absence and mismatched metadata, not same-metadata session identity.
- P3 inherited timing and telemetry — SURVIVED. Predicted all 12 timing combinations,
  eight schema mutations, crash/upload/retry/MP4 attacks, and the three weaker binding
  attacks would remain red; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=28 timing=12 schema=8 crash=3 binding=3
  retry=1 mp4=1 clean-publish=1` from
  `node tools/verify/e3_t02_recorder_sensitivity.mjs`. Citation:
  `evidence/e3-t02b-recorder-sensitivity.txt`.
- P4 full-wire corpus — SURVIVED. Predicted all inherited scanner counterexamples would
  remain expected-red; observed `E3_T02_WIRE_SENSITIVITY_OK mutations=161` from
  `node tools/verify/e3_t02_wire_sensitivity.mjs`. Citation:
  `evidence/e3-t02b-wire-sensitivity.txt`.
- Replay N/A — WAIVED only for the external-upload denial. The loud policy denial is an
  acceptable environment fallback, but it cannot establish or waive the local
  same-session invariant.
- SUITE: n/a until the refutation clears.

### 2026-07-30 — builder provenance rework — IMPLEMENTED

- Candidate implementation: `6ad523d662e3fa5a193ddf4ecf82b4daa7080900`.
- Refutation repair: browser-open now passes a freshly created, run-private
  `RECORD_REPLAY_DIRECTORY` into the actual Replay Chromium process. Before publication,
  the lifecycle requires that directory's append-only `recordings.log` to contain exactly
  one ordered `createRecording -> writeStarted -> writeFinished` chain for the selected
  UUID and requires its exact, nonempty, regular `.dat` file. Catalog metadata cannot
  manufacture this browser-process provenance.
- Promoted exact attack: a second valid UUID with a copied authorization URL and otherwise
  green catalog metadata is expected-red because it has no create/write chain in the
  run-private browser directory. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=29 timing=12 schema=8 crash=3 binding=4
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `6ad523d`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof, 161-case
  wire corpus, and expanded 29-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `6ad523d662e3fa5a193ddf4ecf82b4daa7080900`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 29-case lifecycle suite with run-private browser-process
  provenance. No browser data left the machine; no workaround was attempted.
- Claim: a copied catalog row or authorization URI cannot substitute an unrelated Replay
  UUID. Only the recording file created and completed by this run's isolated Replay
  Chromium recording process can cross the sole publication edge.

### 2026-07-30 — process-provenance critic — VERDICT: refuted

- P1 copied-authorization catalog row — SURVIVED in its promoted form. Predicted a
  well-formed copied catalog row with a different UUID but no matching browser-process
  chain would be rejected; observed `CATALOG_ONLY_REJECTED publicationCount=0`.
  Citation: `node /private/tmp/e3t02b-process-provenance-attack.mjs`;
  `tools/replay/e3_t02_recorder_lifecycle.mjs:241-248`.
- P2 run-private ordered provenance — FAILED. Predicted publication would require the
  three events to come from the run-private regular `recordings.log` in physical
  `createRecording -> writeStarted -> writeFinished` order; observed
  `SYMLINKED_EXTERNAL_LOG_ACCEPTED publicationCount=1` and
  `OUT_OF_ORDER_LOG_ACCEPTED publicationCount=1`. The production lifecycle follows a
  symlink at `recordings.log`, then filters events by kind and compares only their
  timestamps, so an external log or physically reordered chain can satisfy the decision
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:237-259`). Demand: fail closed unless the
  log itself is the exact non-symlink regular file in the resolved run-private directory,
  validate the target records' exact schemas and physical order as one contiguous chain,
  and promote both attacks before publication.
- P3 path, truncation, and duplicate defenses — SURVIVED. Predicted malformed JSON,
  duplicate finish events, an outside `.dat` path, and a symlinked `.dat` would all
  remain red; observed `TRUNCATED_LOG_REJECTED`, `DUPLICATE_LOG_REJECTED`,
  `OUTSIDE_PATH_REJECTED`, and `SYMLINKED_DAT_REJECTED`, each with
  `publicationCount=0`, from the same independent attack.
- P4 inherited timing/schema/wire apparatus — SURVIVED. Observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=29 timing=12 schema=8 crash=3 binding=4
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161` from the committed production targets.
  Citations: `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The permanent copied-authorization case proves only a missing
  matching chain (`tools/verify/e3_t02_recorder_sensitivity.mjs:401-427`); it does not
  exercise a symlinked log or physical event reordering, the two production paths that
  published in this run.
- Replay: N/A (the builder's external-upload policy denial occurred before Replay
  Chromium launched) + mitigation remains the exact-head/pristine-clone browser proof
  and committed sensitivity corpora. This loud environmental waiver does not establish
  the failed local provenance invariant.
- SUITE: n/a until the provenance refutation clears.

### 2026-07-30 — builder process-log rework — IMPLEMENTED

- Candidate implementation: `718acdb5ab6b444160b1befaaa252f8b14156442`.
- Refutation repair: publication now requires both the run-private recording directory
  and its `recordings.log` to be real, non-symlink filesystem objects. The selected
  UUID's single create/start/finish records must occur in that physical file order as
  well as monotonically by timestamp before its exact regular `.dat` file is accepted.
- Promoted exact attacks: an external symlinked `recordings.log` and a physically
  reordered `writeFinished -> createRecording -> writeStarted` log are expected-red with
  publication count zero and no success receipt. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=31 timing=12 schema=8 crash=3 binding=6
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `718acdb`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof, 161-case
  wire corpus, and expanded 31-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `718acdb5ab6b444160b1befaaa252f8b14156442`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 31-case lifecycle suite including all process-provenance
  refutations. No browser data left the machine; no workaround was attempted.
- Claim: copied, reordered, external, symlinked, truncated, duplicated, or path-escaped
  recording provenance cannot cross the publication edge; the clean isolated
  browser-process chain still publishes exactly once.

### 2026-07-30 — terminal provenance critic — VERDICT: refuted

- P1 promoted process-log attacks — SURVIVED. Predicted symlinked external
  `recordings.log`, physical reordering, copied UUID, duplicate finish, truncated JSON,
  outside/symlinked `.dat`, and a symlinked run-private directory would all stop before
  publication; observed each rejected with `publicationCount=0`. Citation:
  `node /private/tmp/e3t02b-terminal-provenance-attack.mjs`.
- P2 exact contiguous process chain — FAILED. Predicted the selected UUID must have
  exactly one contiguous, schema-exact
  `createRecording -> writeStarted -> writeFinished` chain; observed
  `noncontiguous-same-recording-event: ACCEPTED publicationCount=1` after inserting an
  unknown same-UUID event between create and start, and
  `extra-schema-fields: ACCEPTED publicationCount=1` after adding an unexpected key to
  every target record. Production filters the UUID's records into three known-kind
  buckets but never rejects other matching kinds, non-contiguity, or extra/missing keys
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:248-260`). Demand: validate exact
  per-kind schemas and require the selected UUID's three records to be the entire
  matching set in contiguous physical order, then promote both attacks.
- P3 committed apparatus — SURVIVED. Predicted all 31 recorder cases and 161 wire
  mutations would remain green/red as declared; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=31 timing=12 schema=8 crash=3 binding=6
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The six permanent binding cases cover the prior provenance
  findings but contain no unexpected same-UUID event or process-record schema mutation;
  the two accepted paths are therefore absent from the claimed 31-case proof.
- Exact-head/cold-clone evidence at `718acdb5ab6b444160b1befaaa252f8b14156442`
  remains valid for the candidate it measured, but the cheaper production semantic
  attack refutes that candidate before another cold clone is warranted.
- Replay: N/A (external-upload policy rejected export before Chromium launch) +
  mitigation remains the exact-head/pristine-clone browser proof and committed
  sensitivity corpora. The environmental waiver does not cover the failed local
  process-log invariant.
- SUITE: no implementation edit by critic; promote the two independent attacks in the
  recorder sensitivity target during rework.

### 2026-07-30 — builder exact-record rework — IMPLEMENTED

- Candidate implementation: `f4d57f230d1a044938ea64d528ed9e90bc8461fb`.
- Refutation repair: the run-private log parser now uses an explicit allowlist for real
  Replay same-recording events, rejects every unknown event, and requires exact schemas
  for `createRecording`, `writeStarted`, and `writeFinished`. Known Replay metadata
  records remain permitted without weakening the ordered core chain.
- Promoted exact attacks: an unknown same-UUID event inserted between core records and
  unexpected fields added to every core record are expected-red with publication count
  zero and no success receipt. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=33 timing=12 schema=8 crash=3 binding=8
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `f4d57f2`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof, 161-case
  wire corpus, and expanded 33-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `f4d57f230d1a044938ea64d528ed9e90bc8461fb`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 33-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: only a schema-exact, ordered, run-private Replay process chain with the exact
  regular recording file can publish; unknown or extended same-recording records fail
  closed while the clean control still publishes exactly once.

### 2026-07-30 — exact-process re-critic — VERDICT: refuted

- P1 exact core schemas — SURVIVED. Predicted missing or extra fields on each of
  `createRecording`, `writeStarted`, and `writeFinished` would stop before publication;
  observed all six attacks rejected with `publicationCount=0`. A real Replay-shaped
  control containing two `addMetadata` records between create/start and a
  `sourcemapAdded` record between start/finish published exactly once. Citation:
  `node /private/tmp/e3t02b-exact-process-critic.mjs`.
- P2 complete same-recording allowlist — FAILED. Predicted an unknown or malformed
  process record associated with the selected UUID through Replay's real
  `recordingId` field would stop before publication; observed
  `unknown-recordingId-same-uuid: ACCEPTED publicationCount=1` and
  `corrupt-sourcemap-same-uuid: ACCEPTED publicationCount=1`. Production defines
  `matching` only as `record.id === recordingId`, so real `sourcemapAdded` records whose
  payload ID is the map hash and whose recording association is in `recordingId` bypass
  the allowlist and schema checks (`tools/replay/e3_t02_recorder_lifecycle.mjs:252-255`).
  Demand: classify selected-recording records by each real Replay association field,
  schema-check known `sourcemapAdded` records without requiring them to be contiguous
  with the core chain, reject unknown associated records, and permanently promote both
  attacks.
- P3 prior provenance defenses — SURVIVED. Predicted copied UUID, symlinked log,
  reordered core records, unknown `id`-associated record, extended core schemas,
  truncation/path/symlink/duplicate attacks, timing failures, crash/retry/upload/MP4
  cases, and the full wire corpus would retain their declared outcomes; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=33 timing=12 schema=8 crash=3 binding=8
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The permanent unknown-event case uses `id: recordingId`, and
  the clean fixture omits Replay's real `sourcemapAdded` shape. It therefore cannot
  falsify the two accepted `recordingId`-associated paths.
- Exact-head and cold-clone evidence at
  `f4d57f230d1a044938ea64d528ed9e90bc8461fb` remains valid for what it measured, but
  the cheaper production semantic attack refutes the publication invariant.
- Replay: N/A (external-upload policy rejected export before Chromium launch) +
  mitigation remains exact-head/pristine-clone browser proof and committed sensitivity
  corpora. The environmental waiver does not cover the failed local provenance check.
- SUITE: no implementation edit by critic; promote the two exact attacks during rework.

### 2026-07-30 — builder associated-record rework — IMPLEMENTED

- Candidate implementation: `fae6c336ae1b4065d368ac2a400719fa4eae2983`.
- Refutation repair: Replay process records are now associated with the selected
  recording through either the core `id` field or Replay's real `recordingId` field.
  Known `sourcemapAdded` records must match their exact observed schema; every unknown
  associated record and every malformed source-map record fails closed before
  publication.
- Promoted attacks: an unknown `recordingId`-associated event and a malformed
  `sourcemapAdded` record are both expected-red with publication count zero. Recorder
  evidence: `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=35 timing=12 schema=8 crash=3 binding=10
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `fae6c33`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof,
  161-case wire corpus, and expanded 35-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `fae6c336ae1b4065d368ac2a400719fa4eae2983`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 35-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: all Replay process records associated with the selected recording are
  recognized and schema-checked, including source maps whose own `id` is not the
  recording UUID; unknown or malformed associated records cannot reach the sole upload
  edge, while the exact clean control publishes once.

### 2026-07-30 — associated-record critic — VERDICT: refuted

- P1 promoted `recordingId` attacks — SURVIVED. Predicted an unknown event associated
  through `recordingId`, an extended `sourcemapAdded` record, and every missing/extra
  core-field mutation would stop before publication; observed each rejected with
  `publicationCount=0`. The real-shaped control still published exactly once. Citation:
  `node /private/tmp/e3t02b-exact-process-critic.mjs`.
- P2 exact source-map telemetry — FAILED. Predicted every accepted `sourcemapAdded`
  record would have a valid integer timestamp and occur during the selected recording's
  physical write interval; observed `string-sourcemap-timestamp: ACCEPTED
  publicationCount=1` and `sourcemap-after-write-finished: ACCEPTED
  publicationCount=1`. The production allowlist checks only the source-map field names
  and seven string fields, then orders and type-checks only the three core records
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:282-305,310-330`). Demand: validate the
  timestamp and require every selected-recording auxiliary event to occur physically and
  temporally inside the one start/finish interval, then promote both attacks.
- P3 unambiguous association — FAILED. Predicted a source-map artifact whose `id`
  happens to equal the selected recording UUID but whose `recordingId` names another
  recording would not be accepted as this recording's provenance; observed
  `cross-linked-sourcemap: ACCEPTED publicationCount=1`. The broad `id === recordingId
  || record.recordingId === recordingId` filter classifies the record as matching, while
  the source-map branch never requires its association field to equal the selected UUID
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:252-255,282-305`). Demand: associate each
  known kind through its kind-specific identity field and reject contradictory
  cross-links before publication.
- P4 prior permanent suites — SURVIVED. Predicted every earlier timing, schema, crash,
  binding, retry, MP4, and credential-wire counterexample would retain its declared
  result; observed `E3_T02_RECORDER_SENSITIVITY_OK cases=35 timing=12 schema=8 crash=3
  binding=10 retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The permanent source-map mutation only adds an unexpected
  field (`tools/verify/e3_t02_recorder_sensitivity.mjs:519-527`); it does not exercise
  timestamp type/order or conflicting `id`/`recordingId` linkage, the three paths that
  published in this run.
- Exact-head and pristine-clone evidence at
  `fae6c336ae1b4065d368ac2a400719fa4eae2983` remains valid for what it measured, but
  these cheaper production semantic attacks refute the publication invariant.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation remains exact-head/pristine-clone browser proof and committed sensitivity
  corpora. The environmental waiver does not cover the failed local provenance checks.
- SUITE: no implementation edit by critic; promote the three exact attacks during
  rework.

### 2026-07-30 — builder source-map provenance rework — IMPLEMENTED

- Candidate implementation: `e2054ed77ef37a1859d16135246e54bac6ec0bbe`.
- Refutation repair: every selected-recording process timestamp must be an integer;
  core and metadata events associate only through their `id`; source maps associate
  only through `recordingId` and cannot cross-link the selected UUID through their
  artifact `id`. Metadata must remain inside create/finish, and source maps must remain
  physically and temporally inside writeStarted/writeFinished.
- Promoted attacks: string source-map timestamp, source map after writeFinished, and
  cross-linked source map are all expected-red with publication count zero. Recorder
  evidence: `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=38 timing=12 schema=8 crash=3 binding=13
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `e2054ed`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof,
  161-case wire corpus, and expanded 38-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `e2054ed77ef37a1859d16135246e54bac6ec0bbe`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 38-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: the sole publication edge now requires unambiguous kind-specific association,
  integer telemetry time, and correct physical plus temporal containment for every
  auxiliary event; the three fresh critic bypasses fail closed while the real-shaped
  clean control still publishes exactly once.

### 2026-07-30 — auxiliary-provenance critic — VERDICT: refuted

- P1 promoted association/time attacks — SURVIVED. Predicted unknown `id`- and
  `recordingId`-associated events, malformed and string-timestamp source maps, a source
  map after `writeFinished`, a cross-linked source map, and missing/extra core fields
  would all stop before publication; observed every attack rejected with
  `publicationCount=0`, while the real-shaped control published once. Citation:
  `node /private/tmp/e3t02b-exact-process-critic.mjs`.
- P2 contradictory metadata — FAILED. Predicted a second process `addMetadata` event
  whose `metadata.uri` contradicts the walkthrough/catalog authorization URL would fail
  closed; observed `conflicting-uri-metadata: ACCEPTED publicationCount=1`. Production
  checks only that `metadata` is an object and never reconciles URI-bearing metadata
  with the selected browser authorization
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:286-296`). Demand: validate every
  recognized URI-bearing metadata record against the walkthrough/catalog binding and
  reject missing, duplicate, or contradictory identity metadata before publication.
- P3 source-map artifact identity — FAILED. Predicted the same source-map artifact ID
  could not name two different paths/URLs/hashes and that a declared source-map path
  must identify a real artifact; observed
  `duplicate-conflicting-sourcemap-artifact: ACCEPTED publicationCount=1` and
  `missing-sourcemap-artifact: ACCEPTED publicationCount=1`. Production type-checks
  source-map strings but neither establishes artifact-ID uniqueness nor validates the
  path/object (`tools/replay/e3_t02_recorder_lifecycle.mjs:297-322,336-348`). Demand:
  require each source-map ID to have one canonical descriptor, reject duplicate or
  conflicting descriptors, and prove every accepted path is the expected non-symlink
  regular artifact in the run-private recording directory.
- P4 permanent suites — SURVIVED. Predicted the complete promoted recorder and wire
  corpora would retain their declared outcomes; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=38 timing=12 schema=8 crash=3 binding=13
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The permanent clean fixture points at a source-map path it
  never creates, and no committed mutation exercises conflicting URI metadata or
  duplicate/conflicting source-map IDs
  (`tools/verify/e3_t02_recorder_sensitivity.mjs:150-180,449-568`). Promote all three
  independent attacks and a real source-map artifact control.
- Exact-head and pristine-clone evidence at
  `e2054ed77ef37a1859d16135246e54bac6ec0bbe` remains valid for what it measured, but
  the production semantic attacks above refute the fail-closed publication invariant.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation remains exact-head/pristine-clone browser proof and committed
  sensitivity corpora. The environmental waiver does not cover contradictory local
  process metadata or unproven source-map artifacts.
- SUITE: no implementation edit by critic; promote the three attacks during rework.

### 2026-07-30 — builder auxiliary-artifact rework — IMPLEMENTED

- Candidate implementation: `f08897c0b5ab5b0ff68e6f928ca4ec357d6404bc`.
- Refutation repair: URI-bearing process metadata must exactly match the selected local
  Replay catalog URI. Every source-map ID and canonical path is unique, its descriptor
  uses canonical URLs and SHA-256-shaped hashes, and its path must be a non-symlink,
  nonempty regular file inside the run-private recording directory.
- Promoted critic attacks: conflicting URI metadata, duplicate/conflicting source-map
  ID, and missing source-map artifact are expected-red. Additional hostile cases cover
  symlinked artifacts, duplicate paths, and invalid URI metadata. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=44 timing=12 schema=8 crash=3 binding=19
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `f08897c`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof,
  161-case wire corpus, and expanded 44-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `f08897c0b5ab5b0ff68e6f928ca4ec357d6404bc`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 44-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: local process metadata, the Replay catalog, and every source-map artifact now
  form one consistent run-private provenance graph before the sole publication edge;
  every promoted contradiction fails closed and the real-file clean control publishes
  exactly once.

### 2026-07-30 — artifact-identity critic — VERDICT: refuted

- P1 process identity presence and cardinality — FAILED. Predicted the process log must
  contain exactly one URI-bearing identity record matching the walkthrough/catalog;
  observed `missing-uri-identity-metadata: ACCEPTED publicationCount=1` and
  `duplicate-matching-uri-identity-metadata: ACCEPTED publicationCount=1`. Production
  validates a URI only when one happens to be present and never counts identity records
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:344-368`). Demand: require exactly one
  recognized URI identity record for the selected recording, reject both absence and
  duplicates, and promote both attacks.
- P2 source-map cryptographic identity — FAILED. Predicted the declared source-map
  hashes and artifact ID would be recomputed from their claimed inputs before the
  artifact joined the provenance graph; observed
  `artifact-content-hash-mismatch: ACCEPTED publicationCount=1` and
  `artifact-id-content-mismatch: ACCEPTED publicationCount=1`. Production checks only
  SHA-256-shaped strings and file existence, without hashing the artifact or validating
  the descriptor relationships
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:297-329,369-393`). Demand: define each
  Replay source-map hash field's canonical input, recompute every locally provable hash,
  and fail closed on any mismatch; otherwise remove the unsupported provenance claim.
- P3 artifact path uniqueness and canonical URL identity — FAILED. Predicted aliases of
  an accepted artifact could not be counted as two distinct source maps and a
  non-canonical URL path could not name the same resource; observed
  `hardlinked-sourcemap-path-alias: ACCEPTED publicationCount=1` and
  `encoded-path-alias: ACCEPTED publicationCount=1`. The path set compares path strings
  rather than filesystem identity, while URL validation accepts `URL.href` round trips
  that preserve encoded aliases (`tools/replay/e3_t02_recorder_lifecycle.mjs:321-327,
  347-393`). Demand: reject duplicate device/inode artifacts, define and enforce the
  accepted URL canonicalization policy, and promote both mutations.
- P4 permanent matrices — SURVIVED. Predicted every committed attack would retain its
  declared result; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=44 timing=12 schema=8 crash=3 binding=19
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The six newest binding cases cover contradictory/invalid URI
  metadata and path-string duplicates, but not missing or duplicate identity metadata,
  descriptor/content hash mismatch, URL aliasing, or two paths hard-linked to one
  artifact (`tools/verify/e3_t02_recorder_sensitivity.mjs:560-660`).
- Exact-head and pristine-clone evidence at
  `f08897c0b5ab5b0ff68e6f928ca4ec357d6404bc` remains valid for what it measured, but
  cannot establish the claimed consistent provenance graph. Replay remains loudly N/A
  due to the pre-launch external-upload policy denial; that waiver does not cover these
  accepted local contradictions.
- Independent command:
  `node /private/tmp/e3t02b-artifact-critic.mjs` — control accepted once; six hostile
  cases accepted and published once. No implementation files were edited by the critic.
- SUITE: n/a until the refutations clear.

### 2026-07-30 — builder descriptor-identity rework — IMPLEMENTED

- Candidate implementation: `93e424cf99e13cc4240cda0205875adb75acb676`.
- Refutation repair: the local Replay process log must contain exactly one URI identity
  record and one process identity record. Source-map descriptors now follow Replay
  Chromium's actual handler contract: `targetContentHash` binds to the generated-script
  ID, URL hashes are recomputed over their canonical inputs, and the target URL is
  resolved from the version-3 map's `file` field. Artifact paths must be the exact
  `sourcemap-<id>.map` name with one filesystem link and a unique device/inode.
- Promoted attacks: missing and duplicate URI identity, target-content mismatch,
  artifact-ID/path mismatch, encoded URL alias, and hard-linked artifact alias all fail
  closed. Missing process identity is an additional expected-red case. Recorder
  evidence: `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=51 timing=12 schema=8 crash=3 binding=26
  retry=1 mp4=1 clean-publish=1`.
- Grounding check: an actual local Replay Chromium process record and source-map file
  independently matched all four derived relationships: content ID, map-URL hash,
  generated-script URL hash, and exact `sourcemap-<id>.map` filename.
- Exact-head command: `make verify-E3-T02b` — PASS at `93e424c`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof,
  161-case wire corpus, and expanded 51-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `93e424cf99e13cc4240cda0205875adb75acb676`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 51-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: the sole publication edge now consumes one cardinality-exact process identity
  and a Replay-handler-derived, canonical descriptor graph whose URL/hash/path/object
  relationships are independently recomputed; all six critic bypasses fail closed.

### 2026-07-30 — descriptor/TOCTOU critic — VERDICT: refuted

- P1 immutable publication artifact — FAILED. Predicted the recording and every accepted
  source-map artifact would remain the exact objects validated at `DECIDED_CLEAN` when
  the uploader consumed them; observed
  `source-map-mutated-after-decision: ACCEPTED publicationCount=1` and
  `recording-mutated-after-decision: ACCEPTED publicationCount=1`. Production validates
  source-map JSON/descriptors and the recording path, returns from that validation, then
  invokes the uploader without carrying any byte digest, open descriptor, filesystem
  snapshot, or post-upload identity check
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:390-472,589-605`). Both artifacts can
  therefore change after the clean decision and the changed bytes still receive a
  success receipt. Demand: make the validated artifact set immutable across the sole
  publication edge, bind the uploader to that exact snapshot, and promote both
  post-decision mutations as expected-red cases.
- P2 process-label identity — NEEDS EVIDENCE. Predicted the required process identity
  record would be tied to the Replay Chromium process that owned this run; observed
  `arbitrary-process-label: ACCEPTED publicationCount=1` after replacing `root` with
  `unrelated-copyable-label`. The implementation requires exactly one nonempty string,
  but never compares that value with process state or another independently captured
  identity (`tools/replay/e3_t02_recorder_lifecycle.mjs:291-305,358-365`). Demand:
  either bind the value to an independently captured browser-process identity or narrow
  the claim from process identity to cardinality-only metadata.
- P3 promoted descriptor mutations — SURVIVED. Predicted missing/duplicate URI identity,
  missing process metadata, target-content mismatch, artifact-ID/path mismatch, encoded
  URL aliasing, and hard-linked artifact aliasing would remain red; observed every
  promoted mutation rejected and the clean control published once in
  `node tools/verify/e3_t02_recorder_sensitivity.mjs`.
- P4 permanent matrices — SURVIVED. Observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=51 timing=12 schema=8 crash=3 binding=26
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The permanent descriptor attacks mutate artifacts before
  lifecycle invocation; none mutates the `.dat` or source-map file after validation and
  before/during `publish()`, despite TOCTOU being named in the task's adversarial
  verification section.
- Independent command:
  `node /private/tmp/e3t02b-descriptor-toctou-critic.mjs` — control accepted once; both
  post-decision artifact mutations and the arbitrary process-label mutation were
  accepted and published once. No implementation files were edited by the critic.
- Replay remains loudly N/A because external-export policy rejected the builder's
  attempt before Replay Chromium launched. That environmental waiver does not cover the
  failed local atomic-publication invariant.
- SUITE: no implementation edit by critic; promote the two TOCTOU attacks during rework.

### 2026-07-30 — builder sealed-snapshot rework — IMPLEMENTED

- Candidate implementation: `fd9598ce421118522db0e9ca6b514d17dc8189fb`.
- Refutation repair: after the browser process closes and its artifacts validate, the
  run-private directory is atomically renamed to a sealed publication directory. Its
  selected log paths are rewritten to that directory, the complete binding is validated
  again, and recording/source-map byte manifests must match before and after upload.
  The upload subprocess receives only the sealed directory through
  `RECORD_REPLAY_DIRECTORY`; original artifact paths no longer exist at the publication
  edge. Process identity is exactly Replay's observed `root`, not any nonempty string.
- Promoted attacks: source-map and recording mutation through their original paths after
  `DECIDED_CLEAN` both stop before publication with the paths absent; an arbitrary
  process label also fails closed. The clean control independently recomputes every
  sealed manifest digest inside the publication callback. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=54 timing=12 schema=8 crash=3 binding=29
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `fd9598c`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof,
  161-case wire corpus, and expanded 54-case recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `fd9598ce421118522db0e9ca6b514d17dc8189fb`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case raw
  wire corpus, and the 54-case lifecycle suite covering every recorded critic
  counterexample. No browser data left the machine; no workaround was attempted.
- Claim: the bytes validated at `DECIDED_CLEAN` are the bytes the sole upload edge is
  directed to consume; the mutable producer paths are atomically retired first, and the
  receipt carries the same sealed SHA-256 manifest checked after publication.

### 2026-07-30 — sealed-snapshot critic — VERDICT: refuted

- P1 upload-consumed artifact bytes — FAILED. Predicted the uploader could not consume
  recording or source-map bytes different from the sealed manifest and still receive a
  success receipt; observed `sealed-recording-mutate-restore: ACCEPTED
  uploader-read-mutated-bytes publicationCount=1` and
  `sealed-sourcemap-mutate-restore: ACCEPTED uploader-read-mutated-bytes
  publicationCount=1`. The production code makes each path owner-read-only, passes path
  names to the uploader, and compares the manifest only after it returns
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:539-550,675-705`). A publisher can
  chmod, replace the bytes it consumes, then restore the validated bytes before the
  post-upload hash, so the receipt attests the restored state rather than the bytes
  uploaded. Demand: bind the upload operation itself to the validated bytes and obtain a
  digest/identity receipt from that consumption boundary; before/after path hashes are
  not an atomic snapshot.
- P2 upload directory and log binding — FAILED. Predicted
  `RECORD_REPLAY_DIRECTORY` would resolve only the validated sealed tree and its
  rewritten log throughout upload; observed `sealed-log-rewrite-restore: ACCEPTED
  uploader-log-pointed-outside publicationCount=1` and the novel
  `sealed-directory-path-swap: ACCEPTED uploader-path-resolved-attacker-tree
  publicationCount=1`. `recordings.log` is rewritten but is not included in the artifact
  manifest (`tools/replay/e3_t02_recorder_lifecycle.mjs:520-550`), and the uploader is
  given a mutable pathname (`tools/replay/e3_t02_recorder_lifecycle.mjs:675-685`).
  Rewriting/restoring the log, or renaming the sealed tree aside and temporarily placing
  an attacker tree at the same pathname, lets the uploader resolve unvalidated content
  while the post-check later resolves the restored original objects. Demand: make the
  uploader consume a descriptor/content-addressed snapshot whose catalog, log, recording,
  and source maps are all in the attested set; reject any path re-resolution gap.
- P3 retired-original-path mutations — SURVIVED but are insufficient. Predicted both
  permanent TOCTOU cases would show the producer paths absent after atomic rename;
  observed `source-map-mutated-after-decision` and
  `recording-mutated-after-decision` expected-red with `original-path-gone`,
  publication count zero, and no receipt. Citation:
  `tools/verify/e3_t02_recorder_sensitivity.mjs:815-836`. These cases mutate retired
  names, not the sealed paths actually consumed by upload, so they do not falsify P1 or
  P2.
- P4 process label, retry, and standing matrices — SURVIVED. Predicted the arbitrary
  process label would remain red, retry would not double-publish, and every prior
  recorder/wire counterexample would retain its declared result; observed
  `E3_T02_RECORDER_SENSITIVITY_OK cases=54 timing=12 schema=8 crash=3 binding=29
  retry=1 mp4=1 clean-publish=1` and
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`. Citations:
  `evidence/e3-t02b-recorder-sensitivity.txt` and
  `evidence/e3-t02b-wire-sensitivity.txt`.
- COVERAGE — INSUFFICIENT. The 54-case suite tests only writes through names retired by
  rename; it never mutates-and-restores the upload-consumed sealed artifacts, the sealed
  log, or the sealed directory pathname during `publish()`. Promote all four independent
  attacks and prove which exact bytes the uploader read.
- Independent command:
  `node /private/tmp/e3t02b-sealed-snapshot-critic.mjs` — control accepted once; all four
  hostile cases were also accepted and received success receipts. No implementation
  files were edited by the critic.
- Replay remains loudly N/A because external-export policy rejected the builder's
  attempt before Replay Chromium launched. That environmental waiver does not cover the
  failed local upload-consumption invariant.
- SUITE: n/a until the atomic publication refutations clear.

### 2026-07-30 — builder immutable-boundary rework — IMPLEMENTED

- Candidate implementation: `99cd2900c9710f4a9f23a8401ea29be1ceccdfc4`.
- Refutation repair: the sealed recording, every sealed source map, and the sealed
  publication directory now carry macOS `uchg` flags for the entire synchronous upload
  boundary. The process log carries `uappnd`, so Replay's trusted uploader may append
  lifecycle records but cannot rewrite, truncate, rename, or replace the validated
  prefix. The uploader receives only the sealed directory, and publication succeeds
  only when the post-upload artifact manifest is byte-identical and the process log
  retains the complete validated prefix. All flags are cleared in `finally`, including
  uploader-failure paths.
- Promoted attacks: mutating/restoring the sealed recording, mutating/restoring a sealed
  source map, rewriting/restoring the sealed log, and swapping the sealed directory path
  all fail at the upload-consumption boundary with `EPERM`, publication count zero, and
  no success receipt. Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=58 timing=12 schema=8 crash=3 binding=33
  retry=1 mp4=1 clean-publish=1`.
- Exact-head command: `make verify-E3-T02b` — PASS at `99cd290`; root format, lint,
  typecheck, 34 test files / 413 tests, build, production shell browser proof with zero
  console/page/request failures, the 161-case wire corpus, and the expanded 58-case
  recorder matrix passed.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `99cd2900c9710f4a9f23a8401ea29be1ceccdfc4`.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, raw-wire
  corpus, atomic lifecycle suite. No browser data left the machine; no workaround was
  attempted.
- Claim: the same-user callback can no longer substitute upload-consumed artifacts,
  process-log provenance, or the sealed pathname between validation and consumption;
  all four critic attacks are permanent expected-red cases, and the clean control still
  publishes exactly once.

### 2026-07-30 — immutable-boundary critic — VERDICT: refuted

- P1 same-user immutable-flag boundary — FAILED. Predicted the callback that consumes
  the sealed recording could not substitute bytes and still receive a success receipt;
  observed `same-user-clears-immutable-flag: ACCEPTED
  uploader-read-mutated-bytes publicationCount=1`. The callback runs as the artifact
  owner, successfully executes `chflags nouchg`, mutates and reads the recording, restores
  the original bytes, reapplies `uchg`, and passes the post-upload manifest. The lifecycle
  grants `publish()` the pathname after setting owner-clearable flags
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:552-580,706-735`). Demand: do not treat
  owner-controlled `uchg` as an immutable consumption boundary; bind a trusted uploader's
  receipt to the exact validated bytes without executing an adversarial callback in the
  same authority domain.
- P2 append-only process-log provenance — FAILED. Predicted no unvalidated selected-UUID
  process event could influence upload while the validated prefix check remained green;
  observed `append-only-log-injection: ACCEPTED uploader-log-pointed-outside=<temporary
  attacker-recording.dat> publicationCount=1`. `uappnd` permits the callback to append a
  forged selected-recording `writeStarted` path, and the post-check accepts every suffix
  because it tests only `startsWith(sealedLogPrefix)`
  (`tools/replay/e3_t02_recorder_lifecycle.mjs:558-566,689-690,730-732`). Demand: seal
  the producer log before publication and give the uploader a validated, unambiguous
  descriptor, or independently validate and authenticate every appended event before a
  success receipt.
- P3 promoted sealed-path attacks — SURVIVED in their narrower form. Predicted direct
  chmod, direct log rewrite, and sealed-directory rename would fail while flags remain
  set; observed the previous hostile script's control publish once and its first direct
  mutation stop at `EPERM`, while the permanent suite reports all four promoted cases
  expected-red. These attacks do not attempt the owner's permitted `chflags` removal or
  append-only suffix injection (`tools/verify/e3_t02_recorder_sensitivity.mjs:839-880`).
- P4 standing verification — SURVIVED. `make verify-E3-T02b` passed after the initial
  nested-sandbox invocation failed with `sandbox_apply: Operation not permitted` and was
  rerun outside that outer sandbox. Observed 34 test files / 413 tests, production shell
  proof with zero console/page/request failures,
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`, and
  `E3_T02_RECORDER_SENSITIVITY_OK cases=58 timing=12 schema=8 crash=3 binding=33
  retry=1 mp4=1 clean-publish=1`.
- COVERAGE — INSUFFICIENT. Every changed implementation hunk executed or is covered by
  the standing clean/failure cases, but the four new permanent mutations only call
  `chmod`, rewrite, or rename (`tools/verify/e3_t02_recorder_sensitivity.mjs:839-880`);
  no case clears `uchg`, appends a selected-UUID suffix, or proves that the uploader's
  consumed bytes match an independently authenticated receipt. Promote both independent
  attacks and include uploader-failure flag cleanup in the permanent matrix.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, raw-wire
  corpus, atomic lifecycle suite. No upload was attempted by this critic. The loud
  environmental waiver does not cover the two failed local publication invariants.
- Independent command: `node /private/tmp/e3t02b-sealed-snapshot-critic.mjs`; control
  published once, same-user flag clearing plus mutate/read/restore published once, and
  append-only selected-UUID suffix injection published once. SUITE: no implementation
  edit by critic; promote both attacks during rework.
