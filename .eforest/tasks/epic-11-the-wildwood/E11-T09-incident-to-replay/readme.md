---
id: E11-T09
epic: 11
title: "Capstone: cold-start a verified deployment, reproduce an incident, and verify a provenance-linked repair"
priority: 1109
status: pending
depends_on: [E11-T03, E11-T08]
estimate: L
capstone: true
---

## Goal

From a fresh clone, browser profile, and empty stream-server data directory, Electric
Forest demonstrates the complete application lifecycle: promote a freshly verified
build, deploy it with provenance, trigger a seeded regression in a disposable
production-shaped target, create an authorized incident task, restore and reproduce the
same failure, compare the run to its pinned build/fork baseline, and verify a repair on an
isolated sibling as a new provenance-linked candidate. The full chain is independently
replayable from authoritative platform streams and has a Replay QA browser recording for
the application journey.

## Context

This is Epic 11's end-to-end proof of the whitepaper's operating model for apps built on
Electric Forest. It composes T01–T08 rather than introducing parallel restore, comparison,
freshness, deployment, incident, or verdict machinery. The platform's durable streams are
the authority for application state, offsets, forks, lifecycle decisions, and provenance.
rrweb/Replay QA records browser observations and helps inspect the journey; it is evidence
about the run, not a substitute for the event log. All regression and repair behavior is
seeded in isolated fixtures, not live customer data or production credentials.

The capstone explicitly excludes model-training reuse. Any future reuse of lifecycle
data for training is separate speculative research and requires its own scope, privacy,
consent, and authorization gate before implementation.

## Deliverables

- A cold-start scenario that runs the verified deployment → seeded failure → incident
  task → cold restore/reproduction → fork/build comparison → sibling repair → fresh
  candidate provenance chain.
- A named Replay QA journey for the browser-visible application flow and an epic-closing
  open-ended exploration, plus the independent critic's stream and provenance reports.
- `make verify-E11-capstone` that downloads or reads the declared immutable artifacts,
  replays platform streams twice, and checks all links and digests from a clean root.
- Committed event logs, manifests, input fixtures, offsets/digests, comparison and
  freshness reports, verdict/candidate chain, Replay references, and sensitivity results
  under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-capstone` exits 0 in a fresh clone with an empty stream-server data
      directory, fresh browser profile, scrubbed environment, zero skips, and no warm
      application cache; `evidence/e11-capstone-run.json` records the exact environment
      and every stage's resolving stream offset.
- [ ] The complete chain in `evidence/e11-capstone-chain.jsonl` replays twice with
      identical per-stream and composite digests and resolves, in order, the fresh
      verdict, deployment artifact/manifest, seeded failure, authorized incident task,
      restore receipt, reproduced failure offset/digest, comparison report, sibling repair
      verdict, and new candidate provenance.
- [ ] The incident replay reproduces the seeded failure at the exact declared offset and
      digest; the repaired sibling passes the same acceptance journey and receives a fresh
      verdict, while the original incident and its failure digest remain unchanged.
- [ ] The build/fork comparison report names all artifact/build/runtime/schema/capability
      identities and event boundaries; a planted one-byte event or artifact mutation
      makes `make verify-E11-capstone` fail at the expected link/offset.
- [ ] `evidence/e11-capstone-freshness.json` and
      `evidence/e11-capstone-comparison.json` bind the promoted build and compared runs
      to their exact fingerprints, manifests, offsets, and digests; changing one bound
      input makes the cold verifier refuse the stale report.
- [ ] The named Replay QA journey and epic-closing exploration are attached and cited in
      `evidence/e11-capstone-replay.json`; the journey shows the user-visible seeded
      failure and repair flow, has zero console errors, and its displayed identity/offsets
      match independently replayed platform-stream evidence.
- [ ] An independent critic can cold-replay the evidence without production credentials,
      confirms the builder and critic are distinct sessions, and verifies every behavioral
      change as executed, justified, or removed; its verdict and coverage report are
      included in `evidence/e11-capstone-verdict.json`.
- [ ] No lifecycle stage writes application state outside the authorized platform dispatch
      door or treats browser recordings as authoritative state; traces show zero live
      customer data, production credentials, and unapproved external effects.
- [ ] The task reaches `verified` only after a fresh critic records the verdict; the queue
      is generated from task frontmatter, and no direct status or project-state write is
      used to make the epic appear complete.
- [ ] The capstone evidence and documentation state that model-training reuse is out of
      scope and speculative, with no training pipeline, dataset export, or training-data
      contract shipped by this epic.

## Adversarial verification

1. Run the whole scenario from a clean clone/profile/data directory and independently
   predict the expected offsets and digest links before inspecting the reports. Any
   warm-state dependency, missing stage, or mismatch refutes the capstone.
2. Change the deployed artifact after its verdict, alter one build/runtime/schema input,
   and attempt promotion. If the lifecycle still reaches deployment or the report omits
   the stale link, freshness is refuted.
3. Trigger the seeded regression with different captured input and with a missing event
   range. Any run claimed as the original reproduction without matching input digest,
   offset, and state digest refutes incident replay.
4. Sabotage the repair in the sibling and attempt to mutate the original incident while
   repairing. A passing verdict, changed incident digest, or stale evidence reuse refutes
   repair isolation and verification.
5. Delete or substitute each provenance edge in turn: deployment, incident, restore,
   comparison, verdict, and candidate. A green offline audit refutes chain integrity.
6. Mutate one browser-visible step while keeping stream events stable, then mutate one
   authoritative event while keeping the recording stable. The Replay and stream evidence
   must expose their distinct changes; any one layer being treated as a replacement for
   the other refutes the evidence model.
7. Attempt unauthorized incident intake and plant a secret canary in captured inputs.
   Any task append, private reference leak, or missed canary refutes authorization or
   redaction.
8. Search source, scripts, evidence, and task artifacts for any training-data export,
   model-training execution, or hidden consent assumption. Any such implementation is
   outside this task and blocks verification; future training research requires a
   separate privacy/consent gate.

## Roadmap alignment — 2026-10-16

E12 delivers Forest hosting now; this epic is later provenance-aware operation of hosted
applications. Deployment, restoration, comparison, incident and repair records pin the E14
source changeset and complete file-version/content-manifest hash in addition to tested build
and authoritative state offsets. Stale source/content identity invalidates evidence even when
a branch name or artifact label is unchanged. Derived diffs remain in memory; textual patches
persist only in redacted agent tool logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
