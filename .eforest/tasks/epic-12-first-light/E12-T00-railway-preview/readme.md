---
id: E12-T00
epic: 12
title: "Deploy a clearly labeled Railway preview with disposable data and stub identity"
priority: 520
status: implemented
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
