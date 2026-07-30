---
id: E3-T02b
epic: 3
title: "Browser evidence hardening: full-wire credential scanner and atomic Replay publication"
priority: 302.1
status: implemented
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
