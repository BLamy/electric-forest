import { stateDigest, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRegistryRecord,
  projectSourceEvent,
  RegistryProjectionError,
  registryInitialState,
  registryReducer,
  RegistryStreamCorruptError,
} from "../src/index.js";
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

describe("registry refusals are log-neutral", () => {
  it("refuses ns/repo-not-found, ns/not-owner, rename ns/name-taken, reserved newName — head offset and dump digest byte-identical", async () => {
    const fixture = await setup();
    await buildLifecycleTree(fixture);
    const cases: readonly [string, Record<string, unknown>, string, string][] = [
      ["ns:org:acme", { v: 1, name: "missing", newName: "elsewhere" }, ALICE, "ns/repo-not-found"],
      ["ns:org:acme", { v: 1, name: "grove", newName: "meadow" }, BOB, "ns/not-owner"],
      ["ns:org:acme", { v: 1, name: "grove", newName: "secret" }, ALICE, "ns/name-taken"],
      ["ns:org:acme", { v: 1, name: "grove", newName: "main" }, ALICE, "ns/reserved-name"],
    ];
    for (const [streamId, payload, sub, reason] of cases) {
      const sourceBefore = await fixture.streams.read(streamId);
      const registryBefore = await registryDump(fixture);
      const response = await dispatchHttp(
        fixture,
        streamId,
        nsEvent("ns.repo.rename", payload, 99),
        sub,
      );
      expect(response.status, reason).toBe(409);
      expect(await response.json(), reason).toEqual({
        error: { class: "validator-rejected", reason },
      });
      const sourceAfter = await fixture.streams.read(streamId);
      expect(stateDigest(sourceAfter), reason).toBe(stateDigest(sourceBefore));
      expect(sourceAfter.length, reason).toBe(sourceBefore.length);
      const registryAfter = await registryDump(fixture);
      expect(stateDigest(registryAfter), reason).toBe(stateDigest(registryBefore));
    }
    // set-visibility shares the taxonomy.
    for (const [payload, sub, reason] of [
      [{ v: 1, name: "missing", visibility: "public" }, ALICE, "ns/repo-not-found"],
      [{ v: 1, name: "grove", visibility: "public" }, BOB, "ns/not-owner"],
    ] as const) {
      const before = await fixture.streams.read("ns:org:acme");
      const response = await dispatchHttp(
        fixture,
        "ns:org:acme",
        nsEvent("ns.repo.set-visibility", payload as unknown as Record<string, unknown>, 99),
        sub,
      );
      expect(response.status, reason).toBe(409);
      expect(await response.json(), reason).toEqual({
        error: { class: "validator-rejected", reason },
      });
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
    expect(anonymous.frames, "anonymous tail leaked within the held 2000ms window").toEqual([]);
    authorized.close();
    anonymous.close();
  }, 15_000);

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
  }, 20_000);

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
});
