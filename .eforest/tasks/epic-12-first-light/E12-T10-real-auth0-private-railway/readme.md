---
id: E12-T10
epic: 12
title: Deploy real Auth0 login with private persistent data on Railway
priority: 521
status: in-progress
depends_on: [E12-T00]
estimate: L
capstone: false
---

## Goal

The operator can sign into the real hosted application with the supplied Auth0 tenant.
A separate Railway service uses fresh private data on our pinned, patched, self-hosted
Durable Streams server. This is the first usable authenticated deployment; the complete
public multi-user release remains gated by E12-T01 through T09. No existing verified
behavior or public-launch criterion is waived by this early milestone.

## Context

The human explicitly chose our custom Durable Streams server on Railway and prioritized
real production login, local CLI setup, and mirroring their own selected projects before
further design or an ElectricSQL migration. The supplied Auth0 SPA is `eforest`, client
`H9LGwHMzwWHgamCot9KTAmOFJCmDIlOk`, issuer
`https://dev-8qqftel4x1s5wed3.us.auth0.com/`. These are public identifiers, not secrets.
Public authorization-code/S256 PKCE needs no client secret. Auth0 registration must name
the actual new service origin; the shared-fixture preview cannot become its datastore.

Use Railway project `e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`. Preserve the preview and all starter services/data.
Co-locate the published patched provider on container loopback with one mutation-serving
platform replica, persistent dedicated storage and non-overlapping deployments. This
selects the initial self-hosted implementation; T01 still earns its complete production
conformance/capacity profile and T07 earns backup/restore. Do not present those pending
qualifications as complete. Existing local emulator/test contracts remain available.

## Deliverables

- Separate real-auth runtime/image entrypoint, fresh private volume, canonical public
  origin, validated configuration and exact deployed source/image identity.
- Secure session/return/login-state cookie handling, browser-bound PKCE transaction,
  same-origin cookie mutations, safe redirects and verified email for invitation identity.
- Reachable app indication of actual auth/build/capabilities, organization creation and
  existing CLI-token settings; agents and outbound integrations remain off.
- Public-only Auth0 registration record, dedicated-fixture HTTP/browser/stream evidence,
  actual deployed-origin health/assets/login redirect, and real operator login receipt
  without production credentials or unrelated private data in committed evidence.
- `make verify-E12-T10` and concise operator login/CLI-token handoff instructions.

## Acceptance criteria

- [ ] Ordered immutable root gates and cold-clone `make verify-E12-T10` pass. Evidence
      names the full source revision, lockfile/runtime versions, image digest and numeric
      limits: startup/readiness <=60 s, shutdown <=15 s, positive bounded body size and
      request deadline. Invalid/missing config/assets and preview or inherited harness
      credentials fail before public listen; successful startup accepts assigned PORT.
- [ ] The public origin always determines callback, redirect and invite origins. Host,
      Forwarded and X-Forwarded-* injection, external/encoded return paths and wrong
      origins cannot replace it. Cookies are separately emitted, Secure/HttpOnly and
      SameSite/path scoped; they contain no provider token, password, signing secret or
      PKCE verifier. Cookie mutations/logout require the
      configured Origin; bearer CLI requests have their explicit separate policy.
- [ ] Dedicated fixture users complete real gateway-backed PKCE login and local deep-link
      return in browser evidence. Browser transaction binding, state, nonce, verifier,
      signature, audience, expiry and verified-email failures append no identity event.
      A stolen/other-browser transaction cannot log the victim into the attacker's account.
      Reused callbacks fail; established sessions survive restart with the stable private
      signing secret; an interrupted in-flight login safely restarts. Logout/revocation
      survives restart. Public cookies and logs never contain provider tokens or secrets.
- [ ] Two dedicated fixture identities create separate organizations. Private reads,
      writes and follow are refused across them and to an anonymous visitor. The hosted
      runtime exposes no raw stream/admin or fixture-login routes, starts without preview
      users/repos, and rejects agent execution/outbound integrations before their effect.
      The app surfaces Auth0/build state, disabled agents and reachable CLI-token settings;
      a newly signed-in user can create their own organization without seeded data.
- [ ] The actual Railway service has a dedicated fresh private volume, one replica and
      zero overlapping mutation-serving revisions. `/healthz`, `/readyz`, asset loading,
      visible source identity and `/auth/login` work at its HTTPS origin. The manifest
      binds exact source/image/config/service/deployment. A controlled restart preserves
      a real operator's synthetic acceptance mutation and established login, documented
      by a minimal redacted UI/build/digest receipt; production identity is not dumped.
      The same immutable runtime's isolated dedicated-fixture restart proof independently
      replays byte-identical event prefixes/state. No public-fixture data or credentials
      were copied into this volume; no fixture-login seam is exposed to earn live proof.
- [ ] Public provider evidence records actual issuer discovery/JWKS, web client ID and
      exact registered callback/logout/origin. The real operator can complete the deployed
      Auth0 login; capture a minimal redacted outcome bound to this revision, without a
      production token, password, private project, email or identity dump in evidence.
      Missing registration or a failed real callback remains an explicit blocker.
- [ ] Named journey `E12-T10 Auth0 login and private workspace` in configured project
      `proj-electric-forest-ms8w0nv1` covers changed browser paths with dedicated fixtures,
      zero console/page errors and DOM digests matching independently replayed dumps. Use
      the existing explicit `Replay: N/A (<reason>) + mitigation` fallback when unavailable.
      Real production credentials never enter an external QA recording.
- [ ] Two fresh committed readers agree before builder and after lifecycle writes; a
      fresh pre-critic freezes the finite threat model and a separate fresh critic alone
      verifies. Prior task ledgers, ceilings, controls and project stops are preserved.

## Adversarial verification

1. Inject hostile origin/proxy/return values and cross-site POST/logout requests; verify
   exact refusal and unchanged stream heads. Restore HTTP or strip Secure in scratch:
   its corresponding sensor must go red.
2. Attempt login-CSRF with another browser's valid transaction, wrong cookie/state,
   expired/reused code, nonce/audience/signature mismatch and unverified email. Unknown
   transactions after restart fail closed, while established sessions remain valid.
3. Start with a preview marker, missing/incomplete volume, wrong revision/assets or
   inherited developer keys; no public readiness or silently seeded user may appear.
4. Probe raw/admin/fixture routes and agent/integration admission from the public side;
   a bypass, secret or cross-tenant private response refutes the boundary.
5. Kill/restart after an accepted fixture write and login; independently replay before
   and after, compare exact event prefix/digests and check one stable secret boundary.
6. Alter one evidence byte and separately sabotage cookie state binding or auth refusal;
   each measuring apparatus must detect its mutation. Interrogate recorded browser
   evidence; do not represent emulator login as the real Auth0 round-trip.

## Verification log

### 2026-10-16 — human-directed activation

The human prioritized actual Auth0 login on Railway, then local CLI setup and selected
private-project mirroring on our patched self-hosted Durable Streams server. E12-T00
is independently verified at `b8ec0961aed4aa1882491c678530a387e95d3b3c`; its preview
service/data and all starter services remain separate. The planning commit is
`75faffee26b9f8e791fea38cf30ef41120df457e`. This task alone becomes in progress.

Two independent trusted-pre-write committed snapshots are byte-identical:
`evidence/lifecycle/planned-a.json` and `planned-b.json`, SHA-256
`e2296180e93da6d99432cc6aa7508d34964c4b1fc57f3b9c64da858c231e146e`. They show
project building, T10 pending/eligible, run 0 under ordinary ceiling 10, empty ledger,
and unchanged controls. All 153 prior verification logs and all 74 verified task
readmes remain byte-identical. This activation grants no verification or extra run.

Fresh read-only pre-critic `/root/real_auth_precritic` froze the finite threat model in
`evidence/precritic/report.md` and `report.json`, bound to the committed specification
SHA-256 `4e269bb9d4a94072a777bc3ef739736888578b9c99d83697911b1a3604ac4dc9`.
The initial profile is 8 MiB maximum body, 30 s to response headers with explicit
established-stream cancellation/drain policy, <=60 s readiness, <=15 s shutdown,
10-minute login transactions and default 24-hour sessions. These bounds do not satisfy
T01's full launch profile or T06/T07 capacity/recovery qualification.

Replay: N/A (lifecycle activation and pre-implementation threat model; no product
behavior changed) + mitigation: committed exact reader snapshots, immutable history
hashes, DAG/queue checks and the fresh frozen pre-critic report. Product stream/browser
execution evidence is explicitly absent until the builder records it.

### 2026-10-16 — builder — healthy deployment checkpoint (incomplete)

The failed Railway deployment was caused by default root Config as Code selecting the
preview Dockerfile. Railway rejected custom Config as Code opt-in for this new service.
Source `9a5861e82ec99ab2f275181a527aab5c2bfb0622` removes default config discovery,
preserves the old preview config byte-for-byte as an example, and uses supported service
settings for `Dockerfile.production`. Prior source versions remain full content-addressed
Git blobs linked by the four source changeset receipts; no generated textual patch is
stored. The complete product changeset/CAS model remains E14 work.

- Deployment `2a57586c-4613-4fed-b538-09ca3adc0145` is `SUCCESS` at
  `https://electric-forest-production.up.railway.app`. OCI image
  `sha256:8e0d1de92341b27d8d2fb40a7048ca78a40e5c88eac4938a159eb5de3f49448d`
  has artifact digest `b22287783bcaa4c93dd49ee1c9d43422b1e6c5ab96d0a793dc349aa67e737f15`
  over 740 files. The private service has its own volume, one replica and zero overlap.
  Exact IDs/config and the remaining scope are in
  `evidence/builder-run-1/final-9a5861e8/deployment-checkpoint.json`.
- Fresh auditor `/root/real_auth_gate_auditor_v4` ran all four ordered root gates once
  for this source: 124 test files and 972 tests passed. Full per-stream/raw/chunk output,
  source/index snapshots and the audit index are retained under
  `evidence/builder-run-1/audit-9a5861e8/`. Node is 24.20.0, pnpm 10.15.0; lockfile
  SHA-256 is `ffd8b299ca115cfd2d0be9c8ba2833c2de791a071e77e90616c364b7afd9c54a`.
  No earlier candidate's passing audit was substituted.
- Dedicated-fixture final evidence records 9 native HTTP phase cases, 77 HTTP checks,
  30 browser scenes and five videos with zero console/page/request failures. Standalone
  Python models independently replay 23 dumps and compare four byte-identical restart
  prefixes; models and frozen-golden one-byte sensitivity outputs are retained. These
  are fixtures, not a real Auth0 operator session. See
  `evidence/builder-run-1/final-9a5861e8/independent-replay.json` and `stream-proof/`
  under the same builder evidence root.
- Public HTTPS health/readiness/build/deployment endpoints, initial entry assets,
  canonical Auth0/S256 login redirect, cookie attributes and anonymous/raw-route refusals
  passed in `evidence/builder-run-1/final-9a5861e8/railway/public.json`. The numeric runtime
  limits remain 8 MiB body, 30 s admitted request deadline, 60 s readiness, 15 s drain,
  10-minute transaction, 24-hour session and 10 s maximum long-poll, with native Node
  header/receive bounds and separately documented established-stream cancellation.
- Original recorded paths resolve through `evidence/builder-run-1/relocations.json`;
  all copied bytes and source targets are hash-bound there. Root source targets resolve
  at the audited source revision, including the earlier task readme. Earlier workshop
  selfchecks referenced inside preserved prior freezes are history, not final gate credit.
  The saturated Railway log excerpt is explicitly superseded by three complete bounded
  subwindows in the deployment manifest.

Auth0's production URLs were typed into an unsaved dashboard draft. Save was never
invoked; Chrome automation detached before final draft readback/screenshot. Actual
Auth0 login, a real operator's synthetic mutation/session-preserving restart, the cold
clone and fresh independent task critic/judge are **absent**. No production token,
identity dump or private project was retained or uploaded. The task stays `in-progress`,
run 0 under ceiling 10; E12-T11 remains pending. Reconnecting Chrome is the next blocker.
The healthy deployment alone does not satisfy the public multi-user launch gates.

Replay: N/A (Replay QA authentication unavailable in this session) + mitigation:
dedicated-fixture Playwright videos/timeline/console/network checks and independently
replayed stream dumps. The actual hosted landing page is a separate public-only Chrome
screenshot; it does not prove the still-pending real Auth0 login. No remote journey/test
run or production-credential recording is claimed.

Commands: pnpm format:check && pnpm lint; pnpm typecheck; pnpm test; pnpm build;
node tools/verify/e12_t10_deadlines.mjs <work-output>;
node tools/verify/e12_t10_hosted.mjs <work-output>;
node tools/verify/e12_t10_browser.mjs <work-output>;
python3 <retained-stream-proof>/replay_final.py <final-proof-root> --out <replay-receipt>;
node <retained-check-public.mjs> 9a5861e82ec99ab2f275181a527aab5c2bfb0622 <work-output>.
Exact original argv, UTC times, exit codes and output hashes are in the retained command
receipts. This entry is a deployment checkpoint, not an implemented claim or verdict.

### 2026-10-16 — builder — actual Auth0 callback checkpoint (restart pending)

The human confirmed fixing production after the concrete Auth0 Save request. The
prepared callback, logout and web-origin allowlists were saved once, then the settings
were reloaded and their exact persisted values read back. The callback is
`https://electric-forest-production.up.railway.app/auth/callback`, logout is the same
origin with `/`, and web origin is the same origin without a path or trailing slash.
No wildcard, secret, grant-type or other tenant setting was changed.

A fresh application `/auth/login` reached Universal Login without the mismatch.
The existing operator Google sign-in completed the real Auth0 callback and returned to
the authenticated production app. The operator then created synthetic workspace
`railway-acceptance-t10`, channel `persistence-check`, and one synthetic acceptance
message. Its DOM checkpoint is `0000000000000000_0000000000000000`, digest
`92c15bbb5188c74bbabf285c6e6227251e7fd8f2c8289a810941c31c241c7b2b`.
An anonymous request to that private channel was refused with HTTP 404. Health,
readiness, visible build and the public artifact manifest still name audited source
`9a5861e82ec99ab2f275181a527aab5c2bfb0622`; the Railway deployment/image/config and
dedicated volume remain the previously recorded ones, with no staged changes.

`evidence/actual-auth0-20261016/manifest.json` binds every new receipt and screenshot
to its capture bytes, published bytes and Git blob. JSON formatting preserves parsed
values; screenshots are byte-identical native captures. `actual-auth0-receipt.json`
records the public registration and minimal actual-login outcome;
`production-before-restart.json` records only DOM digests/cursors/build and synthetic
message presence. Screenshots omit operator contact details and the message author
subject. No production identity event log, cookie, provider token, code/state/nonce,
password, client secret or private project is retained.

Two fresh committed readers agreed byte-for-byte on the parent checkpoint: 36,751
bytes, SHA-256 `f1e8393fd3359c99ee35f0c0be1f34782a506d911da5b2525e1671b6f4be0111`.
This evidence-only append changes no runtime source, task status, queue, prior ledger
or control. The ordered root-gate audit already recorded for the exact deployed source
is unchanged and was not rerun for metadata.

The single controlled restart is explicitly awaiting the human's answer because the
Railway restart tool requires approval for an attached-volume service. Established
actual-login/session and synthetic-write persistence across that restart, the cold clone
and the fresh task critic/judge remain absent. This is an incomplete checkpoint;
T10 stays `in-progress`, run 0/10, and T11 stays pending.

Replay: N/A (actual operator authentication is excluded from external QA recording;
Replay QA authentication is unavailable in this session) + mitigation: local Chrome
public settings/login screenshots and minimal redacted DOM/build receipts, together
with the separately retained dedicated-fixture Playwright and independent stream proof.

Commands/actions: Auth0 Save, settings reload/readback, fresh production `/auth/login`,
normal Google sign-in, app workspace/channel/message actions; read-only Railway
describe-service; public HTTPS health/readiness/build/deployment and anonymous private
channel checks. No restart, production identity dump or credential extraction occurred.

### 2026-10-16 — builder — integrated main release checkpoint (rollout pending)

The human requested merging the hosting work into main and automatic Railway deployment
on future main merges. Integration `06e18df04f9db6112a425f050587c6d61588347c` preserves
hosting `d35834a0a677ba3b5c0ecc96f1e034035807afa8` and main
`bd56c79feb8ada96736e7b6d2e79eb71738ea3a3` as its two parents. Both product histories,
prior verification reports, evidence blobs and controls remain present. Imported legacy
E6 histories retain their original verdicts and activation blocker; no counter was reset.

The final runtime/config candidate is `c1213495044f6fdc2b858592681b9061f149abd4`, tree
`2d60f1ee091d33dcee4f7be33e19d47e4343da6d`. Two source-mapping corrections address
actual clean Linux CI failures: TypeScript paths at `1eda083c…` and Vitest aliases at
`c1213495…`. With all 20 generated workspace output directories hidden, full collection
finds 141 files/1,144 tests and the six affected suites pass 19 tests. Outputs were
restored byte-for-byte; no build was moved ahead of the required gates.

- Fresh auditor `/root/main_vitest_gate_auditor` passed format/lint, typecheck, all
  141 test files/1,144 tests, then build, once each in order. Six source/index snapshots
  preserved 3,015 root and 668 pinned vendor entries. Node is 24.20.0, pnpm 10.15.0;
  lockfile SHA-256 is `a977812903abfd8904af23424cb0ceb09e695986db4f252c5e1035ac1f6dc9da`.
- Actual Linux CI run `38984310568` passed all four ordered gates. The complete job log
  confirms checkout `02bce2f8d280f33cda03a2c69184746c3a909fbf`, the GitHub PR merge
  commit whose tree equals the candidate tree. Earlier failed CI logs are retained.
- Final dedicated fixtures passed 9 native deadline/phase cases, 77 HTTP checks and
  30 browser scenes in five videos with zero console/page/request failures. Standalone
  Python models replayed 23 dumps and four byte-identical restart prefixes. A one-byte
  semantic mutation correctly refuted the frozen receipt. An initial scratch sensitivity
  command named a nonexistent dump; its failure is retained. The helper was then corrected
  to the recorded browser chat dump without product changes, and the sensor went red.
- Two independent committed readers returned identical 1,176-byte candidate snapshots,
  SHA-256 `a3c97cbb1619e6872b7e49bbeebfc34eee71095b85240b2fc7bc4aa233915a43`.
  Controls, project/task state, complete prior ledgers and the queue were unchanged.

Completed receipts are at
`evidence/main-release/candidate-c1213495044f6fdc2b858592681b9061f149abd4/`.
Its manifest binds 281 copied files (34,650,347 bytes) to original workshop paths,
SHA-256 values and full Git blob addresses. Manifest SHA-256 is
`db589bbf74e59e091678a411d19ad04e55a2513fc271e12dca38282b44a35562`.
Changed source is linked by full Git content addresses; no textual patch file is stored.
Fixture private stores, generated signing keys and production identities are excluded.

Railway's GitHub App installation `172240212` is present with repository access limited
to `BLamy/electric-forest`. Main branch, Wait for CI, removal of the old commit pin and
removal of the fixed revision variable are staged only. The healthy live deployment
still runs historical source `9a5861e8…`; applying the new source and observing an actual
main-triggered deployment remain pending at this checkpoint. The actual Auth0 login
receipt is historical evidence; no fresh main rollout or persistence claim is made here.
This metadata-only append changes no runtime/config/control, task status, queue or prior
ledger. T10 remains `in-progress`, run 0/10; T11 remains pending.

Replay: N/A (Replay QA authentication unavailable in this session) + mitigation:
dedicated-fixture Playwright videos/timeline/console/network checks and independently
replayed stream dumps. Production credentials never enter an external QA recording.
Cold-clone task acceptance and the fresh independent task critic/judge remain absent;
this is an incomplete release checkpoint, not an implemented claim or verdict.

Commands: pnpm format:check && pnpm lint; pnpm typecheck; pnpm test; pnpm build;
node tools/verify/e12_t10_deadlines.mjs <work-output>;
node tools/verify/e12_t10_hosted.mjs <work-output>;
node tools/verify/e12_t10_browser.mjs <work-output>;
python3 <committed-stream-proof>/replay_final.py <proof-root> --out <receipt>;
python3 <retained-check_replay_sensitivity.py> <proof-root> <model> <scratch-root>;
gh run view 38984310568 --log. Exact argv, UTC times, exit codes and full output hashes
are retained. Passing root gates were not rerun for metadata.
