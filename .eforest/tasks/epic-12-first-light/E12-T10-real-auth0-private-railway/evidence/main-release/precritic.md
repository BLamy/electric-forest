# Main release pre-critic — finite frozen threat model

Frozen hosting: `d35834a0a677ba3b5c0ecc96f1e034035807afa8`.
Frozen main: `bd56c79feb8ada96736e7b6d2e79eb71738ea3a3`.
Audited/deployed runtime: `9a5861e82ec99ab2f275181a527aab5c2bfb0622`.

This is the fresh read-only pre-implementation report for the user-directed merge
and automatic deployment extension of E12-T10. It is not a task verdict or evidence
that a new release already works.

## Scope and boundary

Integrate these two frozen histories, publish an evidence-bearing PR to main, and
observe native Railway deployment from the actual resulting main commit. Preserve
the dedicated private service, source identity, historical proof and honest task
state. The user expressly authorized this publication. This does not qualify the
remaining public-launch, CLI, E14 or E15 backlog.

The existing connected Railway GitHub integration can provide deployment on merge
without a second deploy workflow or a deploy token. Root also plans GitHub CI on PRs
targeting main and pushes to main, using Node 24.20.0/pnpm 10.15.0 and the four ordered
gates. Configuring these is not evidence that a successful automatic run occurred.

## Concrete merge pitfalls

- There are 65 main-only and 32 hosting-only commits and two merge bases. Main has E6
  task/runtime work and a later Docstream dependency update. Hosting has substantial
  UI migration and the Auth0/private-runtime boundary. Whole-file conflict selection
  in shared UI/gateway/auth code can discard either feature set.
- Main E6-T01 through T04 are verified. Main E6-T05 is implemented after three
  refutations and a progressing checkpoint; E6-T07 is implemented. Hosting currently
  marks these pending with empty logs. Retain their real committed histories and
  evidence; keep T01–T04 verified. Explicit human-directed deferral of unfinished
  T05/T07 can retain T10 as the sole active task, without erasing findings or resetting
  histories. Do not newly classify them verified or claim findings are closed.
- Main legacy critic headings differ from the strict judge-round parser. Preserve
  their exact bytes and attest separately. Do not broaden trusted parsing or report
  zero historical runs merely because a narrow parser omits those headings.
- The trusted snapshot CLI requires exactly one parent for an ordinary lifecycle
  transition. A two-parent merge is a publication/integration commit. Do not disguise
  it as a successful role-specific lifecycle transition or weaken that check. A
  subsequent lifecycle append can be a separate single-parent child.
- Dockerfile.production defaults EF_BUILD_REVISION to RAILWAY_GIT_COMMIT_SHA, but an
  explicitly fixed service value overrides that build default. At runtime a
  conflicting explicit revision safely refuses startup. Remove the old fixed9a
  variable before automatic deployment and prove the new image names actual main.
- A default root railway.toml/railway.json previously selected the preview recipe.
  Preserve its removal. Actual build/start/volume/overlap evidence matters more than
  desired settings alone.

## MR-P1 — Both product histories survive

Prediction: final main has both frozen tips as ancestors. Main's tasks/loop gateway,
route, reducer and package integrations coexist with hosted Auth0, private storage
and agent/integration refusal. Existing UI migration and later main UI work are
semantically reconciled.

Checks: freeze refs and conflict paths; prove both ancestors with Git; classify
every conflict by both sides' intent; inspect final changed-file/version manifest;
run immutable merged-source root gates and focused E6 and E12-T10 checks. Keep main's
package dependencies and lockfile consistent, including @eforest/tasks, @eforest/loop
and the later Docstream update. Check source imports before retaining deleted legacy
RepoChrome/styles; avoid preserving dead old UI solely to avoid a conflict.

Risk: ancestry proves reachability, not that the resolved code retains behavior.
Old9a gates and real-login receipts cannot prove conflicting merged source.

## MR-P2 — Proof history and lifecycle stay honest

Prediction: full main E6-T01–T07 Verification-log byte ranges and evidence survive.
T01–T04 remain verified. T05/T07 deferral records their former implemented state,
human authority and preserved unfinished findings. T10 remains in-progress/run0.
No history, checkpoint or ceiling is reset; no other task becomes newly verified.

Checks: compare frozen log hashes in precritic.json and exact preserved substrings;
preserve branch historical logs/evidence; regenerate queue; inspect exactly one
active gate; run the existing trusted T10 attester with two independent committed
readers. Separately verify main legacy log bytes that strict target parsing does not
count. Existing administrative deferral precedent is 2b22ae7da26fead21004d6f9f45d353efebcbe2d.

Risk: restoring all main statuses verbatim makes T05, T07 and T10 active together.
Silently retaining hosting pending statuses loses later main proof state. Neither
is acceptable without explicit reconciliation. Do not invent a new progress audit.

## MR-P3 — Trusted controls remain unchanged

Prediction: keep controls at the trusted hosting versions, including the already
authorized current AGENTS publication routing. The ordinary merge publication is
distinguished from any subsequent single-parent lifecycle append.

Checks: hash control-root paths before/after; record actual merge parents; never alter
transitionBaseIsDirectParent or legacy-heading acceptance to make this operation pass.
Readback of a lifecycle append must use the trusted pre-write source against its
single-parent child. All exact prior log ranges remain pinned.

Risk: current main differs in AGENTS publication routing, while workflow/attester/
queue-builder control sources otherwise agree in scoped inspection. Whole-file main
selection for AGENTS would revert the user's current publication instructions.

## MR-P4 — Main-only native automatic deployment really fires

Prediction: Railway's connected source is BLamy/electric-forest, branch main,
automatic deploy enabled, and no fixed source commit. A GitHub merge into main causes
a deployment whose source equals that actual merge SHA without a manual deploy call.

Checks: capture source/autodeploy/pin settings before/after; inspect watch filters and
wait-for-CI behavior; record GitHub merged PR/main SHA and native Railway trigger,
deployment ID, build/image result and successful status. Branch push alone should not
be production's configured source. Do not add a competing token-based deploy trigger.

Risk: branch text alone is insufficient when a commit pin, disabled automatic deploy,
filter, failed CI or disconnected integration prevents the actual trigger. If only
configuration can be observed, report configured-only rather than deployed-on-merge.

## MR-P5 — Every automatic image identifies the exact new commit

Prediction: Railway source, baked artifact revision, /healthz, /api/build,
/api/deployment and visible build indicator all identify the new main merge SHA.
No stale fixed EF_BUILD_REVISION=9a5861... remains. Full revision validation and
artifact/runtime mismatch refusal stay intact.

Checks: remove stale manually fixed revision; inspect native per-build commit input
and actual build logs; record image/artifact digests and all public build identities.
If source handling changes, a cheap independent missing/invalid/mismatched-revision
negative check must still fail closed. Runtime currently reads baked manifest when
the explicit variable is absent, so no product-code relaxation is necessary.

Risk: a stale variable can either mislabel newly built bytes or cause safe startup
refusal. A successful deployment status with the old visible revision fails this claim.

## MR-P6 — Production storage and auth boundary survive rollout

Prediction: actual build uses Dockerfile.production and hosted-bin.js; one replica,
zero overlap, /readyz/60 seconds, 15-second drain and the same dedicated private volume
at /data remain. EF_DATA_DIR stays /data/forest-private. Preview/starter services stay
unchanged. New production remains healthy with correct Auth0 callback/private refusal.

Checks: capture exact supported service/build/start/scale/health/overlap/drain/volume
bindings; inspect actual build/start logs; probe health/readiness/assets and anonymous
private refusal. With the existing authenticated session, compare prior synthetic
acceptance mutation/digest and login after the authorized rollout where available.
Do not present fixture restart as the separate real-operator persistence proof.

Risk: an automatic rollout is operationally a restart of private state. Correct
deployment status alone does not prove retained data/session or zero mutation overlap.
Keep any pending persistence proof explicit if its actual outcome is not captured.

## MR-P7 — GitHub CI/publication evidence is concrete

Prediction: an evidence-bearing PR to main states candidate gates, exact source and
remaining scope. If the planned workflow is added, PR-main and push-main event filters
are present, dependencies/submodule are reproducible, install is frozen, gates run
sequentially format/lint → typecheck → test → build, and no deploy secret is introduced.
The actual main check run and native Railway deployment have concrete IDs/URLs.

Checks: use authenticated gh per current AGENTS; attach PR artifact; inspect workflow
permissions, event filters, version pins and commands. Capture successful real check
run tied to merge SHA; inspect native GitHub status/deployment integration. Report
absent branch protection or unavailable required checks honestly, without claiming
protection that was never configured.

Risk: a workflow file alone is configuration evidence. Do not run four package-manager
gates concurrently or inherit historical baseline waivers from main's E6 builder log.
A new merged candidate needs its own ordered successful audit.

## MR-P8 — Claims/evidence remain private and bounded

Prediction: retained new evidence contains public deployment metadata, synthetic data,
hashes and changed-file/version manifests only. Prior9a evidence stays historical.
Only a separate fresh critic can mark T10 verified after all original acceptance.
No launch, T11, E14 or E15 completion is implied by this release operation.

Checks: scan new tracked paths and PR body for secrets/cookies/provider code, state,
nonce/email/private identity and persisted textual diff/patch files. Retain Git blob
versions rather than saved diffs. If managed QA remains unavailable, state literal
Replay: N/A (<reason>) + mitigation with dedicated-fixture browser/stream evidence;
actual production credentials never enter external QA recording.

Risk: production real-login evidence exists for9a; it does not exercise merged E6/UI
changes or complete public multi-user qualification. Keep unavailable evidence explicit.

## Narrow acceptance order

1. Freeze both tips, historical logs and production bindings; reconcile code and
   lifecycle without erasing either branch's evidence or substantive features.
2. Commit immutable integrated candidate; fresh auditor runs the four gates once in
   order, then appropriate focused E6/E12 checks and finite UI/auth proof.
3. Configure native main auto deployment and per-build revision, preserving private
   service boundaries; add the planned GitHub CI without a second deploy path.
4. Publish reviewable PR, merge as requested, observe native merge-triggered deployment.
5. Compare actual GitHub main, Railway source/image/artifact and public/visible builds;
   check health/auth/private storage persistence where captured.
6. Retain T10's original remaining proof/critic obligations and honest in-progress state.

## Provenance

Only this report pair is written under ignored task work. No tracked files, index,
branches, external settings, package-manager gates, cold clones, implementation or
verdict were changed/run. Root supplied the merge-tree conflict list; it was not
independently recomputed. No diff or patch text was stored.
