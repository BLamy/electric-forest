---
id: E8-T06
epic: 8
title: "Production self-host bootstrap: import electric-forest, prove parity, cut over once, and publish the stream-native project as canonical"
priority: 806
status: pending
depends_on: [E8-T05]
estimate: L
capstone: false
---

## Goal

The production electric-forest service hosts this repository as its canonical
stream-native project. An operator runs the reviewed `tools/self-host/bootstrap.ts`
against an explicit production target: it captures an immutable selected source object,
creates and verifies the import plan, executes/resumes import, clones and builds the
stream result in a Git-free audit workspace, requires two-person confirmation of the
printed source/destination digest equation, dispatches the irreversible source cutover,
and publishes the canonical project URL. The resulting project contains the full source
and `.eforest` task system, reports `sourceMode=stream-native`, and refuses every import
bridge mutation thereafter.

## Context

E8-T05 made the choreography deterministic on a disposable instance. This task performs
the one production state transition that the capstone needs. It is deliberately separate
from E8-T07: bootstrap proves the mirror is honest and ready; the capstone proves it can
change itself. The bootstrap cannot be considered verified from a local transcript alone.
Its evidence includes server stream dumps/digests and a browser recording of the hosted
project, attached to the project entity so an independent critic can interrogate it.

Production identity and endpoint values live in operator-supplied environment/secrets,
not committed files. The committed `self-host.json` contains only stable public identity
(`org`, `project`, `repo`, default branch, required source mode) and schema version. The
script has `--check` and `--execute`; `--check` is read-only and safe to repeat. There is
no rollback after cutover; a pre-cutover failure leaves an incomplete import that is not
canonical, and the operator starts a new destination according to the runbook.

This task is the handoff across the mirror. The selected source object contains E8-T06
at `status: implemented` with the builder's claim and bootstrap evidence. After cutover,
a fresh critic audits that evidence against production, appends its verdict, and changes
E8-T06 to `verified` through the hosted task stream. The old Git checkout is deliberately
not updated with that verdict and is never consulted as source again. The stream-built
queue must then name E8-T07 as next. Any workflow that needs to sync the verdict back to
Git has failed to retire the bridge.

## Deliverables

- `self-host.json` — versioned public identity of the canonical hosted project, with no
  credentials, tokens, machine paths, or Git remote.
- `tools/self-host/bootstrap.ts` — check/execute state machine, receipt persistence,
  explicit digest confirmation, cutover, evidence upload, and canonical URL output.
- `tools/self-host/audit.ts` — read-only production audit of provenance chain, project/
  branch/task indexes, current main offset/digest, `.eforest` presence, source mode,
  evidence resolution, and bridge-fence probes.
- `tools/self-host/README.md` — exact preconditions, two-person approval, incomplete-
  import recovery, no-rollback boundary, credential handling, and evidence checklist.
- `make verify-E8-T06` (`verify-E8-bootstrap` is a descriptive alias) for script behavior against a disposable production-shaped
  server, plus the actual production run's redacted transcript, signed approvals, plan/
  receipt/audit digests, server dump hashes, canonical URL, and Replay recording attached
  both under this task's `evidence/` and to the hosted project.

## Acceptance criteria

- [ ] `make verify-E8-T06` (which runs `verify-E8-bootstrap`) exits 0 from a cold clone and reruns the full E8-T05
      rehearsal before enabling the execute path; all scripted failure modes happen on a
      disposable target, never the live project.
- [ ] `tools/self-host/bootstrap.ts --check` against production is read-only: request
      trace has zero mutation methods, all production head offsets/digests remain equal,
      and output names the selected immutable source object and destination identity.
- [ ] The executed production plan digest, source object, expected tree digest, imported
      server replay digest, Git-free clone digest, receipt, and cutover tuple are mutually
      byte-equal where specified; values and resolving offsets are in the redacted
      production audit artifact.
- [ ] The Git-free audit workspace contains `.eforest/project.json`, `.eforest/loop.md`,
      every E0–E8 task readme existing at the selected source object, and no `.git`; root
      gates plus production-safe verify-list audit pass there with Git blocked.
- [ ] Two distinct operator approvals cite the same plan digest, source object, server
      head, and tree digest before the cutover request is sent; mismatch or missing
      approval causes zero cutover events.
- [ ] Production has exactly one `project.source-cutover`, `ef source audit` returns
      `stream-native`, and post-cutover import execute/resume/finalize probes are refused
      log-neutrally with pinned reasons.
- [ ] The imported task stream starts with E8-T06 `implemented`; a fresh post-cutover
      critic resolves the production evidence, alone sets it to `verified`, and the
      hosted queue then names E8-T07 next. Process/file traces show the retired Git
      checkout receives no verdict/status write and is not read after cutover.
- [ ] The canonical project URL loads for an authorized browser, exposes source mode,
      main offset/digest, full task board including E8-T07, and resolvable bootstrap
      evidence with zero console errors. The Replay recording is cited in the Verification
      log and attached to the project.
- [ ] Running bootstrap again after completion exits with `already-stream-native`, sends
      no mutation, and leaves every audited head/digest byte-identical.
- [ ] No secret appears in committed config, transcript, stream payloads, browser DOM,
      or Replay network bodies; a deterministic redaction scanner reports zero findings
      and its planted-secret self-test goes red.
- [ ] Root gates and `verify-E8-T05` pass at the selected source object before the
      production execute confirmation.

## Adversarial verification

1. Independently fetch the selected source object and production dumps, then recompute
   every digest without the bootstrap script. One mismatch, missing path, or unresolved
   provenance offset blocks cutover or refutes the completed bootstrap.
2. Attempt execute with one approval, approvals over different digests, stale production
   head, expired credential, or an already-used destination. Any cutover or hidden append
   before all guards pass refutes operator safety.
3. Run the post-cutover bridge probes with a critic credential and inspect all affected
   streams before/after. A single accepted import event refutes retirement.
4. Audit the Git-free clone while `git` is a failing shim and `.git` is absent. Any gate
   or project audit that consults Git refutes capstone readiness.
5. Search raw and redacted evidence plus the Replay recording network payloads for real
   token canaries planted in a disposable rehearsal. A scanner that misses its planted
   value refutes the secrecy apparatus.
6. Open the canonical URL from a fresh browser profile and match DOM offsets/digests to
   independently queried server state. A page showing cached/staging data refutes
   production identity.
7. Re-run `--check` and completed bootstrap while tracing requests. Any mutation on a
   supposedly read-only/idempotent path is an evidence-backed finding.
8. Trace the handoff verdict: it must be written to the hosted task stream by a fresh
   critic after cutover. A Git-side status edit, importer resume, or builder-issued
   `verified` event refutes the transition to self-hosted governance.

## Verification log
