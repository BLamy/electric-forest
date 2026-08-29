import { stateDigest, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRegistryRecord,
  projectSourceEvent,
  RegistryProjectionError,
  RegistryProjector,
  registryInitialState,
  registryReducer,
  registryStateDigest,
  RegistryStreamCorruptError,
  replayRegistryStream,
} from "../src/index.js";
import { mintedPrefixNames } from "../src/ns/dispatch.js";
import type { StreamAdapter } from "../src/official.js";
import {
  awaitRegistryLength,
  buildLifecycleTree,
  dispatchHttp,
  nsEvent,
  openSseTail,
  registryHttpFixture,
  type RegistryHttpFixture,
} from "./registry.helpers.js";

const ALICE = "auth0|alice";
const BOB = "auth0|bob";
const CAROL = "auth0|carol";
const DAVE = "auth0|dave";

const fixtures: RegistryHttpFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

async function setup(): Promise<RegistryHttpFixture> {
  const fixture = await registryHttpFixture();
  fixtures.push(fixture);
  return fixture;
}

async function accepted(response: Response): Promise<void> {
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ ok: true });
}

/**
 * The frozen suppression window: hold an unauthorized tail connected until at
 * least `budgetMs` past dispatch-accept, then return the actually-held span so
 * the caller can assert `>= budgetMs` before asserting its frame log empty. A
 * leak delivered anywhere inside the live budget (not just before the
 * authorized frame's arrival) must land inside this window.
 */
async function holdSuppressionWindow(acceptedAtMs: number, budgetMs = 2000): Promise<number> {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, acceptedAtMs + budgetMs + 50 - Date.now())),
  );
  return Date.now() - acceptedAtMs;
}

async function getDoor(
  fixture: RegistryHttpFixture,
  path: string,
  sub?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    headers: sub === undefined ? {} : { authorization: `Bearer ${await fixture.token(sub)}` },
  });
  return { status: response.status, body: await response.json() };
}

async function registryDump(
  fixture: RegistryHttpFixture,
): Promise<readonly (Event & { readonly offset: string })[]> {
  try {
    return (await fixture.streams.read("__registry__")) as readonly (Event & {
      readonly offset: string;
    })[];
  } catch {
    return [];
  }
}

const GROVE = {
  org: "acme",
  owner: ALICE,
  project: "web",
  repo: "grove",
  repoStreamPrefix: "fs:acme/forest",
  visibility: "private",
};
const SECRET = {
  org: "acme",
  owner: ALICE,
  project: "web",
  repo: "secret",
  repoStreamPrefix: "fs:acme/secret",
  visibility: "private",
};
const EDGE = {
  org: "beta",
  owner: BOB,
  project: "api",
  repo: "edge",
  repoStreamPrefix: "fs:beta/edge",
  visibility: "public",
};
const OPEN = {
  org: "beta",
  owner: BOB,
  project: "api",
  repo: "open",
  repoStreamPrefix: "fs:beta/open",
  visibility: "public",
};

describe("registry read doors (snapshot)", () => {
  it("answers all three doors, visibility-filtered per identity, with asOf", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const asOf = offsetForOrdinal(10);

    // The renamed repo carries its creation-time stream prefix, byte-identical.
    expect(GROVE.repoStreamPrefix).toBe("fs:acme/forest");

    expect(await getDoor(fixture, "/registry/public")).toEqual({
      status: 200,
      body: { asOf, entries: [EDGE, OPEN] },
    });

    // /registry/org/:org — members see private entries; others the public subset.
    expect(await getDoor(fixture, "/registry/org/acme", ALICE)).toEqual({
      status: 200,
      body: { asOf, entries: [GROVE, SECRET] },
    });
    expect(await getDoor(fixture, "/registry/org/acme", CAROL)).toEqual({
      status: 200,
      body: { asOf, entries: [GROVE, SECRET] },
    });
    expect(await getDoor(fixture, "/registry/org/acme", DAVE)).toEqual({
      status: 200,
      body: { asOf, entries: [] },
    });
    expect(await getDoor(fixture, "/registry/org/acme")).toEqual({
      status: 200,
      body: { asOf, entries: [] },
    });
    expect(await getDoor(fixture, "/registry/org/beta", DAVE)).toEqual({
      status: 200,
      body: { asOf, entries: [EDGE, OPEN] },
    });
    expect(await getDoor(fixture, "/registry/org/beta", BOB)).toEqual({
      status: 200,
      body: { asOf, entries: [EDGE, OPEN] },
    });

    // /registry/me — owned + member-org, nothing else (not the world's public repos).
    expect(await getDoor(fixture, "/registry/me", ALICE)).toEqual({
      status: 200,
      body: { asOf, entries: [GROVE, SECRET] },
    });
    expect(await getDoor(fixture, "/registry/me", CAROL)).toEqual({
      status: 200,
      body: { asOf, entries: [GROVE, SECRET] },
    });
    expect(await getDoor(fixture, "/registry/me", BOB)).toEqual({
      status: 200,
      body: { asOf, entries: [EDGE, OPEN] },
    });
    expect(await getDoor(fixture, "/registry/me", DAVE)).toEqual({
      status: 200,
      body: { asOf, entries: [] },
    });
  });

  it("requires E2-T03's exact 401 on /registry/me and filters (never 403s) /registry/org", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const missing = await fetch(`${fixture.baseUrl}/registry/me`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: "unauthorized", reason: "missing_bearer_token" },
    });
    // A presented credential that resolves to no grant is refused, not
    // silently anonymous.
    const grantless = await fetch(`${fixture.baseUrl}/registry/me`, {
      headers: { authorization: `Bearer ${fixture.grantlessToken(DAVE)}` },
    });
    expect(grantless.status).toBe(401);
    expect(await grantless.json()).toEqual({ error: { class: "token-revoked" } });
    // Non-member org listing filters — same status and shape as a member's.
    const nonMember = await getDoor(fixture, "/registry/org/acme", DAVE);
    expect(nonMember.status).toBe(200);
    expect(nonMember.body).toEqual({ asOf: offsetForOrdinal(10), entries: [] });
    // Unknown org and all-private org are indistinguishable.
    const unknownOrg = await getDoor(fixture, "/registry/org/nonesuch", DAVE);
    expect(unknownOrg).toEqual({ status: 200, body: { asOf: offsetForOrdinal(10), entries: [] } });
  });
});

describe("authenticated registry application projection", () => {
  it("replays through the shared reducer with contiguous private-safe offsets", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const response = await fetch(`${fixture.baseUrl}/registry/me?projection=1&reducer=registry`, {
      headers: { authorization: `Bearer ${await fixture.token(ALICE)}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly (Event & { readonly offset: string })[];
      readonly checkpoint: string;
      readonly reducer: { readonly id: string; readonly version: number };
    };
    expect(body.reducer).toEqual({ id: "registry", version: 1 });
    expect(body.events.map((event) => event.offset)).toEqual(
      body.events.map((_, index) => offsetForOrdinal(index)),
    );
    const state = replayRegistryStream(body.events);
    expect(Object.keys(state.orgs.acme!.repos).sort()).toEqual(["grove", "secret"]);
    expect(Object.keys(state.orgs.beta?.repos ?? {})).toEqual([]);
    expect(registryStateDigest(state)).toBe(stateDigest(state));
    expect(body.checkpoint).toBe(body.events.at(-1)!.offset);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('"edge"');
    expect(wire).not.toContain('"open"');
    expect(wire).not.toContain("fs:beta/");
  });

  it("follows from the projected checkpoint without exposing hidden-event gaps", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const token = await fixture.token(ALICE);
    const initial = await fetch(`${fixture.baseUrl}/registry/me?projection=1&reducer=registry`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const bootstrap = (await initial.json()) as {
      readonly events: readonly unknown[];
      readonly checkpoint: string;
    };
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:beta",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "beta-private", project: "api", visibility: "private" },
          20,
        ),
        BOB,
      ),
    );
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "sprout", project: "web", visibility: "private" },
          21,
        ),
        ALICE,
      ),
    );
    await awaitRegistryLength(fixture, 13);
    const followed = await fetch(
      `${fixture.baseUrl}/registry/me?projection=1&reducer=registry&live=1&checkpoint=${encodeURIComponent(bootstrap.checkpoint)}&waitMs=0`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(followed.status).toBe(200);
    const body = (await followed.json()) as {
      readonly events: readonly {
        readonly offset: string;
        readonly payload: { readonly repo?: string };
      }[];
      readonly checkpoint: string;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.payload.repo).toBe("sprout");
    expect(body.events[0]!.offset).toBe(offsetForOrdinal(bootstrap.events.length));
    expect(JSON.stringify(body)).not.toContain("beta-private");
  });
});

describe("registry refusals are log-neutral", () => {
  it("refuses ns/repo-not-found, ns/not-owner, rename ns/name-taken, reserved newName — head offset and dump digest byte-identical", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const cases: readonly [string, Record<string, unknown>, string, number, string][] = [
      [
        "ns:org:acme",
        { v: 1, name: "missing", newName: "elsewhere" },
        ALICE,
        409,
        "ns/repo-not-found",
      ],
      // E2-T11 stops a beta-bound subject before replaying acme's namespace;
      // the foreign/private probe is existence-neutral, not ns/not-owner.
      ["ns:org:acme", { v: 1, name: "grove", newName: "meadow" }, BOB, 404, "authz/not-found"],
      ["ns:org:acme", { v: 1, name: "grove", newName: "secret" }, ALICE, 409, "ns/name-taken"],
      ["ns:org:acme", { v: 1, name: "grove", newName: "main" }, ALICE, 409, "ns/reserved-name"],
    ];
    for (const [streamId, payload, sub, status, reason] of cases) {
      const sourceBefore = await fixture.streams.read(streamId);
      const registryBefore = await registryDump(fixture);
      const response = await dispatchHttp(
        fixture,
        streamId,
        nsEvent("ns.repo.rename", payload, 99),
        sub,
      );
      expect(response.status, reason).toBe(status);
      expect(await response.json(), reason).toEqual(
        status === 404
          ? { error: { code: "authz_refused", reason, identityOffset: expect.any(String) } }
          : { error: { class: "validator-rejected", reason } },
      );
      const sourceAfter = await fixture.streams.read(streamId);
      expect(stateDigest(sourceAfter), reason).toBe(stateDigest(sourceBefore));
      expect(sourceAfter.length, reason).toBe(sourceBefore.length);
      const registryAfter = await registryDump(fixture);
      expect(stateDigest(registryAfter), reason).toBe(stateDigest(registryBefore));
    }
    // set-visibility shares the taxonomy.
    for (const [payload, sub, status, reason] of [
      [{ v: 1, name: "missing", visibility: "public" }, ALICE, 409, "ns/repo-not-found"],
      [{ v: 1, name: "grove", visibility: "public" }, BOB, 404, "authz/not-found"],
    ] as const) {
      const before = await fixture.streams.read("ns:org:acme");
      const response = await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent("ns.repo.set-visibility", payload as unknown as Record<string, unknown>, 99),
        sub,
      );
      expect(response.status, reason).toBe(status);
      expect(await response.json(), reason).toEqual(
        status === 404
          ? { error: { code: "authz_refused", reason, identityOffset: expect.any(String) } }
          : { error: { class: "validator-rejected", reason } },
      );
      expect(stateDigest(await fixture.streams.read("ns:org:acme")), reason).toBe(
        stateDigest(before),
      );
    }
  });

  it("payload actor fields and malformed shapes are 422 schema-violation", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    for (const payload of [
      { v: 1, name: "grove", newName: "meadow", actor: { sub: ALICE } },
      { v: 1, name: "grove" },
      { v: 2, name: "grove", newName: "meadow" },
      { v: 1, name: "grove", newName: "meadow", extra: true },
    ]) {
      const response = await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent("ns.repo.rename", payload, 99),
        ALICE,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { class: "schema-violation" } });
    }
  });
});

describe("__registry__ is server-only", () => {
  it("refuses a dispatch and a raw protocol append targeting __registry__, log-neutrally", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const before = await registryDump(fixture);
    expect(before.length).toBe(11);

    // Dispatch: an application event aimed at the derived stream — the frozen
    // internal-target refusal (existence-neutral authz/not-found).
    const dispatch = await dispatchHttp(
      fixture,
      "__registry__",
      nsEvent("registry.repo-added", { v: 1, anything: true }, 1),
      ALICE,
    );
    expect(dispatch.status).toBe(404);
    expect(await dispatch.json()).toMatchObject({
      error: { code: "authz_refused", reason: "authz/not-found" },
    });

    // Raw protocol append: the platform door exposes no stream-protocol
    // surface at all — the frozen not_found door refusal, nothing appended.
    const raw = await fetch(`${fixture.baseUrl}/streams/${encodeURIComponent("__registry__")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await fixture.token(ALICE)}`,
      },
      body: JSON.stringify({ type: "registry.org-added", payload: { forged: true }, ts: 1 }),
    });
    expect(raw.status).toBe(404);
    expect(await raw.json()).toEqual({
      error: { code: "invalid_request", reason: "not_found" },
    });

    const after = await registryDump(fixture);
    expect(stateDigest(after)).toBe(stateDigest(before));
    expect(after.length).toBe(before.length);
  });
});

describe("registry live tails", () => {
  it("delivers an accepted ns.repo.create as an SSE frame within 2000ms, offset-cited, while an anonymous tail of the same private creation receives nothing", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const head = offsetForOrdinal(10);
    const authorized = await openSseTail(
      `${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`,
      {
        authorization: `Bearer ${await fixture.token(ALICE)}`,
      },
    );
    const anonymous = await openSseTail(
      `${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`,
      {},
    );
    const dispatchedAt = Date.now();
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "vault", project: "web", visibility: "private" },
          12,
        ),
        ALICE,
      ),
    );
    const acceptedAt = Date.now();
    await authorized.waitForFrame(1, 2000);
    const frame = authorized.frames[0]!;
    expect(frame.atMs - dispatchedAt).toBeLessThan(2000);
    // The frame's offset is literal-asserted against the subsequent dump's
    // corresponding registry.repo-added head offset.
    const dump = await registryDump(fixture);
    const added = dump.find(
      (record) =>
        record.type === "registry.repo-added" &&
        (record.payload as { readonly repo?: string }).repo === "vault",
    );
    expect(added).toBeDefined();
    expect(frame.id).toBe(added!.offset);
    expect(JSON.parse(frame.data)).toMatchObject({
      offset: added!.offset,
      type: "registry.repo-added",
      payload: { repo: "vault", visibility: "private", repoStreamPrefix: "fs:acme/vault" },
    });
    // The anonymous tail stayed connected past the authorized frame's
    // arrival and received exactly zero frames for the private creation…
    expect(anonymous.frames).toEqual([]);
    // …and is HELD until at least 2000ms past dispatch-accept (the frozen
    // live budget) before its frame log is re-asserted empty: a hidden frame
    // delivered late-but-within-budget must be caught here, not slip past an
    // assertion pinned to the authorized frame's (much earlier) arrival.
    const heldMs = await holdSuppressionWindow(acceptedAt);
    expect(heldMs).toBeGreaterThanOrEqual(2000);
    // Liveness sensed AT the hold instant (run-3 verdict: a dead tail must
    // not satisfy the suppression clause): the stream is still open and a
    // server heartbeat arrived after dispatch-accept — throws with the exact
    // dead-tail reason otherwise.
    anonymous.assertAliveSince(acceptedAt, "anonymous tail");
    expect(anonymous.frames, "anonymous tail leaked within the held 2000ms window").toEqual([]);
    // Positive-frame sensor on the SAME held tail: a public creation now
    // delivers a visible frame to the connected anonymous tail — a tail a
    // sabotage closed early cannot receive it.
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "commons", project: "web", visibility: "public" },
          13,
        ),
        ALICE,
      ),
    );
    await anonymous.waitForFrame(1, 2000);
    expect(anonymous.frames.length, "anonymous tail received exactly the public frame").toBe(1);
    const publicDump = await registryDump(fixture);
    const commonsAdded = publicDump.find(
      (record) =>
        record.type === "registry.repo-added" &&
        (record.payload as { readonly repo?: string }).repo === "commons",
    );
    expect(commonsAdded).toBeDefined();
    expect(anonymous.frames[0]!.id).toBe(commonsAdded!.offset);
    expect(JSON.parse(anonymous.frames[0]!.data)).toMatchObject({
      type: "registry.repo-added",
      payload: { repo: "commons", visibility: "public" },
    });
    authorized.close();
    anonymous.close();
  }, 60_000);

  it("repeats the live proof under long-poll and suppresses a public→private flip from a held-open anonymous tail", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const head = offsetForOrdinal(10);

    // Long-poll: authorized waiter sees the freshly dispatched creation.
    const aliceToken = await fixture.token(ALICE);
    const waiting = fetch(
      `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=${head}&waitMs=5000`,
      { headers: { authorization: `Bearer ${aliceToken}` } },
    );
    const anonymousWaiting = fetch(
      `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=${head}&waitMs=3000`,
    );
    const dispatchedAt = Date.now();
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "vault", project: "web", visibility: "private" },
          12,
        ),
        ALICE,
      ),
    );
    const result = (await (await waiting).json()) as {
      readonly after: string;
      readonly frames: readonly { readonly offset: string; readonly type: string }[];
    };
    expect(Date.now() - dispatchedAt).toBeLessThan(2000);
    expect(result.frames.length).toBe(1);
    expect(result.frames[0]!.type).toBe("registry.repo-added");
    expect(result.frames[0]!.offset).toBe(offsetForOrdinal(11));
    expect(result.after).toBe(offsetForOrdinal(11));
    // Literal-assert the long-poll frame's offset against the corresponding
    // registry.repo-added event in a subsequent dump — the same dump-offset
    // equality the SSE half proves, not just a computed ordinal.
    const lpDump = await registryDump(fixture);
    const lpAdded = lpDump.find(
      (record) =>
        record.type === "registry.repo-added" &&
        (record.payload as { readonly repo?: string }).repo === "vault",
    );
    expect(lpAdded).toBeDefined();
    expect(result.frames[0]!.offset).toBe(lpAdded!.offset);
    // The anonymous long-poll waits its full window across the hidden event
    // and returns zero frames — with the raw-offset cursor advanced (frozen:
    // offset metadata is not a leak; it reveals at most hidden event counts).
    const anonymousResult = (await (await anonymousWaiting).json()) as {
      readonly after: string;
      readonly frames: readonly unknown[];
    };
    expect(anonymousResult.frames).toEqual([]);
    expect(anonymousResult.after).toBe(offsetForOrdinal(11));

    // Suppression, SSE: anonymous tail held open across a public→private
    // flip receives exactly zero frames; the authorized tail receives the
    // flip frame (post-event state still visible to the owner).
    const flipHead = offsetForOrdinal(11);
    const authorizedTail = await openSseTail(
      `${fixture.baseUrl}/registry/org/beta?live=sse&after=${flipHead}`,
      { authorization: `Bearer ${await fixture.token(BOB)}` },
    );
    const anonymousTail = await openSseTail(
      `${fixture.baseUrl}/registry/org/beta?live=sse&after=${flipHead}`,
      {},
    );
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:beta",
        nsEvent("ns.repo.set-visibility", { v: 1, name: "open", visibility: "private" }, 13),
        BOB,
      ),
    );
    const flipAcceptedAt = Date.now();
    await authorizedTail.waitForFrame(1, 2000);
    expect(JSON.parse(authorizedTail.frames[0]!.data)).toMatchObject({
      type: "registry.repo-visibility-changed",
      payload: { repo: "open", visibility: "private" },
    });
    // The anonymous tail is still connected after the authorized frame
    // arrived and saw nothing…
    expect(anonymousTail.frames).toEqual([]);
    // …and stays held until >=2000ms past dispatch-accept (the frozen live
    // budget) before the zero-frame suppression clause is re-asserted.
    const flipHeldMs = await holdSuppressionWindow(flipAcceptedAt);
    expect(flipHeldMs).toBeGreaterThanOrEqual(2000);
    // Liveness sensed at the hold instant, exactly as in the SSE creation
    // test: a server-closed tail must fail here, not satisfy suppression.
    anonymousTail.assertAliveSince(flipAcceptedAt, "anonymous tail");
    expect(anonymousTail.frames, "anonymous tail leaked within the held 2000ms window").toEqual([]);
    // A fresh anonymous snapshot no longer lists the flipped repo; the
    // earlier private→public flip made edge visible.
    const publicNow = await getDoor(fixture, "/registry/public");
    expect(
      (publicNow.body as { readonly entries: readonly { readonly repo: string }[] }).entries.map(
        (entry) => entry.repo,
      ),
    ).toEqual(["edge"]);
    authorizedTail.close();
    anonymousTail.close();
  }, 90_000);

  it("filters the long-poll CATCH-UP half over pre-existing hidden events for anonymous and non-member tails", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    // A private creation already ON __registry__ before the tails connect:
    // the catch-up call site (not the follow loop) must filter it out.
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "vault", project: "web", visibility: "private" },
          12,
        ),
        ALICE,
      ),
    );
    await awaitRegistryLength(fixture, 12);
    for (const sub of [undefined, DAVE]) {
      const label = sub === undefined ? "anonymous" : "non-member";
      const response = await fetch(
        `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=-1&waitMs=0`,
        {
          headers: sub === undefined ? {} : { authorization: `Bearer ${await fixture.token(sub)}` },
        },
      );
      expect(response.status, label).toBe(200);
      const body = (await response.json()) as {
        readonly after: string;
        readonly frames: readonly { readonly offset: string; readonly type: string }[];
      };
      // Exactly the two frames whose POST-event state is visible to this
      // identity: repo-added forest (then public) and its rename to grove
      // (still public at that point). Every private frame — repo-added
      // secret, repo-added vault, the grove public→private flip — and every
      // out-of-scope beta frame is suppressed; the raw cursor still advances
      // over all of them (frozen: offset metadata is not a leak).
      expect(
        body.frames.map((frame) => [frame.offset, frame.type]),
        `${label} long-poll catch-up leaked hidden frames`,
      ).toEqual([
        [offsetForOrdinal(2), "registry.repo-added"],
        [offsetForOrdinal(8), "registry.repo-renamed"],
      ]);
      expect(JSON.stringify(body.frames), label).not.toContain("secret");
      expect(JSON.stringify(body.frames), label).not.toContain("vault");
      expect(body.after, label).toBe(offsetForOrdinal(11));
    }
    // The AUTHORIZED half of the same catch-up (run-2 verdict): an acme
    // member replaying from before the org existed must receive the
    // registry.org-added and registry.project-added frames — the two
    // frameVisible arms no anonymous catch-up can ever reach — plus every
    // acme repo frame, all literal-asserted by (offset, type).
    const memberResponse = await fetch(
      `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=-1&waitMs=0`,
      { headers: { authorization: `Bearer ${await fixture.token(CAROL)}` } },
    );
    expect(memberResponse.status).toBe(200);
    const memberBody = (await memberResponse.json()) as {
      readonly after: string;
      readonly frames: readonly { readonly offset: string; readonly type: string }[];
    };
    expect(memberBody.frames.map((frame) => [frame.offset, frame.type])).toEqual([
      [offsetForOrdinal(0), "registry.org-added"],
      [offsetForOrdinal(1), "registry.project-added"],
      [offsetForOrdinal(2), "registry.repo-added"],
      [offsetForOrdinal(3), "registry.repo-added"],
      [offsetForOrdinal(8), "registry.repo-renamed"],
      [offsetForOrdinal(10), "registry.repo-visibility-changed"],
      [offsetForOrdinal(11), "registry.repo-added"],
    ]);
    expect(memberBody.after).toBe(offsetForOrdinal(11));
  });
});

describe("prefix uniqueness (frozen in verification run 2)", () => {
  it("refuses ns.repo.create on a freed name whose creation-time prefix is still claimed, log-neutrally", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    // Golden (a) renamed forest -> grove: the listing name "forest" is free,
    // but the live repo "grove" still carries repoStreamPrefix=fs:acme/forest.
    const sourceBefore = await fixture.streams.read("ns:org:acme");
    const registryBefore = await registryDump(fixture);
    const response = await dispatchHttp(
      fixture,
      "ns:org:acme",
      nsEvent("ns.repo.create", { v: 1, name: "forest", project: "web", visibility: "public" }, 99),
      ALICE,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { class: "validator-rejected", reason: "ns/prefix-claimed" },
    });
    const sourceAfter = await fixture.streams.read("ns:org:acme");
    expect(stateDigest(sourceAfter)).toBe(stateDigest(sourceBefore));
    expect(sourceAfter.length).toBe(sourceBefore.length);
    const registryAfter = await registryDump(fixture);
    expect(stateDigest(registryAfter)).toBe(stateDigest(registryBefore));
    // A live listing-name collision keeps its frozen E2-T06 reason (frozen
    // precedence: ns/name-taken strictly before ns/prefix-claimed)…
    const taken = await dispatchHttp(
      fixture,
      "ns:org:acme",
      nsEvent("ns.repo.create", { v: 1, name: "grove", project: "web", visibility: "public" }, 99),
      ALICE,
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: { class: "validator-rejected", reason: "ns/name-taken" },
    });
    // …and a never-minted name (a PAST listing name is not a prefix claim)
    // stays creatable.
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "meadow", project: "web", visibility: "public" },
          100,
        ),
        ALICE,
      ),
    );
  });
});

describe("/registry/me owned-outside-relation arm (frozen: owned + member-org private + nothing else)", () => {
  it("lists a repo its creator owns in an org they have NO relation to — non-member create and post-revocation — in snapshot AND live modes", async () => {
    const fixture = await setup();
    for (const sub of [ALICE, CAROL, DAVE]) {
      await fixture.identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
    }
    await fixture.identity.createOrg("acme", "acme", ALICE);
    await fixture.identity.grantMembership("acme", CAROL, "member");
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "acme" }, 1),
        ALICE,
      ),
    );
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent("ns.project.create", { v: 1, name: "web" }, 2),
        ALICE,
      ),
    );
    // dave has NO acme relation of any kind, and the dispatch door accepts
    // his create anyway (there is no org-membership gate on ns.repo.create)
    // — the reachable product state the run-2 sabotage exploited.
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "daves-corner", project: "web", visibility: "private" },
          3,
        ),
        DAVE,
      ),
    );
    // carol creates as a member, then identity.membership.revoked strips her
    // relation after the fact — the second reachable path into the arm.
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "carols-nook", project: "web", visibility: "private" },
          4,
        ),
        CAROL,
      ),
    );
    await fixture.identity.revokeMembership("acme", CAROL);
    await awaitRegistryLength(fixture, 4);
    const asOf = offsetForOrdinal(3);
    const corner = {
      org: "acme",
      owner: DAVE,
      project: "web",
      repo: "daves-corner",
      repoStreamPrefix: "fs:acme/daves-corner",
      visibility: "private",
    };
    const nook = {
      org: "acme",
      owner: CAROL,
      project: "web",
      repo: "carols-nook",
      repoStreamPrefix: "fs:acme/carols-nook",
      visibility: "private",
    };

    // SNAPSHOT: each owner's /registry/me lists exactly the repo they own —
    // present despite no org relation, and NOTHING else (not the other
    // private repo in the same org).
    expect(await getDoor(fixture, "/registry/me", DAVE)).toEqual({
      status: 200,
      body: { asOf, entries: [corner] },
    });
    expect(await getDoor(fixture, "/registry/me", CAROL)).toEqual({
      status: 200,
      body: { asOf, entries: [nook] },
    });
    // The visibility filter alone (org door) agrees: owner-visibility with no
    // relation shows exactly the owned entry.
    expect(await getDoor(fixture, "/registry/org/acme", CAROL)).toEqual({
      status: 200,
      body: { asOf, entries: [nook] },
    });

    // LIVE (long-poll catch-up over the whole history): each owner receives
    // exactly their own repo-added frame — org-added/project-added and the
    // other subject's private frame are suppressed for a no-relation subject.
    for (const [sub, ordinal, repo] of [
      [DAVE, 2, "daves-corner"],
      [CAROL, 3, "carols-nook"],
    ] as const) {
      const response = await fetch(
        `${fixture.baseUrl}/registry/me?live=long-poll&after=-1&waitMs=0`,
        { headers: { authorization: `Bearer ${await fixture.token(sub)}` } },
      );
      expect(response.status, sub).toBe(200);
      const body = (await response.json()) as {
        readonly after: string;
        readonly frames: readonly {
          readonly offset: string;
          readonly type: string;
          readonly payload: { readonly repo?: string };
        }[];
      };
      expect(
        body.frames.map((frame) => [frame.offset, frame.type, frame.payload.repo]),
        sub,
      ).toEqual([[offsetForOrdinal(ordinal), "registry.repo-added", repo]]);
      expect(body.after, sub).toBe(offsetForOrdinal(3));
    }
  });
});

describe("registry door refusal table (gateway grammar/mode arms)", () => {
  it("refuses non-GET, undecodable/non-grammar orgs, malformed paths, and invalid live parameters with the exact frozen bodies", async () => {
    const fixture = await setup();
    const cases: readonly [string, string, number, string, string][] = [
      // method, path, status, error.code, error.reason
      ["POST", "/registry/public", 405, "invalid_request", "method_not_allowed"],
      ["DELETE", "/registry/org/acme", 405, "invalid_request", "method_not_allowed"],
      // %80 is an undecodable percent-escape: decodeURIComponent throws and
      // the catch substitutes a non-grammar name — same existence-neutral 404.
      ["GET", "/registry/org/%80", 404, "invalid_request", "not_found"],
      ["GET", "/registry/org/UPPER", 404, "invalid_request", "not_found"],
      ["GET", "/registry/org/acme/extra", 404, "invalid_request", "not_found"],
      ["GET", "/registry/nonesuch", 404, "invalid_request", "not_found"],
      [
        "GET",
        "/registry/public?live=long-poll&after=zzz",
        400,
        "invalid_request",
        "invalid_follow_parameters",
      ],
      [
        "GET",
        "/registry/public?live=websocket",
        400,
        "invalid_request",
        "invalid_follow_parameters",
      ],
      [
        "GET",
        "/registry/public?live=long-poll&waitMs=-1",
        400,
        "invalid_request",
        "invalid_follow_parameters",
      ],
      [
        "GET",
        "/registry/public?live=long-poll&waitMs=20001",
        400,
        "invalid_request",
        "invalid_follow_parameters",
      ],
      [
        "GET",
        "/registry/public?live=long-poll&waitMs=abc",
        400,
        "invalid_request",
        "invalid_follow_parameters",
      ],
    ];
    for (const [method, path, status, code, reason] of cases) {
      const response = await fetch(`${fixture.baseUrl}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: { code, reason } });
    }
    // Accept-side boundary pin (run-3 verdict): waitMs=20000 — the documented
    // maximum — is ACCEPTED with 200; the bound is refused only from 20001 up,
    // so an off-by-one (`>` → `>=`) in the gateway grammar goes red here. A
    // public repo already on __registry__ makes the after=-1 catch-up return
    // immediately with visible frames instead of waiting out the window.
    await fixture.identity.ensureUser(ALICE, "auth0-alice@example.test");
    await fixture.identity.createOrg("acme", "acme", ALICE);
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "acme" }),
        ALICE,
      ),
    );
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent("ns.project.create", { v: 1, name: "web" }, 2),
        ALICE,
      ),
    );
    await accepted(
      await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "commons", project: "web", visibility: "public" },
          3,
        ),
        ALICE,
      ),
    );
    await awaitRegistryLength(fixture, 3);
    const boundary = await fetch(
      `${fixture.baseUrl}/registry/public?live=long-poll&after=-1&waitMs=20000`,
    );
    expect(boundary.status, "waitMs=20000 (the documented maximum) must be accepted").toBe(200);
    const boundaryBody = (await boundary.json()) as {
      readonly frames: readonly { readonly type: string }[];
    };
    expect(
      boundaryBody.frames.some((frame) => frame.type === "registry.repo-added"),
      "the accepted boundary catch-up returns the visible public frames",
    ).toBe(true);
  }, 60_000);
});

describe("loud refusal arms (no silent skip anywhere on the derivation path)", () => {
  const OFFSET = offsetForOrdinal(0);

  it("projectSourceEvent throws RegistryProjectionError on an unrecognized source event type", () => {
    expect(() =>
      projectSourceEvent(
        { type: "wiki.page.created", payload: { v: 1 }, ts: 1 },
        OFFSET,
        "ns:org:acme",
      ),
    ).toThrow(RegistryProjectionError);
    expect(() =>
      projectSourceEvent(
        { type: "wiki.page.created", payload: { v: 1 }, ts: 1 },
        OFFSET,
        "ns:org:acme",
      ),
    ).toThrow(/unrecognized source event "wiki\.page\.created"/);
    // Structurally valid namespace events on the WRONG stream are loud too.
    expect(() =>
      projectSourceEvent(
        {
          type: "ns.org.create",
          payload: { v: 1, name: "acme", actor: { sub: "auth0|a" } },
          ts: 1,
        },
        OFFSET,
        "ns:org:acme",
      ),
    ).toThrow(RegistryProjectionError);
    expect(() =>
      projectSourceEvent(
        {
          type: "ns.repo.create",
          payload: {
            v: 1,
            name: "forest",
            project: "web",
            visibility: "public",
            actor: { sub: "auth0|a" },
          },
          ts: 1,
        },
        OFFSET,
        "ns:root",
      ),
    ).toThrow(/per-org source event on ns:root/);
  });

  it("registryReducer rejects a state-contradicting derived event loudly", () => {
    const source = { stream: "ns:org:acme", offset: OFFSET };
    expect(() =>
      registryReducer(registryInitialState, {
        type: "registry.repo-added",
        payload: {
          v: 1,
          org: "ghost",
          project: "web",
          repo: "forest",
          visibility: "public",
          owner: "auth0|a",
          repoStreamPrefix: "fs:ghost/forest",
          source,
        },
        ts: 1,
      }),
    ).toThrow(/registry\/reducer-invalid: unknown org/);
    const seeded = registryReducer(registryInitialState, {
      type: "registry.org-added",
      payload: {
        v: 1,
        org: "acme",
        owner: "auth0|a",
        source: { stream: "ns:root", offset: OFFSET },
      },
      ts: 1,
    });
    expect(() =>
      registryReducer(seeded, {
        type: "registry.org-added",
        payload: {
          v: 1,
          org: "acme",
          owner: "auth0|a",
          source: { stream: "ns:root", offset: OFFSET },
        },
        ts: 2,
      }),
    ).toThrow(/registry\/reducer-invalid: duplicate org/);
    expect(() =>
      registryReducer(seeded, {
        type: "registry.repo-visibility-changed",
        payload: { v: 1, org: "acme", repo: "ghost", visibility: "public", source },
        ts: 2,
      }),
    ).toThrow(/registry\/reducer-invalid: unknown repo/);
    expect(() => registryReducer(seeded, { type: "not.registry", payload: {}, ts: 3 })).toThrow(
      /registry\/reducer-invalid: invalid event/,
    );
  });

  it("parseRegistryRecord throws RegistryStreamCorruptError on a corrupt __registry__ record", () => {
    expect(() => parseRegistryRecord(null, 0)).toThrow(RegistryStreamCorruptError);
    expect(() => parseRegistryRecord("garbage", 3)).toThrow(/record 3 is not an object/);
    // An object that is not a derived registry event (a corrupt byte flips
    // the payload out of shape) is equally loud.
    expect(() =>
      parseRegistryRecord(
        { type: "registry.org-added", payload: { forged: true }, ts: 1, offset: OFFSET },
        7,
      ),
    ).toThrow(/record 7 is not a derived registry event/);
    // A well-formed derived record with no offset is corrupt too.
    expect(() =>
      parseRegistryRecord(
        {
          type: "registry.org-added",
          payload: {
            v: 1,
            org: "acme",
            owner: "auth0|a",
            source: { stream: "ns:root", offset: OFFSET },
          },
          ts: 1,
        },
        9,
      ),
    ).toThrow(RegistryStreamCorruptError);
  });

  it("registryReducer rejects the remaining state-contradiction arms: duplicate project/repo, unknown project, rename onto taken name", () => {
    const source = { stream: "ns:org:acme", offset: OFFSET };
    const org = registryReducer(registryInitialState, {
      type: "registry.org-added",
      payload: {
        v: 1,
        org: "acme",
        owner: "auth0|a",
        source: { stream: "ns:root", offset: OFFSET },
      },
      ts: 1,
    });
    const project = registryReducer(org, {
      type: "registry.project-added",
      payload: { v: 1, org: "acme", project: "web", owner: "auth0|a", source },
      ts: 2,
    });
    expect(() =>
      registryReducer(project, {
        type: "registry.project-added",
        payload: { v: 1, org: "acme", project: "web", owner: "auth0|a", source },
        ts: 3,
      }),
    ).toThrow(/registry\/reducer-invalid: duplicate project/);
    expect(() =>
      registryReducer(project, {
        type: "registry.repo-added",
        payload: {
          v: 1,
          org: "acme",
          project: "ghost",
          repo: "forest",
          visibility: "public",
          owner: "auth0|a",
          repoStreamPrefix: "fs:acme/forest",
          source,
        },
        ts: 3,
      }),
    ).toThrow(/registry\/reducer-invalid: unknown project/);
    const repoPayload = {
      v: 1,
      org: "acme",
      project: "web",
      repo: "forest",
      visibility: "public",
      owner: "auth0|a",
      repoStreamPrefix: "fs:acme/forest",
      source,
    } as const;
    const forest = registryReducer(project, {
      type: "registry.repo-added",
      payload: repoPayload,
      ts: 3,
    });
    expect(() =>
      registryReducer(forest, { type: "registry.repo-added", payload: repoPayload, ts: 4 }),
    ).toThrow(/registry\/reducer-invalid: duplicate repo/);
    const grove = registryReducer(forest, {
      type: "registry.repo-added",
      payload: { ...repoPayload, repo: "grove", repoStreamPrefix: "fs:acme/grove" },
      ts: 4,
    });
    expect(() =>
      registryReducer(grove, {
        type: "registry.repo-renamed",
        payload: { v: 1, org: "acme", repo: "forest", newRepo: "grove", source },
        ts: 5,
      }),
    ).toThrow(/registry\/reducer-invalid: rename onto taken name/);
    // replayRegistryStream's envelope arm: a raw record that is not an object
    // is a loud reject, never a silent skip.
    expect(() => replayRegistryStream(["garbage"])).toThrow(
      /registry\/reducer-invalid: record is not an object/,
    );
    expect(() => replayRegistryStream([null])).toThrow(
      /registry\/reducer-invalid: record is not an object/,
    );
  });

  it("the projector pass is loud over corrupt source and __registry__ records (no silent drop in parseSourceRecord or the checkpoint scan)", async () => {
    const emptyFollow = (): AsyncIterable<unknown> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    });
    const stub = (registry: readonly unknown[]): StreamAdapter => ({
      create: () => Promise.resolve(),
      append: () => Promise.resolve(),
      read: (streamId) =>
        Promise.resolve(streamId === "__registry__" ? registry : ([] as readonly unknown[])),
      follow: emptyFollow,
    });
    // A __registry__ record that is not an object.
    await expect(new RegistryProjector(stub([null])).syncOnce()).rejects.toThrow(
      /__registry__ record 0 is not an object/,
    );
    // A record with no application offset.
    await expect(
      new RegistryProjector(
        stub([{ type: "registry.org-added", payload: { v: 1 }, ts: 1 }]),
      ).syncOnce(),
    ).rejects.toThrow(/__registry__ record 0 has no application offset/);
    // A well-offset record that is NOT a derived registry event.
    await expect(
      new RegistryProjector(
        stub([{ type: "not.registry", payload: {}, ts: 1, offset: OFFSET }]),
      ).syncOnce(),
    ).rejects.toThrow(/__registry__ record 0 is not a registry event/);
    // Corrupt SOURCE records are equally loud (same parse, ns:root path).
    const sourceStub: StreamAdapter = {
      create: () => Promise.resolve(),
      append: () => Promise.resolve(),
      read: (streamId) =>
        Promise.resolve(
          streamId === "ns:root" ? (["garbage"] as readonly unknown[]) : ([] as readonly unknown[]),
        ),
      follow: emptyFollow,
    };
    await expect(new RegistryProjector(sourceStub).syncOnce()).rejects.toThrow(
      /ns:root record 0 is not an object/,
    );
  });

  it("the prefix-uniqueness fold is loud over malformed accepted-log records", () => {
    expect(
      [
        ...mintedPrefixNames([
          { type: "ns.project.create", payload: { v: 1, name: "web" }, ts: 1 },
          { type: "ns.repo.create", payload: { v: 1, name: "forest" }, ts: 2 },
          { type: "ns.repo.rename", payload: { v: 1, name: "forest", newName: "grove" }, ts: 3 },
          { type: "ns.repo.create", payload: { v: 1, name: "meadow" }, ts: 4 },
        ]),
      ].sort(),
    ).toEqual(["forest", "meadow"]);
    expect(() => mintedPrefixNames([null])).toThrow(
      /ns\/prefix-fold-invalid: record 0 is not an object/,
    );
    expect(() => mintedPrefixNames(["garbage"])).toThrow(/ns\/prefix-fold-invalid/);
    expect(() => mintedPrefixNames([{ type: "ns.repo.create", payload: null, ts: 1 }])).toThrow(
      /ns\/prefix-fold-invalid: ns\.repo\.create record 0 payload is not an object/,
    );
    expect(() =>
      mintedPrefixNames([{ type: "ns.repo.create", payload: { v: 1, name: 7 }, ts: 1 }]),
    ).toThrow(/ns\/prefix-fold-invalid: ns\.repo\.create record 0 has no string name/);
  });
});
