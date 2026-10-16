---
id: E12-T09
epic: 12
title: "Capstone: launch and recover public multi-user Forest on Railway"
priority: 529
status: pending
depends_on: [E12-T05, E12-T06, E12-T07, E12-T08]
estimate: L
capstone: true
---

## Goal

The actual Railway project runs a public multi-user Electric Forest release whose
onboarding, tenant isolation, live source/issue/PR workflow, traffic bounds and recovery
survive independent adversarial verification. One exact deployed artifact is bound to
the browser journeys, provider event history and full epic exploration; a private demo
or planned deployment cannot satisfy the launch.

## Context

This closes the hosting-first milestone before deferred loop/design/storage migration
work. Target project `e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`. T01-T08 are required, with no optional task
exemptions. Their results establish capabilities; this task re-exercises their integration
on one fresh immutable candidate rather than combining recordings of different builds.

Replay QA's configured local managed tunnel remains the required browser evidence
boundary. Actual deployed-origin real-provider smoke is additional launch proof. After
focused journeys pass, run one full open-ended exploration of the integrated epic in
the configured QA project; do not replace it with a local recording or another project.
Use dedicated seeded test users/data and isolated recovery resources.

## Deliverables

- `make verify-E12-T09` and an end-to-end release harness binding source commit, tested
  and deployed image digest, configuration/profile hashes, provider, origin and Railway
  project/environment/service/deployment IDs.
- Dedicated-user public onboarding, collaboration, denial/removal, issue-to-PR/evidence,
  deployment replacement, load-envelope and isolated restore scenario.
- Named focused QA journeys, one epic-closing full exploration, actual deployed-origin
  smoke, frozen stream dumps/digests and an operator launch/recovery runbook.

## Acceptance criteria

- [ ] `make verify-E12-T09` exits 0 from a cold clone and binds
      `evidence/e12-t09-release.json` to one full commit, immutable image digest, T01
      profile hash and the actual public HTTPS Railway origin. Required prior tasks are
      critic-verified. The image reviewed, run in QA and deployed is identical; no
      unreviewed fix or mutable latest image is substituted after the ordered gate audit.
- [ ] Fresh independent users at the real public origin complete provider signup/login,
      account/org/repo creation, invitation and deep-route return. Two authorized users
      observe a live file mutation without reload; the existing issue-to-PR/evidence
      workflow reaches its permitted final state, using the current product's required
      evidence/waiver rules. `evidence/e12-t09-deployed-journey.json` records real outcomes,
      zero browser console errors and DOM offsets/digests matching independent replay.
- [ ] Two seeded tenants pass T05's full public/private access matrix, including anonymous
      access, unrelated users, logout/session switch and membership removal during a
      follow. Refused operations are log-neutral and private responses are not shared
      across users. `evidence/e12-t09-access.json` records every frozen matrix cell.
- [ ] The same release passes T01's exact frozen concurrent-user/follow/writer/rate/duration
      and latency/resource budgets. Every acknowledged mutation occurs once; independent
      clients converge. `evidence/e12-t09-load.json` names the profile hash and measured
      values without lowering thresholds or claiming unbounded scale.
- [ ] Candidate replacement preserves state/sessions and never overlaps unfenced
      mutation-serving revisions. A fresh isolated restore and an uncertain-write retry
      satisfy the frozen RPO/RTO and produce the expected branch/identity/app state;
      `evidence/e12-t09-recovery.json` records actual resource IDs, timings and outcomes.
      Existing unrelated starter services and data are not altered to make the drill pass.
- [ ] `evidence/e12-t09-streams.jsonl` and `evidence/e12-t09-digests.json` cover onboarding,
      authorization, file/issue/PR/evidence changes and recovery boundaries. Independent
      replay twice matches every claimed final digest; event/manifest tampering is
      detected. Runtime build/health/live-read surfaces show the same identities and
      offsets, including a degraded/recovered state distinct from deployment success.
- [ ] Focused journeys `E12-T09 public multi-user release` and `E12-T09 launch recovery and
      denial` pass in Replay QA project `proj-electric-forest-ms8w0nv1` through the
      configured managed tunnel on the release image. Then one full epic-closing
      exploration runs on that image. The claim cites actual project/journey/test-run,
      exploration and bug IDs/URLs, console/network findings and attached recordings.
      An unavailable service is declared with literal `Replay: N/A (<reason>) +
      mitigation`; the doctrine's loud fallback must cover focused and integrated
      behavior and cannot turn a private demo into a public launch.
- [ ] A fresh adversarial critic verifies the exact release evidence/diff and its
      sensitivity, coverage, cold-clone and task attacks before the task becomes verified.
      Two fresh readers attest each committed lifecycle transition; run counts, progress
      checkpoints, role separation, prior ledgers, ordered gates and project stops remain
      intact. No private-only result, missing provider capability or deployment-success
      flag weakens an acceptance gate or resets history.

## Adversarial verification

1. Inspect the actual origin from a fresh browser profile and compare artifact/provider/
   profile identity with every cited QA run, stream dump and restore. A private demo,
   emulator-only login, stale candidate or mixed-build evidence refutes public launch.
2. Use independent identities/seeds to traverse every public/private matrix cell and
   revoke membership mid-follow. Any private leak or refused-write head movement refutes
   the integrated boundary.
3. Interrupt deployment during an admitted write and a connected reader. Concurrent
   unfenced mutation-serving revisions, duplicate effects, lost acknowledgements or
   stale healthy state refute safe hosted operation.
4. Restore a backup into a fresh isolated provider with no warm caches. A missing fork,
   regained revoked permission, wrong digest or RPO/RTO violation refutes recovery.
5. Cross-check load parameters against the T01 profile and mutate one event, build digest
   and response-time measurement in scratch evidence bundles. A passing verifier refutes
   the measuring apparatus.
6. Read the focused runs and full exploration for uncovered changed browser behavior,
   console/network failures and unresolved bugs; map each changed hunk to executed,
   justified waived or removed code. Missing coverage remains needs-evidence.
7. Sabotage one tenant guard and one admission/recovery invariant in a disposable
   worktree. The appropriate permanent suite must fail. Only after cheaper attacks
   survive does the lead critic perform the single required cold-clone audit.

## Verification log

