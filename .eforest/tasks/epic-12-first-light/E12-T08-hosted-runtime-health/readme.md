---
id: E12-T08
epic: 12
title: Surface runtime health and deployed build identity
priority: 530
status: pending
depends_on: [E12-T04]
estimate: M
capstone: false
---

## Goal

The hosted app exposes the actual deployed build identity, provider connectivity and
live-read health with relevant stream offsets/digests. A deployment's recorded success
and the current runtime's health are distinct observable states, so a stalled or failed
dependency cannot leave the app claiming a healthy live connection.

## Context

Railway service/deployment records are useful provenance, but they do not prove current
runtime readiness or live reads. T02 supplies liveness/readiness and T04 the real hosted
artifact. Extend the existing app monitor/stream devtools rather than introducing an
authoritative status database. Detailed tenant observations require authorization;
public health responses remain minimal and redact provider credentials/data.

Operational logging/monitor routing may be configured at implementation to a destination
the user has approved. This task does not require sending email, chat, or test messages
to another person. A captured redacted local sink can prove an operational signal.

## Deliverables

- App-visible deployed commit/image identity and distinct deployment/runtime/live-read
  states, with data attributes for current offsets/digests and state timestamps.
- Redacted structured logs/counters for initialization failure, dependency loss, stale
  follow, rate refusal and recovery, with an authorized operator inspection path.
- A monitor rule/route for a meaningful failure/recovery signal using an approved
  destination or dedicated captured test sink; no message-sending acceptance condition.
- `make verify-E12-T08`, deterministic failure/recovery fixtures and browser QA journey.

## Acceptance criteria

- [ ] `make verify-E12-T08` exits 0 and emits `evidence/e12-t08-health-timeline.json`, binding
      the candidate commit/image and T01 profile hash. The rendered app's build identity
      matches the actual deployed artifact; deployment status and runtime/live-read state
      have distinct fields with no inference of health from deployment success.
- [ ] A dedicated provider outage and a stalled follow each change the correct runtime/
      live-read state within the frozen readiness/staleness budgets while historical
      deployment success remains unchanged. Recovery restores current offsets/digests;
      `evidence/e12-t08-streams.jsonl` and `evidence/e12-t08-digests.json` independently
      replay to those exact displayed values.
- [ ] Public `/healthz`/`/readyz`, app health surfaces and unauthorized operator requests
      disclose no provider secret, private tenant identifier, private event payload or
      cross-tenant offset/digest. Authorized fixture operators can inspect the matching
      structured event/counter through the documented path. Redaction/access cases are
      captured in `evidence/e12-t08-observability-boundary.json`.
- [ ] The configured failure/recovery monitor produces exactly the declared redacted
      signal into a dedicated captured sink, tied to the runtime/build and timestamps;
      unchanged observations do not create duplicate signals. Evidence names the rule
      and route without requiring a message to any person or an unapproved destination.
- [ ] Journey `E12-T08 runtime outage and recovery` runs through the managed tunnel in
      Replay QA project `proj-electric-forest-ms8w0nv1` and shows build identity, degraded
      live state, recovery and matching DOM digests with zero console errors. Cite actual
      journey/test-run IDs, bugs, console/network and attached recordings; deployed-origin
      health/outage smoke is additional evidence. Any QA fallback uses explicit
      `Replay: N/A (<reason>) + mitigation` under the existing doctrine.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Leave Railway's deployment record successful while failing the provider and separately
   stalling a follow. A healthy/stale-unchanged runtime beyond budget refutes monitoring.
2. Replace the origin's image while retaining an old health response/cache entry. Failure
   to detect a mismatched build identity refutes provenance.
3. Inspect public and unrelated-user health/operator responses, including error/log paths,
   for a seeded secret and private tenant marker. Any disclosure refutes redaction.
4. Recover connectivity, then replay duplicate unchanged health observations. Missing
   recovery, duplicate signals or offsets/digests different from replay refute state.
5. Sabotage the stale-follow transition and redactor separately; corresponding checks
   must go red. A passing screenshot-only check refutes behavioral coverage.
6. Check monitor destinations and captured output. Treating a sent message or provider
   dashboard status as the sole evidence refutes the task's scoped observation contract.

## Verification log

