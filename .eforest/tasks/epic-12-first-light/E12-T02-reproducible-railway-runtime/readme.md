---
id: E12-T02
epic: 12
title: Build a reproducible Railway runtime with readiness and bounded shutdown
priority: 522
status: pending
depends_on: [E12-T01]
estimate: M
capstone: false
---

## Goal

A locked container build runs the existing platform and built web app on Railway's
assigned port, becomes ready only after required provider initialization, and exits
within the frozen shutdown budget. The same immutable image is the artifact tested,
reviewed and later deployed.

## Context

The platform currently reads `PORT` but uses the server's loopback bind default, while
`EF_WEB_ROOT` is optional and deployment packaging is absent. The upstream test-server
launcher is not the production runtime. T01 supplies the qualified provider, exact
topology and numeric budgets; this task creates a runnable artifact without changing
repository, issue, PR or file semantics or deploying to the user's project.

## Deliverables

- Repository-owned container/build recipe, ignore rules and production start command
  with pinned Node/pnpm inputs and frozen-lockfile installation.
- Production bind/configuration validation, packaged web assets and explicit `/healthz`
  liveness and `/readyz` readiness endpoints with minimal public responses.
- Bounded SIGTERM/SIGINT draining, including live-reader cancellation and background
  projector/responder cleanup; no dependence on local development credentials.
- `make verify-E12-T02` and a cold-build/run harness bound to the image digest and T01
  launch-profile hash.

## Acceptance criteria

- [ ] `make verify-E12-T02` exits 0 from a cold clone with scrubbed environment and emits
      `evidence/e12-t02-build.json` and `evidence/e12-t02-runtime.json`, naming the full
      source commit, lockfile hash, runtime versions and exact tested image digest.
      The artifact contains built platform/workspace dependencies and web assets and
      starts without a development server, warm build tree or global package install.
- [ ] An independent container-network client reaches the app at `0.0.0.0:$PORT` and loads
      its hashed assets. Missing/invalid required secrets, provider URL, bind/port or web
      assets fail startup with a redacted diagnostic and never produce readiness 200.
      `evidence/e12-t02-config-cases.json` records the exact response/exit for each case.
- [ ] `/healthz` reports process liveness; `/readyz` is non-200 until required identity,
      namespace and provider initialization complete, and returns non-200 within T01's
      readiness budget after a required dependency fails. Neither endpoint returns
      credentials, tenant contents or a cached deployment-success value. Recovery is
      demonstrated against a dedicated provider fixture in the runtime transcript.
- [ ] SIGTERM during an active follow and an admitted mutation stops new mutation
      admission, settles or safely retries the admitted operation, closes long-lived
      readers/background work and exits within T01's shutdown budget. Recorded stream
      heads and `evidence/e12-t02-streams.jsonl` independently replay to the expected
      digest without losing an acknowledged mutation or duplicating a retried mutation.
- [ ] Browser asset reachability is exercised by named journey `E12-T02 runtime shell`
      in configured Replay QA project `proj-electric-forest-ms8w0nv1`, through its
      managed tunnel to this exact candidate image. The Verification log cites actual
      journey/test-run IDs, outcomes, console/network evidence and attached recording
      URLs when present; deterministic Playwright reports zero console errors. Any
      unavailable Replay service uses the doctrine's literal `Replay: N/A` form with
      reason and explicit Playwright/console/network mitigation.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Build without the warm `node_modules`, dist tree and inherited Node/npm settings.
   Missing runtime files or a dependence on the builder's machine refutes reproducibility.
2. Restore the loopback bind in a scratch candidate; the separate network-client check
   must fail. A passing result refutes reachability coverage.
3. Start while the provider is unavailable, fail it after readiness and recover it.
   Premature/stale readiness or a response containing provider secrets refutes health.
4. Send SIGTERM during streaming and immediately after an uncertain append response.
   Hanging beyond budget, an acknowledged event missing from replay or duplicate retry
   effects refutes shutdown safety.
5. Delete one hashed web asset and substitute a different image digest in the evidence
   manifest. The harness must reject each; a green run refutes artifact binding.
6. Interrogate the cited Replay QA run for shell/asset failures and console errors;
   neither a local recording nor the build command alone proves browser reachability.

## Verification log

