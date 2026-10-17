---
id: E12-T11
epic: 12
title: Connect the local CLI and mirror private projects through the hosted gateway
priority: 522
status: pending
depends_on: [E12-T10]
estimate: L
capstone: false
---

## Goal

After real web login, the operator can configure the local `ef` CLI, authenticate with a
revocable token, import an explicitly selected private project and send subsequent local
changes to the hosted app through its authenticated gateway. Dedicated disposable
fixtures prove the path before any real project is uploaded. Native Auth0 device login
is a later optional integration; the existing web-minted token contract is enough for
this first setup and requires no additional provider key or API audience.

## Context

The current package is private/unpublished: provide a reproducible local build/launcher,
not a claim that `npm install @eforest/cli` already works. Existing `ef init` and uplink
create/append raw streams, which are intentionally private on Railway. Adapt the hosted
path to authorized application dispatch/projections; never expose the provider as a
shortcut. Existing gateway full-file `contentEvent` support is a candidate to reuse.
Legacy local commands and their verified history remain supported.

The human requested complete file versions and changesets instead of persisted diffs.
For this first hosted path use full-file writes and persist no generated patch/comparison
bodies. E14 still supplies the complete content-addressed changeset format/migration;
this task cannot label the legacy stream format as that completed model.

## Deliverables

- Reproducible local CLI installation/invocation and a production server profile using
  public settings, with explicit help and actionable typed errors.
- Secure token setup from the existing authenticated web-token settings, stored atomically
  under a 0700 directory/0600 file and bound to the intended HTTPS origin.
- Gateway-only private initial import, exact readback/status and an explicitly invoked
  one-way uplink/watch path; finite retry/reconnect and revocation behavior.
- `make verify-E12-T11`, stream dumps/digest comparisons, dedicated local-project fixtures,
  browser proof of the mirrored files/updates and a concise first-real-project preflight.

## Acceptance criteria

- [ ] Ordered immutable root gates and cold-clone `make verify-E12-T11` pass without
      a published package/global development daemon. An actual local launcher invokes the
      tested build and configured production origin; the documented commands are executed
      against the hosted candidate with dedicated data before operator use.
- [ ] CLI setup accepts a token through stdin or a masked prompt, never a command-line
      secret/chat/source file, verifies the grant before saving and stores it atomically
      with the declared permissions. A stored profile binds credentials to exactly one
      approved HTTPS origin. Wrong origin, redirected credential requests, revoked/unknown
      token and unsafe transport overrides fail before secret transmission or mutation.
      A disposable secret canary is absent from console/log/evidence/shell arguments.
- [ ] A dedicated authenticated user imports a private fixture repository through gateway
      dispatch, creating its own project/repository/branch/files without raw stream
      creates/appends. Requests exercise text, binary, empty and nested files, with frozen
      expected local bytes/tree digest. Authorized readback and independent replay exactly
      equal those bytes/digests; another tenant and anonymous profile cannot read/follow or
      write its metadata/content. Missing org/forbidden/conflict inputs fail explicitly.
- [ ] Preflight freezes and displays selected root, included/excluded paths, file/byte
      count and declared file/body limits before the first real-project upload. It applies
      existing ignore rules, excludes CLI/git/dependency/credential state, refuses unsafe
      symlinks/traversal and oversized input before remote mutation, defaults to private,
      and touches no other local project. The human names the real first project; no
      unrelated workspace is uploaded or overwritten by inferred permission.
- [ ] Explicit one-way uplink sends full-file updates through the same authorized gateway;
      create/edit/rename/delete, disconnect/reconnect and uncertain-response retry converge
      without duplicate accepted effects or lost local bytes. Revocation stops future
      mutation/follow. No new hosted event/journal/evidence stores a generated textual
      patch/diff; legacy verified logs remain untouched and E14 remains pending.
- [ ] Named journey `E12-T11 local CLI to hosted private project` in configured Replay QA
      project `proj-electric-forest-ms8w0nv1` uses dedicated fixture identities/data, shows
      imported content and a live CLI update without reload, and exercises refusal/logout.
      DOM offsets/digests equal committed independent replay; zero console/page errors.
      Use the explicit existing `Replay: N/A (<reason>) + mitigation` fallback if unavailable.
- [ ] Actual deployed source/image/config and CLI build/profile identities are bound in
      the evidence manifest. Restart preserves accepted imports and updates. Production
      owner tokens/private project contents never enter committed or remote QA evidence;
      an optional operator receipt records only chosen path, revision and redacted result.
- [ ] Two fresh committed readers agree before builder and after lifecycle writes; a
      fresh pre-critic freezes the finite threat model and a separate fresh critic alone
      verifies. Previous verdicts, run accounting, controls and project stops are unchanged.

## Adversarial verification

1. Disable the gateway auth check or point token setup at another/redirecting origin;
   corresponding refusal/leak sensors must turn red before any accepted mutation.
2. Attempt hosted import with all raw routes returning 404. A raw read/create/append,
   a skipped content upload or a digest derived only from the code under test fails proof.
3. Use another tenant, anonymous or a revoked token against private metadata/content and
   follow, including an already-live follower. Cite unchanged offsets for refused writes.
4. Supply ignored secrets, escaping symlinks/traversal, duplicate/invalid paths, a file
   above the frozen limit and binary/empty content. Check preflight is mutation-free.
5. Drop an accepted response, disconnect/reconnect and restart during local updates; replay
   independently and check exact bytes, finite retry and no duplicate accepted effects.
6. Change one fixture byte, freeze the browser digest or choose a patch in the hosted
   uplink in scratch. Each independent check must fail; retain no generated diff artifact.

## Verification log
