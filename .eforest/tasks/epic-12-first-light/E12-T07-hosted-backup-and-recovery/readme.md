---
id: E12-T07
epic: 12
title: Recover hosted state after restart and backup restoration
priority: 527
status: pending
depends_on: [E12-T04]
estimate: M
capstone: false
---

## Goal

A documented hosted recovery procedure restores the complete dedicated fixture state to
an isolated destination within T01's frozen RPO/RTO, preserves branch ancestry and
authorization, and reconciles uncertain writes after restart. Backups have a tested
restore path and ownership; a mounted volume alone is not recovery evidence.

## Context

Authoritative state includes the provider's stream catalog/data and fork/snapshot
dependencies, identity/grants and the configuration needed to interpret them. Board
caches are regenerable and must not become a hidden source of truth. Exercise only
dedicated fixture resources and the Forest candidate; planning does not restart or
alter the user's existing ElectricSQL starter services or copy unrelated user data.

T01 fixes RPO/RTO and the provider boundary. T04 establishes the deployed artifact and
safe replacement process. Restoring a backup is different from replaying a log left
warm in the builder's working tree; the destination starts isolated and cold.

## Deliverables

- Backup schedule/retention configuration and a runbook identifying responsible service,
  encrypted/private storage, configuration/secret recovery requirements and access roles.
- Complete inventory/manifest validation for catalog, events, native forks, snapshots,
  identity/grants and relevant configuration; exclude disposable caches deliberately.
- Restore-to-isolated-destination and candidate-only restart/redeploy/rollback drills
  using the same image identity and a declared compatible provider configuration.
- `make verify-E12-T07`, backup manifest hashes, restore timings and independent digests.

## Acceptance criteria

- [ ] `make verify-E12-T07` exits 0 and emits `evidence/e12-t07-backup-manifest.json` and
      `evidence/e12-t07-restore-drill.json`, naming the source/destination fixture
      resources, backup timestamps, profile hash, image digest, complete inventory and
      measured data-loss/recovery intervals. Both intervals satisfy T01's unchanged RPO
      and RTO; no live production credentials or unrelated data enter committed evidence.
- [ ] A cold isolated destination restores root and child streams, native fork ancestry,
      snapshot/retained history and identity/grant state needed by the seeded app.
      `evidence/e12-t07-restored-streams.jsonl` independently replays twice to the exact
      committed `evidence/e12-t07-digests.json`. The verification fails for a missing
      stream, broken parent reference, unsupported provider restore or altered byte.
- [ ] At the restored destination, authorized fixture users observe the expected files,
      issues and branch state; unrelated and revoked users remain denied. Live follows
      resume from the declared recovered boundary without duplicate reduced effects.
      Dedicated smoke responses, offsets and digest comparisons are in the restore drill.
- [ ] Candidate-only kill/restart/redeploy interrupts a mutation after admission with an
      unknown response. Retrying its operation identity produces one accepted effect;
      acknowledged writes are not lost. Rebuilding with an empty board cache reproduces
      exact state, and the runbook's rollback procedure is executed against the fixture
      target without overlapping unfenced mutation-serving revisions.
- [ ] The backup schedule/retention and restore access configuration are inspected after
      deployment, and one scheduled or schedule-equivalent fixture backup is actually
      restored. A runbook with no produced backup, a volume-only restart or restoration
      into the original warm provider cannot satisfy the task.
- [ ] Journey `E12-T07 recovered hosted state` runs through Replay QA's configured managed
      tunnel in project `proj-electric-forest-ms8w0nv1` against the restored candidate.
      The Verification log cites actual journey/test-run IDs, bugs, console/network and
      attached recordings, with zero console errors and DOM digests matching independent
      replay. Actual isolated deployed-origin restore smoke is additional proof; absent
      QA requires the explicit `Replay: N/A` form and mitigation.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Delete a child stream, its parent reference or identity/grant entry from the backup;
   alter a snapshot byte. Any successful complete-restore verdict refutes inventory and
   integrity checks.
2. Attempt restoration into a warm original provider and omit stream catalog enumeration.
   A pass refutes the cold isolated-destination proof.
3. Drop a mutation response, kill only the fixture candidate and retry after recovery.
   A duplicate effect, lost acknowledgement or changed digest refutes write recovery.
4. Restore with a revoked identity and an empty board cache. Access regained through
   missing grants or state recovered only from the cache refutes authority boundaries.
5. Delay backup creation/restoration past the frozen RPO/RTO and corrupt one recorded
   timing/hash in a scratch evidence bundle. A green result refutes budget sensitivity.
6. Audit the resource IDs before any restart/restore. Touching unrelated starter services,
   original production streams or non-fixture accounts is outside this drill's scope.

## Verification log

