---
id: E12-T00
epic: 12
title: "Deploy a clearly labeled Railway preview with disposable data and stub identity"
priority: 520
status: in-progress
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
