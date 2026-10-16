# Hosting Electric Forest, then evolving its source model

Planning decision recorded 2026-10-16. These are recommendations and pending backlog
contracts, not claims that a deployment, migration, design review, or verification has
already passed. The requested first release is **public and multi-user**.

The human subsequently authorized implementation and Railway reconfiguration, with
stub integrations on initial deployments. E12-T00 now delivers a separately labeled,
public/disposable preview before production API keys. It uses the real platform and a
private reference server with fixture sign-in; it cannot satisfy E12's production
provider, real-auth or public-release acceptance by itself.

## Railway: what exists and what to add

The connected Railway inventory on 2026-10-16 returned project
`e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448` (`production`), in `us-west2`.
No changes were staged. The latest deployments of all three services were `SUCCESS`;
that describes deployment state, not an independently tested runtime-health result.

| Existing service | Observed source and storage | Role in this plan |
| --- | --- | --- |
| Postgres (`63e4c708-5299-47b1-a9b9-de24633c04ac`) | `gridalpha/electricsql-railway@main`, 5 GB at `/var/lib/postgresql/data` | Preserve; available for a later isolated Electric evaluation |
| electric (`31498f69-9c1a-464c-82cb-da89fa757382`) | `electricsql/electric:latest`, 5 GB at `/data`; no public domain | Postgres Sync service; not yet a qualified Forest stream provider |
| cache (`536dadfb-152a-43d0-a798-1e2b734a4b37`) | Same starter repository; public Railway domain; port 8080 | Starter shape cache; no assumption that it safely proxies Forest sessions or private data |

There is no Forest web/gateway service, no separately identified Durable Streams
service, and no object bucket in this inventory. The starter's
[README](https://github.com/gridalpha/electricsql-railway) describes a Postgres logical
replication setup, an Electric shape service, and an nginx cache. Reusing this Railway
project does not require reusing its database as Forest's source of truth.

The first topology is:

```text
public browsers + ef CLI
        |
        | HTTPS, platform authentication and tenant authorization
        v
Railway: Forest web assets + platform gateway (one mutation-serving replica)
        |
        | server-only transport credentials; validated dispatch
        v
qualified production Durable Streams provider
        |
        +-- authoritative application events, identity and grants
        +-- branch/file history and evidence

existing Postgres -> Electric Sync -> starter cache
        (preserved; separate from Forest's initial authority)
```

Use Electric Cloud/managed Electric Streams as the first candidate, matching the
standing architecture. A production upstream self-hosted provider on Railway is an
alternative to qualify explicitly, not a substitute to assume. Official
[Durable Streams deployment guidance](https://durablestreams.com/deployment)
distinguishes the Node development/reference server, production Caddy plugin, and
managed hosting. The pinned local Node server plus retention patch must not silently
become the public production datastore. Native forks, historical-fork refusal/behavior,
snapshot bootstrap, compaction boundaries, authentication, backups, and provider offsets
all need conformance evidence before selecting a provider. An unsupported reachable
operation is a blocker; a disabled feature needs an explicit scope decision.

The public gateway can be on Railway while its managed stream provider is external.
A requirement to put every service on Railway would change the provider-selection
decision, not the application event model. Keep transport/admin endpoints private or
credential-protected, and route user reads and writes through Forest authorization.
Do not expose transport credentials in the browser or use the starter cache for private
Forest responses without a tenant-safe cache contract.

## Hosting work and first observable deployment

E12-T01 freezes the provider, production profile, finite capacity budgets, backup
objectives, environment-variable names, and conformance matrix. E12-T02 packages one
reproducible web/gateway artifact. E12-T03 fixes production HTTPS/OIDC/session behavior.
E12-T04 then puts a working candidate in this exact Railway environment. This creates
an early hosted milestone while E12-T05–T09 earn the public launch boundary.

Current code identifies concrete work rather than an infrastructure-only exercise:

- `packages/platform/src/bin.ts` supplies a port but no bind host, and
  `packages/platform/src/server.ts` defaults to `127.0.0.1`. The container must accept
  traffic on the appropriate interface at Railway's runtime port.
- The HTTP adapter constructs `http://Host` request URLs. Login callbacks and invite
  links derive from that origin. Use a configured canonical HTTPS origin and a finite
  trusted-proxy policy; hostile Host/forwarded headers must not control redirects.
- Session and login-return cookies need the production secure-cookie contract.
  Pending OIDC transactions and rate counters are process-local today. Keep one
  mutation-serving replica and qualify restart/in-flight-login behavior; overlapping
  deployments need proven fencing or explicit non-overlap.
- `production.ts` must pass a consistent authenticated provider configuration through
  all official-client paths, including identity and StreamFS operations. A base URL
  alone is not a provider credential configuration.
- Add liveness/readiness, request/body bounds, shutdown/draining, redacted logs,
  build identity, and an outage/recovery indication the app can display.

Known runtime inputs include `PORT`, `EF_WEB_ROOT`, `EFOREST_SERVER_URL`,
`EF_OIDC_ISSUER`, `EF_OIDC_CLIENT_ID`, `EF_SESSION_SECRET`, and `EF_SESSION_TTL`.
Provider authorization, public origin, bind-host, and any monitoring configuration are
prospective additions to qualify, not existing environment switches. Pin Node, pnpm,
lockfile, submodule state and required build inputs; resolve any package-registry
authentication through build secrets without copying developer logins into images.
The first public app keeps model execution off unless a separate hosted credential and
sandbox contract is qualified; the local agent harness is not a multi-user sandbox.

Public acceptance includes independently authenticated users in separate organizations,
public/private repository reads, denied writes and subscriptions, signup/invitations,
logout/revocation, concurrent live updates, and secret-free responses. Freeze numeric
traffic/latency/resource limits before measurement. Prove that redeploy and uncertain
write responses do not lose or duplicate accepted mutations. Restore backups into an
isolated destination and compare independently replayed state digests, including
identity and fork ancestry; merely attaching a volume is not a recovery proof.

Replay QA continues through the committed project
`proj-electric-forest-ms8w0nv1` and its managed tunnel against the complete candidate
stack. Focused journeys and the epic-closing exploration retain the repository proof
loop. Add actual deployed-origin multi-account smoke and recovery evidence bound to the
same source/image/configuration identity. A tunnel journey alone cannot prove Railway
networking or production OIDC callbacks. Any unavailable Replay capability must use the
existing explicit `Replay: N/A (<reason>) + mitigation` form.

## Design after hosting

E13 audits actual public journeys before changing the shell again. The output is a
small route/state/terminology contract and a focused shell improvement, using the
existing UI system. Reachability, keyboard behavior, narrow screens, forbidden states,
loading, empty state, reconnect, and stale branch/auth state are acceptance cases.

The product hierarchy to test is organization → project/repository → branch →
changesets, files, reviews, tasks and runs. A **changeset** identifies a source revision;
a **review** negotiates that revision; an **agent run** explains how it was produced;
**evidence** binds a specific revision and test boundary to a verdict. Views should
link these identities without exposing transport configuration or raw logs as ordinary
navigation. E13 specifies the future changeset views; E14 implements their real data.

## Changesets and complete content-addressed versions

The useful precedent from
[Anthropic's Scion article](https://www.anthropic.com/engineering/redesigning-source-control)
is a changeset containing changed-file membership and references to complete immutable
file contents. Forest can adopt that model using its existing dispatch/replay boundary.
It does not need Anthropic's internal storage infrastructure.

Proposed records, to freeze and independently verify in E14:

| Record | Required relationship |
| --- | --- |
| Content object | Versioned hash algorithm, digest of exact uncompressed bytes, byte length, authorized immutable address |
| File version | Stable logical file identity, content reference, file type/mode and version metadata |
| Changeset | Ordered parent IDs, changed paths/file versions or tombstones, actor, task/run provenance, resulting tree digest |
| Branch publication | Changeset ID, expected prior head/fence and idempotency key; one accepted event makes the change visible |
| Claim/review/evidence | Changeset and tested head IDs, source/content manifest hashes, build identity and evidence references |

Hash original bytes without newline or Unicode normalization. Compression must not
change content identity. Identical bytes reuse an object, including an edit returning
to earlier contents. A rename or mode-only change can produce a new file version while
sharing bytes. A digest is an identity, not authorization: knowing a private object's
hash must not reveal its existence or contents outside its scope.

The initial object-store candidate is an authenticated immutable object layer on the
official Durable Streams substrate. E14 must prove write-once completion, digest and
length checks, duplicate upload behavior, and refusal of overwrite/append/delete while
referenced. If the selected provider cannot enforce that contract, stop and obtain an
explicit architecture decision for another store; do not quietly introduce S3 or a
database. Do not implement a second stream transport.

Upload and verify complete objects first. Then publish one fenced changeset event.
Objects staged without a committed reference do not change the repository tree.
Crashes and retries reconcile using durable operation IDs and stream state; this is
not a claim of cross-stream atomic transactions. A tree is reconstructible from source
objects and changesets with every agent transcript absent.

After the migration boundary, no textual diff/patch bodies are persisted in branch,
content, changeset, review, projection, cache, or new evidence records. Review/merge
code computes comparisons in memory from named endpoints. Redacted agent tool logs may
retain patch text for explanation. Coverage artifacts persist changed-file/version
manifests and source locations; a saved unified diff is not required. Legacy verified
patch logs/evidence remain unchanged and are explicitly identified as legacy.

This is an artifact-role rule, not a content-sniffing ban. A tracked `.patch` file or
test fixture containing patch syntax is still an ordinary complete byte-exact source
object. New generated comparison/patch operations must not become persistent artifacts.
Comparison journeys must qualify recording masks/redaction before publication: generated
comparison text and derived payloads stay out of saved QA timelines, screenshots,
console/network bodies, Playwright trace/snapshot artifacts and attached recordings. Retain endpoint identities, changed-file
manifests, comparison-result digests and UI state; the critic independently regenerates
the comparison from full versions. A unique canary proves masking before any upload.
Unsupported masking is an evidence-capability blocker or the existing explicitly
declared AGENTS.md fallback, never permission to retain generated diffs silently.

E14 migrates forward from a pinned legacy offset: replay the old tree, publish a
complete-version baseline, bind old/new digests and source provenance, and use the new
writer thereafter. Keep legacy read/replay compatibility. Update StreamFS, workspace
uplink/downlink, binary handling, branch isolation, snapshots, conflicts, merge and review
as one explicit compatibility program with regression parity; do not rewrite their old
verification records. Retain referenced content throughout backups, branches and evidence
history. Destructive garbage collection is deferred until reachability and retention are
separately proven.

Tool token/delta events can remain fine-grained in agent logs. Source versions are
published on explicit logical saves/checkpoints with a frozen coalescing/latency budget,
not by forcing a full-file upload per token. The live UI follows accepted versions and
may compute temporary highlights between them. E7's old patch-authoritative requirements
are replaced accordingly.

## ElectricSQL and Electric Agents: recommendation and decision boundary

The recommendation is to retain Durable Streams as source authority for the launch,
then test reuse of Electric's higher-level pieces before implementing another agent
scheduler. This is an engineering recommendation, not an experimentally established
performance or reliability result.

| Component | Fit to evaluate | Recommendation now |
| --- | --- | --- |
| Durable Streams / managed Electric Streams | Current append/replay/follow boundary | Keep; qualify the actual production provider in E12 |
| Electric Sync (ElectricSQL) | Postgres-to-client read projections | Evaluate after launch; do not migrate Forest writes just to use the existing template |
| TanStack DB / StreamDB | Client collections or compatible entity projections | Prefer thin adapters where they preserve Forest reducer and authorization contracts |
| Electric Agents runtime | Durable entity runs, tools, wakeups and observation | Strong candidate for a bounded E15 adapter/recovery pilot |
| Complete Agents server/control plane | Registration, scheduling and coordination infrastructure | Inspect actual deployment dependencies and authority before adoption |

[Electric Sync](https://electric.ax/docs/sync/) is documented as a Postgres read-path
sync engine using Shapes. Sharing the Electric ecosystem does not make the starter's
Shape endpoint interchangeable with Forest's Durable Streams endpoint.
[Electric Streams](https://electric.ax/docs/streams/) supplies the durable event-log
primitive. [Electric Agents](https://electric.ax/docs/agents/) builds durable entities,
handlers, runs and tool activity on stream-backed state. Those are different integration
decisions, rather than one wholesale move to ElectricSQL.

The upstream [agent development guide](https://github.com/electric-sql/electric/blob/main/docs/agents-development.md)
currently describes Postgres and Electric services for the self-hosted control plane.
Pin the actual SDK/server releases, source commits and deployment mode in E15: managed
services, a runtime-only adapter and a complete self-hosted server may have different
requirements. Determine which state is authoritative or rebuildable. If adoption adds
relational authority, it needs an explicit architecture amendment and follow-on tasks;
an evaluation verdict is not that authorization.

The pilot must kill/restart an agent, replay duplicate wakeups, revoke access, resume
after a tool's result acknowledgement is lost, and prove the builder/critic separation.
Durable transcripts alone do not prove that an external effect executes exactly once.
Use idempotency keys, fences and reconciliation where the effect provider supports
them; an ambiguous non-idempotent effect must become an explicit unresolved state.
Keep tokens, prompts and private tool output within their declared access boundaries.

E15 ends with independent adopt/decline/conditional decisions and concrete integration
tasks for an accepted option. Declining a component is a valid outcome. Existing E9
qualification tasks reuse the evidence and qualify optional app providers later rather
than repeating discovery. E6 implements only the chosen minimal `AgentAdapter` boundary.

## Backlog and history accounting

No verified task is reopened, no cancelled task is revived and no ledger is renumbered.
The human explicitly authorized deferring E5-T15/E6-T12 to pending to begin hosting.
Their complete prior claims/findings remain, and E5-T15 depends on E12 before
resuming its independent verification. Commit `2b22ae7da26fead21004d6f9f45d353efebcbe2d`
activates E12-T00 alone; two fresh readers agreed using the pre-write committed
attester. This lifecycle change neither grants verification nor resets run accounting.

The production/design/source-model tasks remain pending; E12-T00 is in progress. Existing future tasks retain their identities and scope,
with changed source-model contracts and explicit dependencies. The E9–E11 working-tree
proposal is retained as later platform work. Queue generation and graph/history checks
prove this planning edit's consistency, not product behavior.

Planning evidence: read-only Railway environment/service inventory, the cited official
sources, local source inspection, and generated task/dependency checks.
Replay: N/A (backlog and architectural planning; no product behavior changed) + mitigation:
source-linked decisions, reproducible queue generation, unchanged historical task/log
checks, and independent review of the pending specifications. Stream execution evidence
for the proposed features is explicitly absent until their builders record it.
