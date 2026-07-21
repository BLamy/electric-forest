import { readFileSync } from "node:fs";
import { isDurableNotFound } from "@eforest/client";
import { stateDigest, type Event } from "@eforest/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeNamespaceView,
  createNamespaceInitialState,
  namespaceViewDigest,
  NamespaceSchemaError,
  replayNamespaceStream,
  resolvePath,
} from "../src/index.js";
import { NamespaceRuntime } from "../src/namespace-runtime.js";
import {
  dispatch,
  grantNamespaceFixture,
  namespaceHttpFixture,
  nsEvent,
  type GrantNamespaceFixture,
  type NamespaceHttpFixture,
} from "./ns.helpers.js";

type NamespaceStreamStateAttack = {
  orgs: Record<string, { owner: string }>;
};

const fixtures: NamespaceHttpFixture[] = [];
const refusalEvidencePath =
  ".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-refusal-neutrality.txt";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

async function setup(): Promise<NamespaceHttpFixture> {
  const fixture = await namespaceHttpFixture();
  fixtures.push(fixture);
  return fixture;
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

async function accepted(response: Response): Promise<void> {
  expect(response.status).toBe(202);
  expect(await json(response)).toMatchObject({ ok: true });
}

async function streamSnapshot(
  fixture: NamespaceHttpFixture,
  streamId: string,
): Promise<{ readonly digest: string; readonly exists: boolean; readonly offset: string }> {
  try {
    const records = (await fixture.streams.read(streamId)) as readonly (Event & {
      readonly offset: string;
    })[];
    return {
      digest: stateDigest(records),
      exists: true,
      offset: records.at(-1)?.offset ?? "-1",
    };
  } catch (error) {
    if (!isDurableNotFound(error)) throw error;
    return { digest: "absent", exists: false, offset: "absent" };
  }
}

async function view(fixture: NamespaceHttpFixture) {
  const root = (await fixture.streams.read("ns:root")) as readonly Event[];
  const orgs = Object.fromEntries(
    await Promise.all(
      root.map(async (event) => {
        const name = (event.payload as { name: string }).name;
        return [
          `ns:org:${name}`,
          (await fixture.streams.read(`ns:org:${name}`)) as Event[],
        ] as const;
      }),
    ),
  );
  return composeNamespaceView(root, orgs);
}

describe("event-backed namespace dispatch and resolution", () => {
  it("isolates every replay from ambient and prior-result mutation", () => {
    const exported = createNamespaceInitialState() as NamespaceStreamStateAttack;
    expect(() => {
      exported.orgs.injected = { owner: "side-table" };
    }).toThrow(TypeError);

    const empty = replayNamespaceStream([]) as NamespaceStreamStateAttack;
    expect(() => {
      empty.orgs.local = { owner: "empty-replay" };
    }).toThrow(TypeError);

    const first = replayNamespaceStream([
      {
        type: "ns.org.create",
        payload: { v: 1, name: "acme", actor: { sub: "auth0|alice" } },
        ts: 1,
      },
    ]) as NamespaceStreamStateAttack;
    first.orgs.local = { owner: "first-replay-only" };

    expect(
      replayNamespaceStream([
        {
          type: "ns.org.create",
          payload: { v: 1, name: "acme", actor: { sub: "auth0|alice" } },
          ts: 1,
        },
      ]).orgs,
    ).toEqual({ acme: { owner: "auth0|alice" } });
    expect(replayNamespaceStream([])).not.toBe(createNamespaceInitialState());
  });

  it("stamps token ownership and resolves exact org, repo, and branch literals", async () => {
    const fixture = await setup();
    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "acme" }),
        "auth0|alice",
      ),
    );
    await accepted(
      await dispatch(
        fixture,
        "ns:org:acme",
        nsEvent("ns.project.create", { v: 1, name: "core" }, 2),
        "auth0|alice",
      ),
    );
    await accepted(
      await dispatch(
        fixture,
        "ns:org:acme",
        nsEvent(
          "ns.repo.create",
          { v: 1, name: "forest", project: "core", visibility: "private" },
          3,
        ),
        "auth0|bob",
      ),
    );

    const state = await view(fixture);
    expect(resolvePath(state, "acme")).toEqual({
      org: "acme",
      owner: "auth0|alice",
      projects: ["core"],
      repos: [{ name: "forest", project: "core", visibility: "private" }],
    });
    expect(resolvePath(state, "acme/forest")).toEqual({
      repoStreamPrefix: "fs:acme/forest",
      visibility: "private",
      owner: "auth0|bob",
      project: "core",
    });
    expect(resolvePath(state, "acme/forest/feature-x")).toBe("fs:acme/forest:feature-x:meta");
    expect(resolvePath(state, "missing")).toEqual({
      found: false,
      reason: "not-found",
      path: "missing",
    });
    expect(resolvePath(state, "acme/missing")).toEqual({
      found: false,
      reason: "not-found",
      path: "acme/missing",
    });
    expect(resolvePath(state, "acme/forest/")).toEqual({
      found: false,
      reason: "not-found",
      path: "acme/forest/",
    });

    expect(await fixture.streams.read("ns:root")).toEqual([
      {
        offset: "0000000000000000_0000000000000000",
        type: "ns.org.create",
        payload: { v: 1, name: "acme", actor: { sub: "auth0|alice" } },
        ts: 1,
      },
    ]);
  });

  it("rejects actor, owner, sub, org, extras, and missing visibility as schema violations", async () => {
    const fixture = await setup();
    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "safe" }),
        "auth0|alice",
      ),
    );
    const before = await fixture.streams.read("ns:root");
    const attacks = [
      { v: 1, name: "evil", actor: { sub: "mallory" } },
      { v: 1, name: "evil", owner: "mallory" },
      { v: 1, name: "evil", sub: "mallory" },
      { v: 1, name: "evil", org: "safe" },
      { v: 1, name: "evil", extra: true },
    ];
    for (const payload of attacks) {
      const response = await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", payload),
        "auth0|alice",
      );
      expect(response.status).toBe(422);
      expect(await json(response)).toEqual({ error: { class: "schema-violation" } });
    }
    const missingVisibility = await dispatch(
      fixture,
      "ns:org:safe",
      nsEvent("ns.repo.create", { v: 1, name: "repo", project: "core" }),
      "auth0|alice",
    );
    expect(missingVisibility.status).toBe(422);
    expect(await fixture.streams.read("ns:root")).toEqual(before);
  });

  it("freezes validation order and all five log-neutral refusal reasons", async () => {
    const fixture = await setup();
    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "acme" }),
        "auth0|alice",
      ),
    );
    await accepted(
      await dispatch(
        fixture,
        "ns:org:acme",
        nsEvent("ns.project.create", { v: 1, name: "core" }),
        "auth0|alice",
      ),
    );
    await accepted(
      await dispatch(
        fixture,
        "ns:org:acme",
        nsEvent("ns.repo.create", { v: 1, name: "repo", project: "core", visibility: "public" }),
        "auth0|alice",
      ),
    );

    const cases = [
      ["ns:root", "ns.org.create", { v: 1, name: "acme" }, "ns/name-taken"],
      ["ns:root", "ns.org.create", { v: 1, name: "A--b" }, "ns/invalid-name"],
      ["ns:root", "ns.org.create", { v: 1, name: "main" }, "ns/reserved-name"],
      ["ns:org:missing", "ns.project.create", { v: 1, name: "core" }, "ns/org-not-found"],
      [
        "ns:org:acme",
        "ns.repo.create",
        { v: 1, name: "new", project: "missing", visibility: "private" },
        "ns/project-not-found",
      ],
    ] as const;
    const evidenceLines = ["E2-T06 refusal neutrality", "transport=real HTTP /api/dispatch"];
    for (const [streamId, type, payload, reason] of cases) {
      const rootBefore = await fixture.streams.read("ns:root");
      const orgBefore = await fixture.streams.read("ns:org:acme");
      const targetBefore = await streamSnapshot(fixture, streamId);
      const response = await dispatch(fixture, streamId, nsEvent(type, payload), "auth0|alice");
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({ error: { class: "validator-rejected", reason } });
      expect(await fixture.streams.read("ns:root")).toEqual(rootBefore);
      expect(await fixture.streams.read("ns:org:acme")).toEqual(orgBefore);
      const targetAfter = await streamSnapshot(fixture, streamId);
      expect(targetAfter).toEqual(targetBefore);
      if (reason === "ns/org-not-found") {
        const missing = await fetch(
          `${fixture.officialUrl}/streams/${encodeURIComponent(streamId)}`,
        );
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe("Stream not found");
        expect(fixture.createdStreamIds).not.toContain(`/streams/${streamId}`);
      }
      evidenceLines.push(
        `reason=${reason} stream=${streamId} status=409 class=validator-rejected before-offset=${targetBefore.offset} after-offset=${targetAfter.offset} before-digest=${targetBefore.digest} after-digest=${targetAfter.digest} exists-before=${targetBefore.exists} exists-after=${targetAfter.exists}`,
      );
    }
    evidenceLines.push(
      "missing-org-get=404 body=Stream not found listing=absent",
      "E2_T06_REFUSAL_NEUTRALITY_OK",
      "",
    );
    const transcript = evidenceLines.join("\n");
    if (process.env.PRINT_E2_T06_EVIDENCE === "1") process.stdout.write(transcript);
    expect(readFileSync(refusalEvidencePath, "utf8")).toBe(transcript);
  });

  it("authenticates before namespace validation and moves no log byte", async () => {
    const fixture = await setup();
    const rootUrl = `${fixture.officialUrl}/streams/${encodeURIComponent("ns:root")}`;
    expect((await fetch(rootUrl)).status).toBe(404);
    const attacks = [
      ["ns:root", nsEvent("ns.org.create", { v: 1, name: "main" })],
      ["ns:org:missing", nsEvent("ns.project.create", { v: 1, name: "main" })],
      [
        "ns:org:missing",
        nsEvent("ns.repo.create", {
          v: 1,
          name: "main",
          project: "missing",
          visibility: "private",
        }),
      ],
    ] as const;
    for (const [streamId, event] of attacks) {
      const missing = await dispatch(fixture, streamId, event);
      expect(missing.status).toBe(401);
      expect(await json(missing)).toEqual({
        error: { code: "unauthorized", reason: "missing_bearer_token" },
      });
      const garbage = await dispatch(fixture, streamId, event, undefined, "Bearer garbage");
      expect(garbage.status).toBe(401);
      expect(await json(garbage)).toEqual({
        error: { code: "unauthorized", reason: "malformed_token" },
      });
      expect((await fetch(rootUrl)).status).toBe(404);
    }
  });

  it("serializes at least twenty concurrent same-name creates to one winner", async () => {
    const fixture = await setup();
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        dispatch(
          fixture,
          "ns:root",
          nsEvent("ns.org.create", { v: 1, name: "race" }, index),
          "auth0|alice",
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    const losers = responses.filter((response) => response.status !== 202);
    expect(losers).toHaveLength(23);
    for (const response of losers) {
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({
        error: { class: "validator-rejected", reason: "ns/name-taken" },
      });
    }
    const root = (await fixture.streams.read("ns:root")) as readonly Event[];
    expect(
      root.filter((event) => (event.payload as { name?: string }).name === "race"),
    ).toHaveLength(1);
    expect(namespaceViewDigest(await view(fixture))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps Stream-Seq ordered after ten sequential namespace events", async () => {
    const fixture = await setup();
    for (let index = 0; index < 12; index += 1) {
      await accepted(
        await dispatch(
          fixture,
          "ns:root",
          nsEvent("ns.org.create", { v: 1, name: `org-${String(index).padStart(2, "0")}` }, index),
          "auth0|alice",
        ),
      );
    }

    const root = (await fixture.streams.read("ns:root")) as ReadonlyArray<{ offset: string }>;
    expect(root).toHaveLength(12);
    expect(root.map((record) => record.offset)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `0000000000000000_${String(index).padStart(16, "0")}`,
      ),
    );
  });

  it("allows the same repo name in two orgs and resolves each owner and visibility", async () => {
    const fixture = await setup();
    for (const [org, owner, visibility] of [
      ["maple", "auth0|alice", "public"],
      ["oak", "auth0|bob", "private"],
    ] as const) {
      await accepted(
        await dispatch(fixture, "ns:root", nsEvent("ns.org.create", { v: 1, name: org }), owner),
      );
      await accepted(
        await dispatch(
          fixture,
          `ns:org:${org}`,
          nsEvent("ns.project.create", { v: 1, name: "reading" }),
          owner,
        ),
      );
      await accepted(
        await dispatch(
          fixture,
          `ns:org:${org}`,
          nsEvent("ns.repo.create", {
            v: 1,
            name: "shared",
            project: "reading",
            visibility,
          }),
          owner,
        ),
      );
    }

    const state = await view(fixture);
    expect(resolvePath(state, "maple/shared")).toEqual({
      repoStreamPrefix: "fs:maple/shared",
      visibility: "public",
      owner: "auth0|alice",
      project: "reading",
    });
    expect(resolvePath(state, "oak/shared")).toEqual({
      repoStreamPrefix: "fs:oak/shared",
      visibility: "private",
      owner: "auth0|bob",
      project: "reading",
    });
  });

  it("refuses a duplicate repo name across two projects in one org", async () => {
    const fixture = await setup();
    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "acme" }),
        "auth0|alice",
      ),
    );
    for (const project of ["alpha", "beta"]) {
      await accepted(
        await dispatch(
          fixture,
          "ns:org:acme",
          nsEvent("ns.project.create", { v: 1, name: project }),
          "auth0|alice",
        ),
      );
    }
    await accepted(
      await dispatch(
        fixture,
        "ns:org:acme",
        nsEvent("ns.repo.create", {
          v: 1,
          name: "shared",
          project: "alpha",
          visibility: "public",
        }),
        "auth0|alice",
      ),
    );
    const before = await fixture.streams.read("ns:org:acme");
    const duplicate = await dispatch(
      fixture,
      "ns:org:acme",
      nsEvent("ns.repo.create", {
        v: 1,
        name: "shared",
        project: "beta",
        visibility: "private",
      }),
      "auth0|alice",
    );
    expect(duplicate.status).toBe(409);
    expect(await json(duplicate)).toEqual({
      error: { class: "validator-rejected", reason: "ns/name-taken" },
    });
    expect(await fixture.streams.read("ns:org:acme")).toEqual(before);
  });

  it("pins the exact name grammar, reserved names, and validation precedence", async () => {
    const fixture = await setup();
    for (const name of ["a", "a-b", "a".repeat(40), "foo"]) {
      await accepted(
        await dispatch(fixture, "ns:root", nsEvent("ns.org.create", { v: 1, name }), "auth0|alice"),
      );
    }

    const invalid = [
      "A-a",
      "a--b",
      "-a",
      "a-",
      "a".repeat(41),
      "__registry__",
      "а",
      "a/b",
      "a b",
      "a\0b",
      ".",
      "..",
      "",
      "FOO",
    ];
    for (const name of invalid) {
      const before = await fixture.streams.read("ns:root");
      const response = await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name }),
        "auth0|alice",
      );
      expect(response.status, JSON.stringify(name)).toBe(409);
      expect(await json(response), JSON.stringify(name)).toEqual({
        error: { class: "validator-rejected", reason: "ns/invalid-name" },
      });
      expect(await fixture.streams.read("ns:root"), JSON.stringify(name)).toEqual(before);
    }

    for (const name of ["main", "ns", "fs"]) {
      const response = await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name }),
        "auth0|alice",
      );
      expect(response.status, name).toBe(409);
      expect(await json(response), name).toEqual({
        error: { class: "validator-rejected", reason: "ns/reserved-name" },
      });
    }
  });

  it("does not mint a physical stream for a missing org and reconciles recorded orgs", async () => {
    const fixture = await setup();
    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "recorded" }),
        "auth0|alice",
      ),
    );
    expect(
      (
        await fetch(`${fixture.officialUrl}/streams/${encodeURIComponent("ns:org:recorded")}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);

    const missing = await dispatch(
      fixture,
      "ns:org:missing",
      nsEvent("ns.project.create", { v: 1, name: "core" }),
      "auth0|alice",
    );
    expect(missing.status).toBe(409);
    expect(await json(missing)).toEqual({
      error: { class: "validator-rejected", reason: "ns/org-not-found" },
    });
    expect(
      await fetch(`${fixture.officialUrl}/streams/${encodeURIComponent("ns:org:missing")}`),
    ).toMatchObject({ status: 404 });

    await accepted(
      await dispatch(
        fixture,
        "ns:root",
        nsEvent("ns.org.create", { v: 1, name: "second" }),
        "auth0|alice",
      ),
    );
    expect(await fixture.streams.read("ns:org:recorded")).toEqual([]);
  });

  it("accepts every distinct-name create in a two-gateway concurrent burst", async () => {
    const fixture = await setup();
    const second = await fixture.attachGateway();
    const width = 40;
    const names = Array.from(
      { length: width },
      (_, index) => `burst-${String(index).padStart(3, "0")}`,
    );
    const responses = await Promise.all(
      names.map((name, index) =>
        dispatch(
          fixture,
          "ns:root",
          nsEvent("ns.org.create", { v: 1, name }, index),
          "auth0|alice",
          undefined,
          index % 2 === 0 ? fixture.baseUrl : second.baseUrl,
        ),
      ),
    );
    for (const [index, response] of responses.entries()) {
      expect(response.status, names[index]).toBe(202);
      expect(await json(response), names[index]).toEqual({ ok: true, actor: "auth0|alice" });
    }
    const root = (await fixture.streams.read("ns:root")) as readonly Event[];
    const recorded = root.map((event) => (event.payload as { name: string }).name);
    for (const name of names) {
      expect(recorded.filter((candidate) => candidate === name)).toHaveLength(1);
    }
    expect(root).toHaveLength(width);
  });

  it("stamps and plans a namespace event through the production grant-aware door", async () => {
    const grantFixture: GrantNamespaceFixture = await grantNamespaceFixture();
    try {
      const { token } = await grantFixture.grantToken("auth0|carol");
      const response = await fetch(`${grantFixture.baseUrl}/api/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          streamId: "ns:root",
          event: { type: "ns.org.create", payload: { v: 1, name: "granted" }, ts: 7 },
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, actor: "auth0|carol" });

      const stamped = {
        type: "ns.org.create",
        payload: { v: 1, name: "granted", actor: { sub: "auth0|carol" } },
        ts: 7,
      };
      expect(await grantFixture.streams.read("ns:root")).toEqual([
        { offset: "0000000000000000_0000000000000000", ...stamped },
      ]);

      const identityEvents = (await grantFixture.streams.read("__identity__")) as readonly Event[];
      const started = identityEvents.filter(
        (event) => event.type === "identity.grant.operation.started",
      );
      expect(started).toHaveLength(1);
      const plan = started[0]!.payload as { streamId: string; event: unknown };
      expect(plan.streamId).toBe("ns:root");
      expect(plan.event).toEqual(stamped);
      expect(
        identityEvents.filter((event) => event.type === "identity.grant.operation.completed"),
      ).toHaveLength(1);
    } finally {
      await grantFixture.stop();
    }
  });

  it("recovers an orphaned namespace grant operation through the runtime boundary", async () => {
    const grantFixture = await grantNamespaceFixture();
    try {
      const { grantId } = await grantFixture.grantToken("auth0|dave");
      const planned = {
        type: "ns.org.create",
        payload: { v: 1, name: "orphaned", actor: { sub: "auth0|dave" } },
        ts: 11,
      };
      await grantFixture.identity.beginGrantOperation(grantId, "orphan-op", {
        streamId: "ns:root",
        event: planned as never,
      });
      expect(
        (await fetch(`${grantFixture.officialUrl}/streams/${encodeURIComponent("ns:root")}`))
          .status,
      ).toBe(404);

      // Revoking the in-use grant forces the production recovery lane:
      // recoverNamespaceOperation → NamespaceDispatcher.recover → dispatch.
      await grantFixture.identity.revokeCliGrant(grantId);
      const root = await grantFixture.streams.read("ns:root");
      expect(root).toEqual([{ offset: "0000000000000000_0000000000000000", ...planned }]);
      const snapshot = await grantFixture.identity.snapshot();
      expect(snapshot.view.grantOperations?.["orphan-op"]?.status).toBe("completed");

      // The isEvent rejection lane: an unstamped event never re-dispatches.
      await expect(
        grantFixture.namespaces.recover("bad-op", "ns:root", {
          type: "ns.org.create",
          payload: { v: 1, name: "unstamped" },
          ts: 12,
        }),
      ).rejects.toThrow(NamespaceSchemaError);
      expect(await grantFixture.streams.read("ns:root")).toEqual(root);
    } finally {
      await grantFixture.stop();
    }
  });

  it("carries an in-VM operation error to the host over the JSON transport", async () => {
    const runtime = new NamespaceRuntime();
    const failure = runtime.stamp(
      { type: "ns.org.create", payload: null, ts: 1 } as never,
      "auth0|alice",
    );
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await expect(
      runtime.stamp({ type: "ns.org.create", payload: null, ts: 1 } as never, "auth0|alice"),
    ).rejects.toThrow(/namespace schema violation/);
    // The worker survives the in-VM error and keeps serving requests.
    await expect(runtime.isName("still-alive")).resolves.toBe(true);
  });
});
