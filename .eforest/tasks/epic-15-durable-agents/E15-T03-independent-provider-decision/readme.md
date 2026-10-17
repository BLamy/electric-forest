---
id: E15-T03
epic: 15
title: "Capstone: independently decide Electric Sync and durable-agent integration boundaries"
priority: 543
status: pending
depends_on: [E15-T02]
estimate: M
capstone: true
---

## Goal

A cold, independently reviewed decision records `adopt`, `decline`, or `conditional`
for each evaluated Electric Sync/Agents component and assigns concrete follow-on
boundaries to the pending Forest backlog. The decision is bound to executed evidence,
preserves stream authority and the no-database production architecture, and unblocks
E14 regardless of whether upstream integration is recommended.

## Context

E15 evaluates opportunities before E6's hosted agent work becomes expensive to change.
It does not make a database migration a prerequisite for changesets or a successful
evaluation. `adopt` means an evidence-backed recommendation for a stated compatible
component/adapter, not permission to deploy it. `conditional` states exact unmet
conditions, including any explicit human architecture decision required; `decline`
retains the first-party reducer/agent-adapter path. Unsupported is not silently renamed
supported, and missing evidence cannot be papered over with a conditional verdict.

An independent decision reviewer is a fresh read-only session, distinct from the pilot
builder; the task's final verification still follows the ordinary fresh critic protocol.
The standing architecture remains unchanged. An upstream control plane requiring
PostgreSQL cannot enter Forest production merely because its agent streams are durable.
No root production package dependency, Railway service, source stream, or task lifecycle
is changed as part of this capstone.

## Deliverables

- Final `docs/decisions/electric-provider-evaluation.md` and
  `ElectricProviderDecisionV1` in `evidence/provider-decision.json`, including per-
  component verdict, pinned contract, evidence, limitation and owner of each next step.
- A read-only independent review in `evidence/independent-review.md` that checks the
  actual pilot artifacts, falsifiable predictions and source/dependency boundary.
- A compatibility table for E6 run protocol/adapters/fresh critics, E7 activity logs,
  E9 reducer collections/provider qualification, and E10/E11 code/state provenance.
- Interface sketches and a finite follow-on task list, using existing dispatch and
  official transport ownership; no implementation or automatic production switch.
- Proposed `make verify-E15-T03` validating decision freshness, support eligibility,
  evidence references and the unchanged production authority boundary.

## Acceptance criteria

- [ ] From a cold clone, `make verify-E15-T03` exits 0 and checks the E15-T01 contract,
      E15-T02 case completeness and all artifact digests before loading the decision.
      `evidence/decision-inputs.json` pins every input and the independent review's
      session identity; no missing case is classified as successful compatibility.
- [ ] Sync delivery, client collections, Agents runtime, and Agents server/control plane
      each have exactly one `adopt`, `decline`, or `conditional` row with concrete
      evidence citations and falsifiers. Unsupported capability cannot appear as
      adopted; the verifier rejects a deliberately contradictory row in
      `evidence/decision-refusals.json`.
- [ ] The independent reviewer attempts one read-path counterexample and one agent
      recovery/permission/effect counterexample against the pinned pilot evidence and
      artifacts. Predictions precede inspection, and observations cite request IDs,
      stream offsets/digests or exact artifact locations in
      `evidence/independent-review.md`.
- [ ] The compatibility table assigns every proposed integration to a read projection,
      runtime adapter, or explicit future architecture proposal. It identifies who owns
      entity/run state, registry/wakes, authorization, tool idempotency and critic
      isolation. No plan creates an alternate Forest mutation door or promises
      exactly-once external effects without the measured adapter and effect evidence.
- [ ] `evidence/authority-readback.json` confirms no production database dependency,
      service binding or authority change. Every recommendation requiring PostgreSQL
      or another authority-changing service is conditional on a separate explicit
      human decision; the decision cannot be used as that approval.
- [ ] A one-byte contract/fixture change, removed pilot case and a forged support row
      each invalidate the decision in separate sensitivity legs. A `decline` decision
      with complete evidence passes the same validator and leaves E14 eligible on
      verification; `evidence/decision-sensitivity.json` records both behaviors.
- [ ] The capstone claim declares `Replay: N/A (provider decision and isolated-runtime
      evidence; no product browser behavior changed) + mitigation` and names the
      cold evidence audit, independent review, replay digests and refusal results.

## Adversarial verification

1. Substitute a newer upstream commit while retaining old results. Any decision that
   still validates without requalification refutes freshness.
2. Mark a known effect-duplication, stale-write or role-leak failure `adopt`. The
   decision validator must reject that variant, regardless of the prose recommendation.
3. Remove a required pilot result and call it conditional. Acceptance refutes evidence
   completeness; conditional records a measured limitation, not an unexecuted test.
4. Follow every future integration recommendation into the production dependency and
   service boundaries. A hidden database requirement, second stream transport or
   unapproved authority change refutes the decision.
5. Select `decline` for all upstream runtime/server components while retaining honest
   evidence. If changeset work is blocked merely by non-adoption, the dependency design
   is refuted.
6. Challenge the independence evidence with a builder-only marker and compare session
   inputs. Shared builder deliberation presented as a fresh critic refutes review
   independence; preserve the failure rather than replacing its report.

## Verification log
