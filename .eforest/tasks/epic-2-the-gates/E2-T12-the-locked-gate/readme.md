---
id: E2-T12
epic: 2
title: "Capstone: the local-only locked gate on Auth0, the platform gateway, and Electric Durable Streams"
priority: 212
status: verified
verification_run_ceiling: 4
verification_recovery_base_run: 1
verification_resume_commit: 1e730e786a25aace38848d1470c5efb61e0a9203
verification_invalid_loop_commit: b3a0349bfc145354ad67d24a518d4025d6a71efa
depends_on: [E2-T11]
estimate: L
capstone: true
---

## Goal

From a cold clone, the capstone starts the pinned `blamy/emulate` Auth0 service, the
electric-forest platform gateway, and Electric's published local Durable Streams server.
Playwright completes Auth0 authorization-code+PKCE login, mints a CLI token, performs an
authorized application dispatch, then proves the equivalent tokenless request is refused
without changing the stream.

The proof is intentionally local-only: it uses the pinned Auth0 emulator and Electric's
published `DurableStreamTestServer`. No fork, custom transport implementation, copied
Durable Streams protocol, or direct browser access to the stream origin is permitted.

## Deliverables

- `make verify-E2-T12` / `verify-E2-capstone` cold-start orchestration.
- One browser walkthrough recorded under Replay Chromium with its matching verified MP4.
- A CLI leg using a minted, revocable token through `POST /api/dispatch`.
- Before/after official stream dumps, application digests, and refusal transcript.
- A local configuration check proving the unchanged application entrypoint can target a
  second fresh published `DurableStreamTestServer` instance without code changes.

## Acceptance criteria

- [x] A fresh browser logs in through the pinned Auth0 emulator using real pointer and
      keyboard input with zero console errors and zero non-loopback external requests.
- [x] The authenticated browser session mints a CLI token whose issuance is present on
      the identity stream.
- [x] The CLI's authorized dispatch appends exactly one application event through the
      platform gateway and the reduced digest changes as expected.
- [x] The tokenless and revoked-token versions return the typed refusal and leave the
      stream byte-identical.
- [x] The platform reaches a real `DurableStreamTestServer` via
      `@durable-streams/client`; no product package imports emulator internals or
      implements Durable Streams protocol behavior.
- [x] The Replay URL, MP4 path, event-log offsets, and digests are recorded in the
      verification claim.

## Adversarial verification

1. Run from a pristine clone with the submodule initialized and all service state empty.
2. Compare the Replay network timeline with stream dumps so the authorized append and
   refused append are both anchored.
3. Swap the server URL to a second fresh local `DurableStreamTestServer` using only
   configuration; any application code-path divergence refutes the local wiring proof.
4. Search production dependencies for emulator internals, copied Durable Streams code,
   or direct browser access to the stream origin.

## Verification log

(appended by builder and critic)

### 2026-07-27 — builder — implemented

- Proof commit:
  `36651cfbe1f5d78d4aec471b7a851c90530491cf`.
- Gates:
  `pnpm format:check && pnpm lint`; `pnpm typecheck`; `pnpm test` (31 files,
  406 tests); `pnpm build`; `make verify-E2-T12`; `make verify-E2-capstone`;
  and `tools/verify/cold_clone.sh verify-E2-T12`. Both named targets passed,
  and the last command reported `cold_clone: verify-E2-T12 PASSED from a
pristine clone` of the exact proof commit with pinned `vendor/emulate`
  commit `82eb835947c97fcf6e0596a4377acbb01ca13ede`.
- Replay:
  [recording 6a201545-75e0-4d13-a968-a53f8ce970d5](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5),
  uploaded explicitly with
  `replayio upload 6a201545-75e0-4d13-a968-a53f8ce970d5`.
  Matching video:
  `/private/tmp/electric-forest-e2-t12/recordings/e2-t12-final.mp4`
  (verified H.264 MP4, 1280x720, 30 fps, 31.9 seconds, 572833 bytes).
  Browser interrogation reported zero console errors, zero warnings, and
  zero non-loopback requests.
- Lifecycle compatibility: this repository's `"type": "module"` makes Node
  interpret the vendored CommonJS lifecycle `.js` files as ESM. The final
  session therefore ran byte-identical temporary `.cjs` copies of
  `browser-open.js` (SHA-256
  `6e9d9ad00b984fa663e270e4a0bfefbd490b23819a4e2ac6bd0beb65cde947b2`)
  and `browser-close.js` (SHA-256
  `016416fbab0d2d5188410174a3144c5e3ae47d24a3b9a2abb5137a253cd9357e`).
  The Playwright run-code isolate also required a temporary runner with the
  trailing statement semicolon removed, macOS `Meta+A` selected explicitly,
  and URL parsing evaluated in the page. These were orchestration-only
  compatibility adaptations; the browser executed the committed proof
  server and product bundles at the proof commit.
- Stream evidence:
  `evidence/e2-t12-before.raw.json`,
  `evidence/e2-t12-after.raw.json`,
  `evidence/e2-t12-after.jsonl`, and
  `evidence/e2-t12-capstone.json`. Before: offset
  `0000000000000000_0000000000000000`, digest
  `f62a9e9bbd5f0f2c93cf41922fbb8c05c63f5028b2d339d32d2d60481f1bd80f`.
  Authorized CLI dispatch: exactly one event, offset
  `0000000000000000_0000000000000204`, digest
  `0f7709f1e8a6db71898da6c96076dac4110d93d979ec1b932cd019a1a15dbe2c`.
  The grant issuance is anchored at identity offset
  `0000000000000000_0000000000000002`; revocation is anchored at identity
  offset `0000000000000000_0000000000000005`. The tokenless request returned
  HTTP 401 and the revoked CLI invocation returned exit 13; both left the
  target bytes identical to the authorized after-state.
- Portability:
  `E2_T12_PORTABILITY_OK` confirmed
  `packages/platform/src/bin.ts -> createPlatformProductionRuntime`,
  real Auth0/Electric deployment hosts, published
  `@durable-streams/client@^0.2.6` and
  `@durable-streams/server@^0.3.7`, and zero emulator product imports,
  custom platform transports, or code-path divergence.

The recording demonstrates the complete locked-gate path in one browser
session: a fresh Auth0 authorization-code+PKCE login, web-session CLI-token
mint, successful built-CLI dispatch of exactly one application event, typed
byte-neutral tokenless refusal, grant revocation in the web app, and typed
byte-neutral revoked-token refusal. The DOM proof state binds the session to
the immutable proof commit and exposes the cited stream offsets and digest.

### 2026-07-27 — critic — VERDICT: refuted

- P1 production portability — FAILED. Predicted the committed production
  endpoints were real and could run the same production entrypoint against an
  Electric Cloud test project by configuration alone. The first command failed
  TLS with `tlsv1 unrecognized name`; the second returned HTTP 404:

  ```sh
  curl -I --max-time 10 https://electric-forest.electric.run/
  curl -sS --max-time 10 -D - https://electric-forest.us.auth0.com/.well-known/openid-configuration -o /dev/null
  ```

  `deploy/platform.production.env.example:3-7`;
  `tools/verify/e2_t12_portability.mjs:26-77`.

- P2 portability coverage — FAILED. `verify-E2-T12` runs its entire inner
  closure in the loopback-only sandbox, while its portability verifier checks
  only hostname suffixes, source regexes, and package declarations. The target
  therefore cannot execute adversarial attack 3 or prove the claimed live
  Auth0/Electric behavior. `Makefile:200-204,313-321`;
  `readme.md:30-31,54-55`.
- Replay runtime — SATISFIED. The independent Replay critic found zero console
  messages, exceptions, failed requests, or non-loopback requests, and
  confirmed [PKCE login](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=6814889626834203915338216644804745&time=21494),
  [exactly one token-backed dispatch](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=49651338709766496992410088129955071&time=36034),
  [byte-neutral tokenless 401](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=53870079907328273037859521432651112&time=37509),
  [byte-neutral revoked exit 13](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=57764302551235212554091144436254254&time=38756),
  and [final DOM/runtime integrity](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=69122451929309450644462628354654221&time=98818.26804123711).
- P3 stream evidence — PASSED. Independent replay of
  `evidence/e2-t12-after.jsonl` produced the claimed digest
  `0f7709f1e8a6db71898da6c96076dac4110d93d979ec1b932cd019a1a15dbe2c`;
  the raw before/after and JSONL SHA-256 values matched the transcript.
- P4 import boundary — PASSED. Independent source searches found no product
  import of `vendor/emulate` or `@emulators/auth0`;
  `@durable-streams/client` remains behind `@eforest/client`, and only
  `packages/server/src/upstream.ts` wraps the published test server.
- P5 sensitivity — PASSED. In a disposable worktree, deleting `actor` from the
  reducer changed the digest from `0f7709…be2c` to `afa09a…d4a9`, so the
  equality gate exited 1; a malformed `gate.opened` v2 input was also rejected.
- Cold clone — INCOMPLETE in this critic session. After hydrating pinned
  `vendor/emulate` at `82eb835947c97fcf6e0596a4377acbb01ca13ede`, the
  exact-head run passed the root gates and advanced into inherited sensitivity
  checks, but was interrupted before its final marker; the builder's prior
  exact-head pass does not cure P1/P2.
- SUITE: retain the stream golden and reducer sensitivity. Promote a separate,
  allowlisted portability target that uses provisioned Auth0 and Electric Cloud
  test endpoints with the unchanged `createPlatformProductionRuntime`
  entrypoint and proves create/append/read/digest behavior.

Demand: replace the placeholder endpoints with provisioned test services,
record a configuration-only Electric Cloud/Auth0 run through the unchanged
production entrypoint, then rerun the complete exact-head proof and critic
review.

### 2026-07-27 — loop — `invalid_loop`

- The human accepted the passing local Playwright behavior and asked the queue
  to continue, describing the remaining failure as a Replay bug. The uploaded
  Replay itself is not the failure: its independent critic verdict was
  `satisfied`.
- The surviving refutation is the mandatory configuration-only production
  portability attack. The committed Electric hostname fails TLS, the Auth0
  discovery endpoint returns 404, and no provisioned Electric Cloud service or
  Auth0 tenant/client is available to replace them.
- Advancing on the local Playwright result would remove or waive adversarial
  attack 3 after it failed. Under `.eforest/loop.md`, a gate that can become
  green only by weakening it requires a project-level `invalid_loop` stop.
- Resume requires a human-chosen scope change or provisioned services, recorded
  explicitly without relabeling the run-1 refutation. E2-T12 remains the only
  queue gate; Epic 3 stays locked.

### 2026-07-27 — judge round 1 — VERDICT: refuted

- The run-1 critic refutation above is preserved: the then-current task required
  a live Electric Cloud/Auth0 configuration-only proof, but its committed
  endpoints were invalid and the loopback verifier could not execute that
  attack.
- The local Playwright, uploaded Replay, stream digest, refusal-neutrality,
  import-boundary, and sensitivity evidence all passed. They did not satisfy
  the live-cloud requirement that existed during run 1.
- SUITE: retain the local stream golden, reducer sensitivity, loopback network
  sandbox, and independently satisfied Replay recording for the revised
  local-only proof.

### 2026-07-27 — human scope decision

- Authorization: APPROVED
- Task: E2-T12
- Decision: make the capstone local-only and remove the live-cloud portability
  requirement.
- Evidence policy: passing Playwright plus the existing independently satisfied
  Replay and deterministic stream evidence is sufficient for the unchanged
  browser flow.
- Constraint: preserve the run-1 refutation and reopen only E2-T12; do not
  advance the queue until a fresh critic verifies the revised contract.

### 2026-07-27 — loop — recovery transition rejected

- Two fresh readers rejected recovery commit
  `2606043f0fb3de428513dd244c92bb6972a623c7`: the original invalid-loop
  commit's legacy `critic` heading parsed as zero official runs, while the
  canonical `judge round 1` entry became visible only in its control child.
- No builder work began. The project returns to `invalid_loop` at a new stopped
  commit whose canonical ledger contains the preserved run-1 refutation.
- The approved local-only scope remains unchanged. A new direct control/resume
  pair must bind its recovery base to this corrected stopped commit before run
  2 starts.

### 2026-07-27 — recovery control bridge

- Frozen stop: `4505e50` with project `invalid_loop` and one canonical
  refuted verification run.
- Human authorization: the local-only scope decision above authorizes runs 2–4
  on E2-T12 only.
- This control-only bridge leaves the project stopped and changes no product,
  verifier, evidence, verdict, or queue status. Its direct child may perform the
  bounded lifecycle resume.

### 2026-07-27 — loop — control-bridge transition rejected

- Two fresh readers rejected recovery commit `40ce01d`: its declared control
  bridge changed the stopped E2-T12 readme, while the attester permits that
  bridge form to change only the exact recovery-control path set.
- No builder work began. The local-only scope and canonical run-1 refutation
  remain preserved at this new `invalid_loop` stop.
- Recovery will use the legacy exact lifecycle path set instead: task, project,
  generated queue, `AGENTS.md`, and `.eforest/loop.md`, followed by a commit
  pinning the direct-child resume OID.

### 2026-07-27 — human resume — RUNS 2-4 authorized

- Authorization: APPROVED
- Task: E2-T12
- Stopped after run: 1
- Authorized runs: 2-4
- Scope: control-plane recovery transition and E2-T12 verification only

### 2026-07-27 — builder verification run 2 — implemented

- Recovery lineage: resumed from attested source
  `223503a7dc5d4552e14c8c760d2fdebd515f846e` with recovery snapshot
  SHA-256
  `6c6d4e0151cddd84d4c66e5ad3be061baafe865ad3b885f812fc70288e4a6133`.
  The project is `building`, the canonical recovery base is run 1, and the
  human-authorized window is runs 2–4. This entry consumes verification run 2
  only; the preserved run-1 refutation remains authoritative for its former
  live-cloud contract.
- Immutable proof commit:
  `8fadd862428ce9dd4c4b496783ad3edea6ab54fc`.
- Local configuration proof:
  `evidence/e2-t12-local-config.json` (SHA-256
  `3407cd65a425b9f060f110a24a7afc8829bdcc83917b87dd757302bb1fb7281c`).
  The unchanged built `createPlatformProductionRuntime` entrypoint targeted
  two separate fresh published `DurableStreamTestServer` instances using only
  distinct loopback `EFOREST_SERVER_URL` values. Both instances performed the
  same official create/append/read path, emitted byte-identical identity
  events and request shapes, and reduced to offset
  `0000000000000000_0000000000000385` with digest
  `8138d8ecd351bb9a54ba12341b2d3a9e74f9ab9d4aaf359ee6b002fccdbebdd8`.
  The verifier reported request-shape SHA-256
  `d358aeb5ab24249b45f36d10d11ef39175316b0ab91ada08230019fe63a604bb`,
  event-bytes SHA-256
  `64ec99640d06eb7dcd8d69abbfd42935400c26b3049af9d81856957e628ff905`,
  zero code-path divergence, zero cross-instance or non-loopback requests,
  zero emulator product imports, zero custom platform transport, zero copied
  protocol, and zero direct browser-to-stream access. The invalid invented
  live-cloud environment example was deleted.
- Gates: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`
  (31 files, 406 tests); `pnpm build`; `make verify-E2-T12`; and
  `make verify-E2-capstone` all passed. The capstone ended with
  `verify-E2-capstone: OK` after re-earning the E2-T07–T11 suites and their
  sensitivity attacks.
- Exact-head portability: `tools/verify/cold_clone.sh verify-E2-T12` cloned
  `8fadd862428ce9dd4c4b496783ad3edea6ab54fc`, initialized pinned
  `vendor/emulate` commit
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, scrubbed the environment,
  hydrated dependencies from the lockfile-verified pnpm store, ran the full
  registered target, and ended with both `verify-E2-T12: OK` and
  `cold_clone: verify-E2-T12 PASSED from a pristine clone`.
- Browser and stream proof: the browser-reaching product and proof-server code
  did not change between the independently satisfied run-1 recording and this
  proof commit; this run changes only the non-browser portability verifier,
  its deterministic evidence/allowlist, and removal of the invalid deployment
  example. Therefore the human-approved evidence policy permits reuse of
  [Replay 6a201545-75e0-4d13-a968-a53f8ce970d5](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5)
  plus matching
  `/private/tmp/electric-forest-e2-t12/recordings/e2-t12-final.mp4`
  (verified H.264, 1280x720, 31.9 seconds, 572833 bytes; SHA-256
  `17cb389c09dba47d704b443998f86c5d324c756ee6193159fd73b81777d50d9b`).
  The unchanged Playwright proof was nevertheless rerun by every named target
  and the cold clone: before offset
  `0000000000000000_0000000000000000`, digest
  `f62a9e9bbd5f0f2c93cf41922fbb8c05c63f5028b2d339d32d2d60481f1bd80f`;
  authorized after offset `0000000000000000_0000000000000204`,
  digest
  `0f7709f1e8a6db71898da6c96076dac4110d93d979ec1b932cd019a1a15dbe2c`;
  zero console errors and zero non-loopback requests. Replay: reused under the
  explicit human scope decision because no browser-reaching code changed;
  mitigation is the rerun Playwright/stream proof plus the independently
  satisfied uploaded recording.

The run-2 evidence demonstrates the revised local-only locked gate end to end:
the existing Replay proves the unchanged Auth0 PKCE, token mint, authorized
append, byte-neutral refusal, revocation, and browser integrity path, while the
new deterministic stream-layer golden proves the unchanged production runtime
can select either of two fresh published local Durable Streams servers by URL
configuration alone with exact create/append/read/digest parity and no product
code-path divergence.

### 2026-07-27 — judge round 2 — VERDICT: verified

- P1 dual-server configuration parity — PASSED. Independent replay of
  `tools/verify/e2_t12_portability.mjs` reproduced the committed golden:
  two fresh published `DurableStreamTestServer` instances, 22 requests each,
  `PUT`/`POST`/`GET`/`HEAD`, event SHA-256 `64ec9964…905`, request-shape
  SHA-256 `d358aeb5…04bb`, offset `…0385`, digest `8138d8ec…dd8`, zero
  cross-instance requests, and zero non-loopback requests.
- P2 independent inputs — PASSED. A disposable exact-head run changed the
  subject, email, session, time, TTL, and operation id, and used the same
  deterministic seed 47 for both instances. Generation plus non-update replay
  agreed at event SHA-256 `ebd058ea…51dd`, offset `…0402`, digest
  `d909c9ff…c4fb`; a strengthened method/path/header/body-shape comparison
  agreed at SHA-256 `2b9cb7c8…e563`.
- P3 configuration-only path — PASSED. The committed seeds 11 and 29 are
  unused by this identity-store path; the equal-seed independent run proves
  they do not mask code-path divergence. The production environment changes
  only `EFOREST_SERVER_URL`.
- P4 published boundary — PASSED. `createPlatformProductionRuntime` composes
  the configured `OfficialStreamAdapter` and identity store through
  `@durable-streams/client@^0.2.6`; the local server boundary is only the
  published `@durable-streams/server@^0.3.7` test server.
- P5 forbidden-path hunt — PASSED. Repository-wide product/app searches found
  zero emulator imports, custom Durable Streams transport, copied protocol,
  or direct browser access to the stream origin. The verifier's literal
  boundary counters were independently substantiated by this broader audit.
- P6 sabotage — PASSED. Changing only server B's email made the parity
  assertion exit 1 with different event hashes, offsets, and digests
  (`d909c9ff…c4fb` versus `3b68475d…e050`).
- P7 coverage — PASSED. Every executable changed verifier path ran, including
  the golden-update branch; the committed golden was byte-compared, the
  derived E2-T08 allowlist entry executed, and the deleted invalid cloud
  example is non-executable. No production or browser code changed.
- Cold-clone — SATISFIED proportionately. The builder's registered pristine
  exact-head run at `8fadd862428ce9dd4c4b496783ad3edea6ab54fc` passed.
  The critic independently hydrated the pinned submodule and frozen lockfile
  at that detached head, built, replayed the focused dual-server target with
  independent inputs, and ran sabotage. A duplicate full cold-clone advanced
  through the root gates into inherited E2-T08 sensitivity before being
  intentionally stopped; it is not credited as a second full pass.
- Replay — SATISFIED by the separate fresh Replay critic under the explicit
  human reuse waiver: [PKCE login](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=6814889626834203915338216644804745&time=21494),
  [one token-backed dispatch](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=49651338709766496992410088129955071&time=36034),
  [byte-neutral tokenless 401](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=53870079907328273037859521432651112&time=37509),
  [byte-neutral revoked exit 13](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=57764302551235212554091144436254254&time=38756),
  and [final runtime integrity](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5?point=69122451929309450644462628354654221&time=98818.26804123711).
- SUITE: retain `e2-t12-local-config.json` and the parity sabotage. Recommended
  hardening: share one deterministic dependency object across both scenarios,
  hash normalized request headers in the permanent golden, and derive boundary
  counters from repository-wide searches.

Commands: `git diff 223503a..8fadd862`; `node
tools/verify/e2_t12_portability.mjs`; `pnpm build`; disposable equal-seed
golden generation/replay and one-field sabotage; repository-wide `git grep`
boundary searches; `tools/verify/cold_clone.sh verify-E2-T12` (duplicate
critic run intentionally stopped after proportionate focused proof).
