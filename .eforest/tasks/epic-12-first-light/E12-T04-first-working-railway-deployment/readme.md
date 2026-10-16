---
id: E12-T04
epic: 12
title: Deploy the first working Forest candidate into the existing Railway project
priority: 524
status: pending
depends_on: [E12-T01, E12-T02, E12-T03]
estimate: M
capstone: false
---

## Goal

The actual Railway project serves the existing Electric Forest app at a public HTTPS
origin using the qualified stream provider and real OIDC identity provider. Two dedicated
accounts can mutate and observe live app state, and the hosted candidate survives a
controlled Forest-service restart. This is an integrated hosted candidate; the public
multi-user release remains gated by T05-T09.

## Context

Target project `e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`, currently contains the user's ElectricSQL starter.
Add the Forest app with configuration references and the qualified provider connection;
do not migrate the app's source of truth to Postgres or destructively repurpose existing
services. T01-T03 supply the provider contract, immutable runtime and HTTPS auth handling.

One replica does not by itself prevent old/new revisions from both accepting mutations.
Use T01's proven deployment admission/drain procedure; unsafe overlap blocks rollout.
Real deployment actions are implementation work, not performed by this backlog plan.

## Deliverables

- Reproducible Railway service/deployment configuration, secret-reference instructions,
  public origin and private provider connectivity, retaining existing starter services.
- A deploy/drain/readiness sequence and redacted mapping from commit/image/configuration
  hashes to Railway service, environment and deployment IDs.
- `make verify-E12-T04`, deployed-origin smoke, named Replay QA integration journey and
  dedicated fixture stream dumps/digests.

## Acceptance criteria

- [ ] `make verify-E12-T04` exits 0 and emits `evidence/e12-t04-deployment.json` containing
      the exact target project/environment, Forest service and deployment IDs, public
      HTTPS origin, full source commit, tested/deployed image digest and T01 profile
      hash. The hosted runtime reports the same artifact; a plan, successful build or
      Railway deployment status without a reachable ready app cannot satisfy this check.
- [ ] At that origin, a fresh real-provider browser session completes registered HTTPS
      login, loads built assets, returns to a deep route and signs out. A second
      dedicated user logs in independently. `evidence/e12-t04-deployed-smoke.json` records
      actual HTTP locations/cookie properties and zero browser console errors without
      recording credentials, provider tokens or unrelated user data.
- [ ] Through the existing gateway, one user creates a dedicated repository/file and
      issue; the second authorized session observes them through normal live reads with
      no reload. DOM offsets/digests match `evidence/e12-t04-streams.jsonl` and
      `evidence/e12-t04-digests.json`, independently replayed twice. No fixture HTML or
      direct raw-stream write stands in for the hosted interaction.
- [ ] An external client without provider credentials cannot append, delete, compact or
      administer raw streams, reach private provider/admin services, or recover a provider
      credential from app bundles, API responses or committed diagnostics. Dedicated
      authorized server calls still work; results are in
      `evidence/e12-t04-transport-boundary.json`.
- [ ] A controlled Forest-service restart preserves acknowledged app state and still-live
      sessions; reconnect reaches the exact expected digest. The rollout transcript shows
      at most one mutation-serving revision throughout replacement, or the separately
      qualified fence proof required by T01. Existing starter services are not restarted,
      replaced, deleted or migrated as a shortcut to this proof.
- [ ] Journey `E12-T04 hosted candidate integration` runs against the same immutable image
      through Replay QA's configured managed local tunnel in project
      `proj-electric-forest-ms8w0nv1`; the Verification log cites actual journey/test-run,
      bug and recording IDs/URLs and console/network findings. The actual deployed-origin
      smoke above is additional evidence, not a replacement for the managed-tunnel run.
      An unavailable QA service requires explicit `Replay: N/A` and its mitigation.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Compare the image reported by the actual origin with the candidate and QA evidence.
   A stale image, development process or wrong Railway environment refutes deployment.
2. Exercise real OIDC with no existing cookie, a deep return route and logout. A local
   emulator substituted for the deployed provider refutes the integration claim.
3. Observe readiness and mutation admission during replacement; hold an old follow/write
   open while the new revision starts. Concurrent unfenced mutation-serving revisions
   refute the single-writer deployment boundary.
4. Probe raw provider/admin paths externally and inspect public bundles/responses for
   secrets. An append/admin bypass or credential exposure refutes isolation.
5. Restart only the dedicated Forest candidate after an acknowledged mutation. A missing
   event/session, duplicate retry or unmatched DOM digest refutes persistence/live reads.
6. Substitute a different image digest or corrupt one event in the evidence manifest;
   `verify-E12-T04` must fail its exact identity/digest check.

## Verification log

