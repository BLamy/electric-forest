---
id: E12-T00
epic: 12
title: "Deploy a clearly labeled Railway preview with disposable data and stub identity"
priority: 520
status: verified
depends_on: [E5-T14]
estimate: L
capstone: false
---

## Goal

An actual public Railway URL runs the current Electric Forest app, built from a pinned
source revision, with a clearly visible preview label, disposable dedicated fixture
data, and a stub identity provider. Browser actions reach the real platform gateway,
official reference streams and reducers. This is a useful first deployment without
Auth0 or managed stream credentials; it does not establish production readiness.

## Context

On 2026-10-16 the human explicitly authorized lifecycle reprioritization, implementing
the hosting plan, Railway reconfiguration and stub integrations on the first deployments.
This additive task is ahead of E12-T01; that production qualification and E12-T03's real
OIDC acceptance remain required. E5-T15 and E6-T12 are administratively deferred with
their entire historical claims/findings preserved, not verified or reset.

The preview may compose a private loopback published `DurableStreamTestServer`, pinned
OIDC emulation or an equally explicit fixture-only identity adapter, and the real
platform runtime in one container. That is a task-scoped non-production preview, not a
replacement production transport or a claim that the test server is production-ready.
Use a dedicated Railway service and data volume in project
`e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`. Preserve existing starter services and data.

No production credentials, developer model logins or unrelated data enter the container.
Agent subprocesses and real email/payment/external side effects are disabled in preview.
Stub credentials cannot access a production backend, and production startup fails closed
if configured with preview identity. Preview acceptance cannot mark another task verified.

## Deliverables

- A reproducible container and Railway deployment recipe with pinned build inputs,
  built web assets, runtime `PORT`/interface support and an explicit preview entrypoint.
- Fixture-only auth/seed bootstrap, private stream access, visible preview identity/data
  notice, minimal health/readiness and deployed build identity.
- `make verify-E12-T00`, focused browser and real-HTTP tests, event dumps, independently
  replayed digests, configuration refusal cases and a deployment manifest.
- A working Railway HTTPS URL, exact service/deployment/revision identity, and concise
  instructions for the later real-auth/provider configuration.

## Acceptance criteria

- [ ] Ordered root format/lint, typecheck, test and build gates pass for the immutable
      candidate, and `make verify-E12-T00` passes from a cold clone with no hidden warm
      server or skipped task assertion. A fresh auditor runs the sequential gate chain.
- [ ] At the actual Railway HTTPS origin a fresh browser loads built assets, sees the
      preview label before entering fixture data, signs in through the declared stub,
      browses a seeded repository/file and completes one real gateway mutation observed
      by a second isolated browser without reload. DOM stream offsets/digests match
      independently replayed committed fixture dumps, with zero console/page errors.
- [ ] `/healthz`, `/readyz` and an app-visible build/mode indicator identify preview and
      the tested source revision without leaking credentials. The container accepts
      Railway ingress at its assigned port; missing assets or invalid preview config
      fail closed. Startup/shutdown and one restart complete within 60 seconds each.
- [ ] Raw stream/admin endpoints stay loopback/private. Preview configuration refuses
      external production stream URLs, real identity credentials, agent harness mode,
      inherited developer logins and real outbound integration configuration. Synthetic
      canaries do not appear in browser bundles, responses, logs or evidence.
- [ ] Repeated bootstrap/restart uses one dedicated data directory, preserves accepted
      preview writes or performs an explicit operator-requested reset, and never silently
      reseeds over user changes. Separate container instances use separate data. Logs
      and documentation state that this fixture environment is public/disposable.
- [ ] The deployment manifest binds the exact source and artifact to Railway project,
      environment, service, deployment and URL. Actual browser/HTTP smoke succeeds there;
      a plan or Railway SUCCESS status alone is insufficient.
- [ ] Final browser evidence uses named Replay QA journeys in
      `proj-electric-forest-ms8w0nv1` through its managed tunnel, paired with source
      dumps and deployed-origin smoke. If the service is unavailable, record the exact
      `Replay: N/A (<reason>) + mitigation` plus Playwright console/network and independent
      replay evidence. A local recording cannot silently replace the managed run.
- [ ] Two independent committed ledger snapshots agree before implementation and after
      lifecycle writes. Only a fresh critic may verify this task; existing verdicts,
      progress checkpoints and verification-run ceilings are preserved.

## Adversarial verification

1. Cold-build without local dist/node_modules/auth files, then load the actual hosted
   URL. A developer server, missing asset or silently substituted static fixture fails.
2. Point preview at a production stream URL or enable the local agent harness/email
   integration. Any successful startup with that configuration refutes preview isolation.
3. Probe raw stream/admin routes externally and insert secret canaries. A raw mutation
   bypass or leaked canary refutes the boundary.
4. Run two browser profiles, mutate via pointer/keyboard, disconnect one and reconnect.
   Wrong bytes, duplicate accepted edits, missing updates or console errors refute the run.
5. Restart after a fixture mutation and bootstrap again. Silent reseeding/loss or a
   digest that disagrees with independent replay refutes persistence claims.
6. Sabotage bind interface, freeze a DOM digest and remove the preview guard separately;
   the corresponding real-network/browser/config assertion must fail in each case.

## Verification log

### 2026-10-16 — human-directed activation

The human authorized immediate implementation and deployment into the existing Railway
project, including fixture-only stub identity on the first deployments. E5-T15 and
E6-T12 are deferred with their complete history preserved. This task alone is active.
Production qualification/authentication remain E12-T01 onward. Verification starts at
run 1 under the unchanged ordinary ceiling; no additional recovery window is granted.

### 2026-10-16 — builder — hosted preview submitted for verification

Candidate: `aba2f41a5141d0c26da5be613e9766078d839d35`; implementation diff:
`git diff 59aefbe244e57ce096ea05b94ad462d97d8831a8..aba2f41a5141d0c26da5be613e9766078d839d35`.
The actual origin is <https://electric-forest-preview-production.up.railway.app>.
This is a public disposable preview with shared Ada/Grace fixture identities, real
gateway/reducers/reference streams, and agent execution and integrations off. Production
provider, real OIDC and public tenant-isolation qualification remain E12-T01 onward.

- **Ordered gates:** fresh `preview_candidate2_auditor` ran `pnpm format:check && pnpm lint`,
  `pnpm typecheck`, `pnpm test`, then `pnpm build`, sequentially, with clean unchanged
  tracked source at every boundary. All passed; 123 files / 924 tests passed. Original
  manifest SHA-256 `1bb29cb09962dd111f3fe59aea6c80d15d7a93a2f3d6eb04208410db8f1c4565`;
  `evidence/run-1/audit/final-aba2f41a/manifest.json` and its portable log index retain the
  exact outputs. The prior audit stopped at two stale roadmap expectations; its complete
  logs remain in `evidence/run-1/audit/initial-11931416/`. The expectations now freeze the
  authorized sixteen epics and hosting-first order, without weakening the assertions.
- **Stream/HTTP layer:** `node tools/verify/e12_t00_preview.mjs <task>/evidence/run-1/http`
  exercised real gateway writes, a second fixture reader, persistent sessions/events,
  separate directories, partial bootstrap, invalid configuration, missing assets and ended
  sessions. `evidence/run-1/http/http.json` records startup 746 ms, shutdown 504 ms and
  restart 146 ms. Its accepted chat dump ends at offset `0000000000000000_0000000000000001`,
  state digest `a428babe519ad97f4ea6732cf1a41c252df7c1c918c06476464da74e85b92e70`.
- **Actual hosted browser layer:** twice ran `node tools/verify/e12_t00_browser.mjs
  https://electric-forest-preview-production.up.railway.app <output>`, into
  `evidence/run-1/hosted-before/` and `evidence/run-1/hosted-after/`. Each run records ten
  scenes, zero console/page/request errors, fresh fixture sign-in, frozen README bytes,
  pointer/keyboard writes, an isolated live witness without reload, reconnect and logout
  invalidation/relogin. Each folder includes actual MP4s, screenshots, network observations,
  complete authenticated projection dumps and independently CLI-replayed DOM checkpoints.
  Before restart both clients reached chat offset `0000000000000000_0000000000000004`,
  digest `b78d5d224b9ab379bd3855d6b232d7bb99032b714fb107af1ae445281aea7a36`;
  after restart both reached offset `0000000000000000_0000000000000006`, digest
  `f337f782530e983a9461e10b4ea20dc5ef2dd6ace6339a78c1ea667d36b2e270`.
- **Persistence and deployment binding:** Railway deployment
  `4e413bd5-4413-461a-8afa-0b6d10589afb`, service
  `160db4ed-ee0c-4d40-941c-65015a2071bf`, remains pinned to the candidate. The clean Linux
  build passed native LMDB/esbuild checks and produced OCI image
  `sha256:bb550117d768d23f37ddcf28600e61675bfc60edb5f08c1c8b44746d36515189`.
  Both browser runs report application artifact digest
  `4ad742a76c3104954c1d936ab2668d501fa79fc084ac9ca24ef69426f0259685`.
  `evidence/run-1/railway/manifest.json` binds source, image, service configuration, domain,
  volume, runtime logs and actual live replica state. A restart of this dedicated service
  reported ready after 8680 ms, recovered 14 streams with zero errors, and returned HTTPS
  readiness. `node <task>/evidence/run-1/persistence-check.mjs` proved the five earlier
  events are a byte-identical prefix of the seven later events, with exactly one welcome
  seed. Existing manual fixture test posts also survived; no reset occurred.
- **Preview restrictions:** `evidence/run-1/hosted-supplement/` retains its actual driver,
  MP4, DOM and HTTP results: Add member offers only Human, Escape closes the dialog,
  agent registration and token/device routes refuse access, and raw stream/admin/OIDC
  callback routes remain unavailable. All 555 deployed HTML/JS/CSS/JSON files were scanned
  for the configuration-test canary, with no finding (`evidence/run-1/canary-scan.json`).
  A focus-return observation is explicitly separate: after closing the member dialog,
  focus remained on BODY. No focus-restoration claim is made; retain this observation for
  the later design audit. Application source was not changed to hide this observation.
- **Lifecycle layer:** `preview_source_reader_a` and `preview_source_reader_b` independently
  executed the committed snapshot command against the candidate with trusted attester
  `11931416c47ed7d7f4e9891b1bd754e70302149e` and returned identical output. The committed
  snapshot/readers receipt is in `evidence/run-1/source-readback.json` and
  `evidence/run-1/source-readers.json`: project building, sole E12-T00 in-progress, run 0
  under ceiling 10, empty ledger, unchanged control digest. This builder submission does
  not grant verification or alter earlier tasks' ledgers.

Replay: N/A (Replay QA authentication is unavailable in this session; current diagnostic
is `evidence/replay-availability.json`) + mitigation: actual hosted Playwright videos,
console/network interrogation, complete gateway event dumps, independent CLI replay and
byte-exact restart comparison. Configured project remains `proj-electric-forest-ms8w0nv1`;
no managed journey, tunnel or recording URL is claimed. Local Docker's containerd storage
I/O failure prevented its final image; the actual Railway clean Linux image/build/runtime
above supply that layer, without a host prune or reset.

The final hosted runs demonstrate that the pinned real app is reachable over HTTPS,
fixture users can read and collaborate through its gateway, live DOM state matches replay,
and accepted fixture writes survive restarting the dedicated persistent preview. The
fresh critic must still attack this claim, execute sensitivity checks, and run the single
registered cold clone before deciding its verdict.

### 2026-10-16 — judge round 1 — VERDICT: refuted

Base commit: `49b46a180cfebe2e368b5611e668e8ed9c41fd25`; audited/deployed code candidate:
`aba2f41a5141d0c26da5be613e9766078d839d35`. This is official verification run 1 of 10.

- **F1 — AC1 cold-target reproducibility — FAILED.** Predicted that the registered
  `make verify-E12-T00` would build all required workspace output in a fresh installed
  checkout before running its assertions. Observed platform and CLI builds succeed,
  then Vite cannot resolve `@eforest/web-hooks`; Make exits 2 before any task assertion.
  Permanent citation: `evidence/critic-run-1/exact-target-recheck.log:18,32`, SHA-256
  `68548be35e78d0507c957117f19a6afcc45edef709522ef385fc24fad75dbfc4`;
  `Makefile:793-795` at the code candidate. Cross-examination confirms neither build's
  recursive TypeScript references include web-hooks, its package exports require
  `dist/src/index.js`, no install/prepare hook builds it, and the cold-clone harness
  installs dependencies then invokes this target without warming it through a root
  build. Makefile is byte-identical at candidate and base. Demand: build the web workspace
  dependencies in the committed target, submit a new immutable candidate, and earn the
  required single registered cold-clone pass.
- **Surviving proof and completion.** The full lead report covers eight criteria,
  32 changed hunks, all six task attacks plus a novel attack, three distinct sabotages,
  and environment/fixture review. Seven other criteria survived; the immutable root
  audit hashes retain 123 files / 924 passing tests. Actual hosted before/after videos,
  timelines and network were inspected without a hosted re-drive. Seven committed chat
  checkpoints match two CLI replays and an independent Python reducer; the post-restart
  dump ends at offset `0000000000000000_0000000000000006`, digest
  `f337f782530e983a9461e10b4ea20dc5ef2dd6ace6339a78c1ea667d36b2e270`.
  The five earlier events remain a byte-identical prefix, with one welcome seed.
  Citations: `evidence/critic-run-1/report.json` (complete, unchanged lead report,
  SHA-256 `75e655d51b5bf01297fcc5224acbeeb2e3ffd9eb96529179928ebe80ca0e088d`),
  `coverage.json`, `integrity.json` and `independent-replay.json` in the same directory.
- **Sensitivity — survived.** Loopback-only binding fails the real-interface connection
  and builder HTTP assertion; deleting the preview guard fails the complete-production-
  shape sensor and focused builder test; freezing the DOM digest fails browser/replay
  comparison after a gateway-accepted write. Each mutation was restored; the restored
  browser and all 18 config tests pass. A one-byte event mutation changes the replay
  digest to `a0329dcd0067eb85dc7e35cfc857f1b4148ac56367f3d6a7b39844128e8fca48`.
  Citations: `evidence/critic-run-1/sensitivity/complete.json`, its retained authentic
  baseline/mutation/restoration logs, and `evidence/critic-run-1/independent-replay.json`.
- **Evidence retention and SUITE.** All 112 indexed lead artifacts match their recorded
  bytes and SHA-256 values. The full JSON/Markdown report, original artifact index and
  cited critic artifacts are retained under `evidence/critic-run-1/`; absolute/work
  citations resolve through `portable-artifact-index.json` (SHA-256
  `b8c8af55bba5b06558c2117d2ca03c4a3c802a3bc572c351623fc2d61a3c67ac`).
  Judge cross-examination is `judge-cross-examination.json` (SHA-256
  `4e627a810a9b6f3dbfcc5284db4c0cf9aaafcb91d143736abad12a284660cffd`).
  Cold clone is `not-run-blocked`: zero harness attempts spent because F1 survives the
  cheaper stage. No unchanged root gate was rerun. Product suite promotion is deferred
  until correctness and coverage hold; retained review evidence does not verify the task.

Replay: N/A (Replay QA authentication is unavailable; committed diagnostic is
`evidence/replay-availability.json`) + mitigation: retained actual Railway Playwright
MP4s, console/network/timeline interrogation, complete gateway dumps, independent replay
and byte-exact restart comparison. The declared fallback is permitted by AC7; no managed
journey, tunnel or recording URL is claimed for `proj-electric-forest-ms8w0nv1`.

Commands: lead receipts retain `make verify-E12-T00` (exit 2), `node semantic-attacks.mjs`,
`node config-edge-probes.mjs`, `python3 sabotage-driver.py`, and exact CLI replay commands
in `evidence/critic-run-1/report.json`; judge ran
`git diff 59aefbe244e57ce096ea05b94ad462d97d8831a8..aba2f41a5141d0c26da5be613e9766078d839d35`,
committed-source reference-closure and SHA-256/byte checks, read the raw cited logs,
confirmed scratch HEAD/clean tracked source, then ran `python3 tools/build_queue.py`.


### 2026-10-16 — builder rework — dependency closure and new hosted proof

Immutable code candidate and actual deployed revision:
`1f9e06b87109a93c75107842d4c8aa65902f8622`. This submits the next ordinary
verification, run 2 under ceiling 10; the run-1 refutation remains unchanged. The only
source repair after that refutation is `Makefile:793`: build the union of web and CLI
workspace dependency closures in normal topological order, including web-hooks, before
all original assertions. No runtime, auth, Docker, lockfile or verifier was changed.

- **F1/build evidence.** A new detached `git clone --no-local`, with no initial
  node_modules/dist/tsbuildinfo and its own scrubbed frozen-lockfile installation,
  passes exact `make -- verify-E12-T00` without a preceding root build. Sixteen selected
  packages all have build scripts; web-hooks builds before Vite. All 18 config tests,
  real HTTP checks, browser checks and the registered success marker execute. This is
  builder self-validation, not the critic's required single registered cold clone.
  Receipts: `evidence/run-2/target-selfcheck/receipt.json`, `target.log`, `check.py` and
  `dependency-closure.json` in that directory. Frozen pre-critic: `evidence/run-2/precritic.json`.
- **Fresh ordered root audit.** A separate read-only auditor ran once, sequentially:
  `pnpm format:check && pnpm lint` (12.859 s), `pnpm typecheck` (8.148 s),
  `pnpm test` (618.162 s: 123 files, 924 tests), `pnpm build` (17.827 s).
  Full candidate OID and clean tracked source match before/after every gate. Manifest:
  `evidence/run-2/audit/manifest.json`, SHA-256
  `7fbd4abbf5104e62b55ae6283a9b01b7786b591214ab8a98d564f3c40d00ffb1`;
  raw and normalized full logs are alongside it. No passing root gate was rerun as an
  evidence step.
- **Actual new Railway image.** Project `e0864588-a320-4ba3-96df-95ad0a07ee81`,
  environment `c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`, preview service
  `160db4ed-ee0c-4d40-941c-65015a2071bf`, deployment
  `3a846a49-8b7b-4299-b10c-ecee7d755fa8`, snapshot
  `df29e459-16f2-4916-bf67-90980bfba6cc` serve
  `https://electric-forest-preview-production.up.railway.app` at this pinned revision.
  Actual cold Linux/amd64 image:
  `sha256:c694eed5e2d59f9b48dc3d89a6d5a79562fdc81ac89c9819fcc75039b480bf47`;
  application artifact `bb7762d242ad551e0b54c2f3811ae17238bb8777359b3509e900a2ffedd3816e`
  has 734 files. Manifest, source/config/volume records, OCI descriptor, build and deploy
  logs: `evidence/run-2/railway/manifest.json` and its cited artifacts. Health is online,
  one running replica, zero crashes/recent failures/pending work. Other services were
  not changed.
- **Final HTTP/browser/stream proof after that audit.** Real HTTP evidence records
  startup 640 ms, shutdown 501 ms, local restart 119 ms, accepted offset
  `0000000000000000_0000000000000001`, digest
  `a428babe519ad97f4ea6732cf1a41c252df7c1c918c06476464da74e85b92e70`,
  separate-directory isolation, partial-bootstrap/missing-assets/config refusal and
  ended-session refusal (`evidence/run-2/http/`). New actual-origin before/after runs
  each contain ten scenes: notice before fixture data, frozen README, pointer/keyboard
  gateway mutations witnessed by an isolated second profile without reload, reconnect,
  logout/refusal and relogin. MP4s, screenshots, timeline and console/network evidence:
  `evidence/run-2/hosted-before/` and `hosted-after/`. Both report zero console/page
  errors and request failures; aborted long polls on navigation are separately retained.
  Supplementary Members and integration-refusal proof is `evidence/run-2/hosted-supplement/`.
  It retains the prior nonclaimed member-dialog focus observation; no focus fix is claimed.
- **Restart and replay.** One controlled preview-service restart reaches a newly logged
  ready process in 10,976 ms. All nine before-restart events remain an exact byte prefix
  of eleven after-restart events, with one welcome seed. Final offset
  `0000000000000000_0000000000000010`, DOM/CLI digest
  `6780c44343b29371bb7a82a012461772a665a49f977daa0fe14ba29fcdef3670`.
  `evidence/run-2/final/persistence.json` and its runnable check prove prefix equality;
  `cli-replay.json` records two separate CLI replays of all eight browser dumps and six
  exact chat DOM comparisons. The frozen README remains SHA-256
  `b8092b3115e9e787dc5b1d5b984ad16d2d638611e90402ecd4fdf0000650d5e5`.
- **Inventory and canary scope.** The full root artifact includes 41 pre-existing extra
  dist outputs absent from the clean deployed image. Every one of the 734 shared files
  matches byte-for-byte; full local/deployed inventory equality is not claimed.
  `evidence/run-2/final/artifact-comparison.json` preserves exact path/hash inventories.
  The actual-origin scanner checks all 555 web files (33,937,112 served bytes) against
  their baked hashes; the HTML check removes exactly its declared mode/build metadata
  pair. No canary/private-key finding: `canary-scan.json` and `scan.mjs` in that directory.
  Retained evidence also has zero canary findings.
- **Lifecycle evidence.** Fresh committed readers agree at the post-judge, resumed and
  code-candidate boundaries (`evidence/run-2/ledger/`). Run-1 entry digest remains
  `040be5e609a106882fe635f9a3ec54601222182d5ea98b23d101fda24507201a`;
  ledger `9f0aa988c03a24ff519783fa7f7b578136a57fff0e01cdbdacece6577f6538cb`;
  control `64cb3dd424a3f70c1b084f2c56db51c3ab935d1d1b3fd78e93e071e819f7e967`.
  No checkpoint or ceiling changed. Only the forthcoming fresh critic may verify.

The new source and actual deployed image demonstrate a working, persistent, isolated
public/disposable preview and close F1 in builder self-validation. The same final run
shows real gateway/reducer behavior and independent CLI agreement. Production auth,
private project mirroring and full public-launch qualification remain outside this
preview claim; the supplied Auth0 settings have not been changed.

Replay: N/A (Replay QA authentication is required and unavailable for configured project
`proj-electric-forest-ms8w0nv1`; the current exact diagnostic is
`evidence/run-2/replay-availability.json`) + mitigation: final actual-Railway-origin
Playwright MP4s, console/network/timeline interrogation, committed source dumps,
independent double CLI replay and byte-exact restart comparison. No managed journey,
tunnel, exploration or Replay recording URL is claimed.

Final commands: `node tools/verify/e12_t00_preview.mjs <task-work>/run-2-http`;
`node tools/verify/e12_t00_browser.mjs https://electric-forest-preview-production.up.railway.app <task-work>/run-2-hosted-before`
and the same command with `run-2-hosted-after` after Railway `restart_service`;
`node <task-work>/hosted-supplement.mjs <origin> <revision> <output>`;
`node evidence/run-2/final/persistence-check.mjs`; all exact CLI replay commands are
in `evidence/run-2/final/cli-replay.json`. The artifact index preserves 92 retained files,
SHA-256 values and portable original-to-retained mappings:
`evidence/run-2/artifacts.json`, SHA-256
`cadf04b6254ca81f7b2e2c296115204c11194cd56498e7ef331b2267c716a833`.

### 2026-10-16 — judge round 2 — VERDICT: verified

Base commit: `a7e861d023651925a16e9103c0f50fce9c368a4e`; immutable audited and
actually deployed code: `1f9e06b87109a93c75107842d4c8aa65902f8622`. This is official
verification run 2 under ordinary ceiling 10. No blocking finding survives independent
cross-examination; run 1 remains preserved, with its F1 closed by the new evidence.

- **F1 / AC1 — cold target now survives.** Predicted the exact registered target would
  build required outputs before its unchanged assertions in a fresh installed checkout.
  The lead's single late official cold clone passes in 109.248 s: sixteen workspace
  packages build, web-hooks finishes before Vite, all 18 config tests, real HTTP and ten
  browser scenes execute, then `verify-E12-T00: OK` and `DEPENDENCY_INTEGRITY_OK` appear.
  Raw transcript `evidence/critic-run-2/cold-clone.log`, SHA-256
  `f647963c7f5e8322f4df618c22efd0f8f84c196bcb8e2c4b75b3a8a2dc991263`, and
  `cold-clone-receipt.json` in that directory bind submission HEAD. The kept clone's
  source is clean. No assertion, gate or ordering was weakened. Fresh ordered root audit
  remains bound to source 1f9: all four gates pass, 123 files / 924 tests; judge checked
  its retained manifest and hashes without rerunning the unchanged chain.
- **AC2–AC6 — browser, stream, isolation and deployment survive.** The full lead review
  interrogates all seven actual-origin videos, screenshots, timeline and network without
  a hosted re-drive. Both final browser runs have zero console/page/request errors and
  two isolated clients converge after pointer/keyboard writes, reconnect and relogin.
  Judge independently reduces all seven chat dumps and verifies six two-profile DOM
  checkpoints. The nine pre-restart events remain an exact byte prefix of eleven final
  events, with one welcome seed, offset `0000000000000000_0000000000000010`, digest
  `6780c44343b29371bb7a82a012461772a665a49f977daa0fe14ba29fcdef3670`.
  Decoded README bytes match frozen SHA-256
  `b8092b3115e9e787dc5b1d5b984ad16d2d638611e90402ecd4fdf0000650d5e5`.
  Fresh config/raw-route/canary/missing-asset/marker probes survive; the novel damaged
  ready-volume attack refuses restart without changing the marker. Actual source,
  Railway service/deployment/HTTPS origin, OCI image and 734-file deployed artifact agree;
  the actual new-process restart is 10,976 ms. Citations: `evidence/critic-run-2/report.json`,
  `browser-network-review.json`, `independent-replay.json`, `semantic/results.json`,
  `config-edges/results.json`, `judge-cross-check.json`, and `evidence/run-2/railway/manifest.json`.
- **Required attacks, sensitivity and coverage survive.** All eight criteria, 35 source/
  config hunks, 185 passive history/binary hunks and all six task attacks plus a novel
  attack are accounted for. Judge matches the coverage entries exactly to the actual
  diff. Bounded waivers cover declarations/types, non-claim exception plumbing and agent
  edit/selection predicates unreachable under the empty-roster/no-agent-dispatch invariant.
  Each isolated bind, complete-shaped production guard and frozen-DOM mutation makes both
  the original builder assertion and independent sensor red, then restored green with
  source hashes unchanged. The digest mutation accepts a real POST 202 and displays the
  message in both clients before equality fails. A single byte W→w changes the final
  digest to `09f46aad5e3bddfb7efe6a0748da07068a7625e5c975de2430d1a7cf9abc35a3`;
  the frozen comparison's authentic exits are `0 → 1 → 0`. Citations:
  `evidence/critic-run-2/coverage.json`, `predictions.json`, `sensitivity/complete.json`,
  its raw logs, `sensor-baselines.json` and the three `sensor-byte-*.log` files.
- **AC7–AC8, retention and SUITE.** The declared Replay fallback is supported by a current
  authentication-required diagnostic. Five existing reader pairs independently recompute
  to identical committed snapshots and preserve the complete run-1 entry, ledger/control
  digests and ceiling; the next continuation still requires two fresh readers of this
  verdict commit. All 92 builder artifacts match committed bytes. All 136 indexed lead
  artifacts (3,850,158 bytes), including the full unchanged JSON/Markdown report, are
  permanently retained under `evidence/critic-run-2/`. Lead report SHA-256
  `2db4ddb6f9fa95f05a36be4ed9d2f46af39111b7d2c8e006eb5ed28d52e6a2b7`;
  original portable index SHA-256
  `515963c3534ca1bb7d5ecc8653b54c26dff5f71cec8d683b6a3709d813a2dd1b`.
  The judge's full cross-examination is `judge-cross-examination.json` in that directory.
  **SUITE:** `suite-goldens.json` promotes verified restart-prefix logs, independently
  frozen digests, the fresh accepted-write log and sensitive one-byte corpus. Existing
  `make verify-E12-T00` and all original assertions remain permanent; no redundant unit
  test is added.
- **Explicit limits.** The caller supplied task-owned TMPDIR, but the unchanged cold
  harness chose system temporary storage; the one passing kept clone was moved under
  task work afterward without a repeat. The receipt preserves both locations. Warm root
  has 41 pre-existing extra dist outputs; every shared deployed file matches, and full
  inventory equality is not claimed. Pre-existing member-dialog BODY focus is outside
  this task. This verdict verifies the public disposable preview only; real production
  auth, CLI private mirroring and public-launch qualification remain pending.

Replay: N/A (Replay QA authentication required and unavailable for configured project
`proj-electric-forest-ms8w0nv1`; diagnostic `evidence/run-2/replay-availability.json`) +
mitigation: actual Railway Playwright MP4s, console/network/timeline interrogation,
complete immutable stream dumps, independent double CLI/Python replay, judge reduction
and exact restart prefix comparison. No managed journey/tunnel/exploration or Replay
recording URL is claimed.

Commands: lead receipts retain `bash tools/verify/cold_clone.sh --keep verify-E12-T00`
(exactly once), `node semantic-attacks.mjs`, `node config-edge-probes.mjs`,
`python3 sabotage-driver.py` and independent replay/lifecycle scripts. Judge read
`git diff 59aefbe244e57ce096ea05b94ad462d97d8831a8..1f9e06b87109a93c75107842d4c8aa65902f8622`
without persisting a patch, ran `python3 <task>/work/judge-run-2/cross-check.py`, verified
all artifact/staged bytes and source hashes, independently reduced dumps in Python,
inspected authentic cold/sabotage logs, then ran `python3 tools/build_queue.py`.
