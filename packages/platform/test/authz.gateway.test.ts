import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createDurableStreamTestServer } from "@eforest/server";
import type { Event } from "@eforest/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BearerVerifier,
  createPlatformHandler,
  createPlatformServer,
  GrantAwareVerifier,
  IdentityStore,
  listenPlatformServer,
  NamespaceDispatcher,
  OfficialStreamAdapter,
  OidcClient,
  OidcTransactions,
  PlatformGateway,
  PlatformWebApp,
  tokenHash,
  type StreamAdapter,
} from "../src/index.js";

const ISSUER = "https://authz.test/";
const AUDIENCE = "eforest-api";
const NOW = 1_700_000_000_000;
const KID = "authz-key";
const OWNER = "auth0|owner";
const ADMIN = "auth0|admin";
const MEMBER = "auth0|member";
const OUTSIDER = "auth0|outsider";

interface SigningFixture {
  readonly privateKey: KeyObject;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

function signingFixture(): SigningFixture {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: KID,
      alg: "RS256",
      use: "sig",
    } as SigningFixture["publicJwk"],
  };
}

function signedToken(fixture: SigningFixture, sub: string, nonce = ""): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub,
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
      ...(nonce === "" ? {} : { nonce }),
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
}

/** Records every official-stream operation the gateway performs, per stream. */
class ObservedAdapter implements StreamAdapter {
  readonly operations: Array<{ readonly op: string; readonly streamId: string }> = [];

  constructor(private readonly delegate: OfficialStreamAdapter) {}

  async create(streamId: string): Promise<void> {
    this.operations.push({ op: "create", streamId });
    return this.delegate.create(streamId);
  }

  async append(
    streamId: string,
    event: Event,
    options?: Parameters<OfficialStreamAdapter["append"]>[2],
  ): ReturnType<OfficialStreamAdapter["append"]> {
    this.operations.push({ op: "append", streamId });
    return this.delegate.append(streamId, event, options);
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    this.operations.push({ op: "read", streamId });
    return this.delegate.read(streamId);
  }

  follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown> {
    this.operations.push({ op: "follow", streamId });
    return this.delegate.follow(streamId, signal);
  }
}

let official: ReturnType<typeof createDurableStreamTestServer>;
let officialUrl: string;
let createdStreamIds: string[];
let fixture: SigningFixture;
let direct: OfficialStreamAdapter;
let observed: ObservedAdapter;
let identity: IdentityStore;
let baseUrl: string;
let stopServer: () => Promise<void>;
let grantOrdinal: number;

async function grantToken(sub: string, scopes: readonly string[]): Promise<{
  readonly token: string;
  readonly grantId: string;
}> {
  grantOrdinal += 1;
  const token = signedToken(fixture, sub, `grant-${grantOrdinal}`);
  await identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
  const grantId = `authz-grant-${grantOrdinal}`;
  await identity.issueCliGrant({
    grantId,
    sub,
    tokenKind: "device",
    tokenHash: tokenHash(token),
    scopes: [...scopes].sort(),
  });
  return { token, grantId };
}

function dispatchBody(streamId: string, event: Record<string, unknown>): string {
  return JSON.stringify({ streamId, event });
}

async function post(
  path: string,
  body: string,
  token?: string,
  base: string = baseUrl,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
  });
}

async function get(path: string, token?: string, base: string = baseUrl): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function streamStates(): Promise<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const path of [...createdStreamIds].sort()) {
    const id = decodeURIComponent(path.replace(/^\/streams\//, ""));
    const response = await fetch(`${officialUrl}/streams/${encodeURIComponent(id)}`);
    states[id] = `${response.status}:${await response.text()}`;
  }
  return states;
}

beforeEach(async () => {
  createdStreamIds = [];
  grantOrdinal = 0;
  official = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path }) => {
      createdStreamIds.push(path);
    },
  });
  officialUrl = await official.start();
  fixture = signingFixture();
  direct = new OfficialStreamAdapter({ baseUrl: officialUrl });
  observed = new ObservedAdapter(direct);
  identity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
  await identity.ensure();
  const bearer = new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
  });
  const namespaces = new NamespaceDispatcher(observed);
  const verifier = new GrantAwareVerifier({
    bearer,
    identity,
    operationId: (() => {
      let ordinal = 0;
      return () => `authz-operation-${++ordinal}`;
    })(),
  });
  const server = createPlatformServer(
    createPlatformHandler({ verifier, streams: observed, namespaces }),
  );
  baseUrl = await listenPlatformServer(server);
  stopServer = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // Seed the namespace through the real door: org, project, two repos.
  const ns = await grantToken(OWNER, []);
  const events: Array<readonly [string, Record<string, unknown>]> = [
    ["ns:root", { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 }],
    ["ns:org:acme", { type: "ns.project.create", payload: { v: 1, name: "trees" }, ts: 2 }],
    [
      "ns:org:acme",
      {
        type: "ns.repo.create",
        payload: { v: 1, name: "forest", project: "trees", visibility: "public" },
        ts: 3,
      },
    ],
    [
      "ns:org:acme",
      {
        type: "ns.repo.create",
        payload: { v: 1, name: "secret", project: "trees", visibility: "private" },
        ts: 4,
      },
    ],
  ];
  for (const [streamId, event] of events) {
    const response = await post("/api/dispatch", dispatchBody(streamId, event), ns.token);
    expect(response.status).toBe(202);
  }
  // Identity-side org + memberships (the role join).
  await identity.createOrg("acme", "acme", OWNER);
  await identity.ensureUser(ADMIN, "admin@example.test");
  await identity.ensureUser(MEMBER, "member@example.test");
  await identity.ensureUser(OUTSIDER, "outsider@example.test");
  await identity.grantMembership("acme", ADMIN, "admin");
  await identity.grantMembership("acme", MEMBER, "member");
  // Branch streams exist; their first events arrive through the door below.
  await direct.create("fs:acme/forest:main:meta");
  await direct.create("fs:acme/secret:main:meta");
  const seed = await grantToken(OWNER, [
    "repo:write:acme/forest:main",
    "repo:write:acme/secret:main",
  ]);
  for (const repo of ["forest", "secret"]) {
    const response = await post(
      "/api/dispatch",
      dispatchBody(`fs:acme/${repo}:main:meta`, {
        type: "repo.seeded",
        payload: { repo },
        ts: 10,
      }),
      seed.token,
    );
    expect(response.status).toBe(202);
  }
});

afterEach(async () => {
  await stopServer();
  await official.stop();
});

describe("E2-T07 gateway authorization over real HTTP", () => {
  it("serves anonymous public reads with the decision offset and refuses private/nonexistent identically", async () => {
    const publicRead = await get("/api/repos/acme/forest/main/events");
    expect(publicRead.status).toBe(200);
    const body = (await publicRead.json()) as {
      ok: boolean;
      events: Array<{ type: string; payload: Record<string, unknown> }>;
      count: number;
      identityOffset: string;
      basis: string;
    };
    expect(body.ok).toBe(true);
    expect(body.basis).toBe("public");
    expect(body.count).toBe(1);
    expect(body.events[0]!.type).toBe("repo.seeded");
    expect(body.events[0]!.payload.actor).toBe(OWNER);
    expect(body.identityOffset).toMatch(/^\d{16}_\d{16}$/);

    // Private-unauthorized and nonexistent: byte-identical refusals.
    const cases = [
      "/api/repos/acme/secret/main/events",
      "/api/repos/acme/ghost/main/events",
      "/api/repos/nowhere/ghost/main/events",
    ];
    const bodies: string[] = [];
    for (const path of cases) {
      const response = await get(path);
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({
      error: {
        code: "authz_refused",
        reason: "authz/not-found",
        identityOffset: expect.stringMatching(/^\d{16}_\d{16}$/) as unknown,
      },
    });
  });

  it("authorizes private reads by role and by presented scoped grant only", async () => {
    const admin = await grantToken(ADMIN, []);
    const member = await grantToken(MEMBER, []);
    const outsider = await grantToken(OUTSIDER, []);
    const reader = await grantToken(OUTSIDER, ["repo:read:acme/secret"]);

    for (const [token, basis] of [
      [admin.token, "membership:admin"],
      [member.token, "membership:member"],
      [reader.token, "grant:read"],
    ] as const) {
      const response = await get("/api/repos/acme/secret/main/events", token);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { basis: string }).basis).toBe(basis);
    }
    // The same subject presenting a scope-less grant gets nothing: the
    // capability rides the presented credential, not the subject.
    const refused = await get("/api/repos/acme/secret/main/events", outsider.token);
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { reason: string } }).error.reason).toBe(
      "authz/not-found",
    );
  });

  it("long-polls a live follow through the authorization door", async () => {
    const writer = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
    const followPromise = get(
      "/api/repos/acme/forest/main/events?live=1&after=1&waitMs=8000",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dispatched = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", {
        type: "repo.live",
        payload: { n: 2 },
        ts: 20,
      }),
      writer.token,
    );
    expect(dispatched.status).toBe(202);
    const follow = await followPromise;
    expect(follow.status).toBe(200);
    const body = (await follow.json()) as {
      events: Array<{ type: string }>;
      after: number;
      basis: string;
    };
    expect(body.events.map((event) => event.type)).toEqual(["repo.live"]);
    expect(body.after).toBe(2);
    expect(body.basis).toBe("public");

    // A refused follow never touches the target stream.
    const before = observed.operations.length;
    const refused = await get("/api/repos/acme/secret/main/events?live=1&waitMs=100");
    expect(refused.status).toBe(404);
    const delta = observed.operations.slice(before);
    expect(delta.every((entry) => entry.op === "read")).toBe(true);
    expect(delta.every((entry) => entry.streamId.startsWith("ns:"))).toBe(true);
  });

  it("dispatches to a repo stream only with the branch-scoped write grant and cites the offset", async () => {
    const writer = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
    const accepted = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: { n: 1 }, ts: 30 }),
      writer.token,
    );
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as {
      ok: boolean;
      actor: string;
      identityOffset: string;
    };
    expect(acceptedBody.ok).toBe(true);
    expect(acceptedBody.actor).toBe(OWNER);
    expect(acceptedBody.identityOffset).toMatch(/^\d{16}_\d{16}$/);

    // Roles alone never write: admin without a grant scope is 403 on the
    // public repo (existence is public), 404 on the private one.
    const admin = await grantToken(ADMIN, []);
    const publicRefusal = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: {}, ts: 31 }),
      admin.token,
    );
    expect(publicRefusal.status).toBe(403);
    expect(((await publicRefusal.json()) as { error: { reason: string } }).error.reason).toBe(
      "authz/write-grant-required",
    );
    const outsider = await grantToken(OUTSIDER, []);
    const privateRefusal = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/secret:main:meta", { type: "repo.write", payload: {}, ts: 32 }),
      outsider.token,
    );
    expect(privateRefusal.status).toBe(404);
    expect(((await privateRefusal.json()) as { error: { reason: string } }).error.reason).toBe(
      "authz/not-found",
    );
    // A write grant for another branch does not write this one.
    const wrongBranch = await grantToken(OWNER, ["repo:write:acme/forest:feature"]);
    const wrongBranchRefusal = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: {}, ts: 33 }),
      wrongBranch.token,
    );
    expect(wrongBranchRefusal.status).toBe(403);
  });

  it("revocation takes effect at the next replayed identity-view offset without a restart", async () => {
    const writer = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
    const first = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: { n: 1 }, ts: 40 }),
      writer.token,
    );
    expect(first.status).toBe(202);
    const firstOffset = ((await first.json()) as { identityOffset: string }).identityOffset;

    const revocation = await identity.revokeCliGrant(writer.grantId);
    const revocationOffset = revocation.offset;
    expect(firstOffset < revocationOffset).toBe(true);

    const refused = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: { n: 2 }, ts: 41 }),
      writer.token,
    );
    expect(refused.status).toBe(401);
    const refusedBody = (await refused.json()) as {
      error: { code: string; reason: string; identityOffset: string };
    };
    expect(refusedBody.error.code).toBe("authz_refused");
    expect(refusedBody.error.reason).toBe("authz/grant-revoked");
    expect(refusedBody.error.identityOffset >= revocationOffset).toBe(true);

    // The revoked credential is refused for reads of private repos too, and
    // the refusal cites an offset at or after the revocation.
    const read = await get("/api/repos/acme/secret/main/events", writer.token);
    expect(read.status).toBe(401);
    expect(
      ((await read.json()) as { error: { reason: string } }).error.reason,
    ).toBe("authz/grant-revoked");
  });

  it("appends nothing and performs no target-stream operation for any refusal", async () => {
    const outsider = await grantToken(OUTSIDER, []);
    const revoked = await grantToken(OUTSIDER, ["repo:write:acme/secret:main"]);
    await identity.revokeCliGrant(revoked.grantId);
    const before = await streamStates();
    const createdBefore = [...createdStreamIds];
    const opsBefore = observed.operations.length;

    const attempts: Array<readonly [Promise<Response>, number]> = [
      // Anonymous private read; outsider private read/follow.
      [get("/api/repos/acme/secret/main/events"), 404],
      [get("/api/repos/acme/secret/main/events", outsider.token), 404],
      [get("/api/repos/acme/secret/main/events?live=1&waitMs=100", outsider.token), 404],
      // Malformed and encoded probes.
      [get("/api/repos/acme%2Fsecret/x/main/events"), 404],
      [get("/api/repos/acme/secret/ma%20in/events"), 404],
      [get("/api/repos/acme/secret/main%2Fevil/events"), 404],
      // Cross-tenant and nonexistent probes.
      [get("/api/repos/other-org/secret/main/events", outsider.token), 404],
      // Refused dispatches: no write grant, revoked grant, internal streams,
      // malformed fs ids.
      [
        post(
          "/api/dispatch",
          dispatchBody("fs:acme/secret:main:meta", { type: "x", payload: {}, ts: 1 }),
          outsider.token,
        ),
        404,
      ],
      [
        post(
          "/api/dispatch",
          dispatchBody("fs:acme/secret:main:meta", { type: "x", payload: {}, ts: 1 }),
          revoked.token,
        ),
        401,
      ],
      [
        post(
          "/api/dispatch",
          dispatchBody("__identity__", { type: "identity.user.created", payload: {}, ts: 1 }),
          outsider.token,
        ),
        404,
      ],
      [
        post(
          "/api/dispatch",
          dispatchBody("ns:org:acme", { type: "not-a-namespace-event", payload: {}, ts: 1 }),
          outsider.token,
        ),
        404,
      ],
      [
        post(
          "/api/dispatch",
          dispatchBody("fs:acme/secret:main:journal", { type: "x", payload: {}, ts: 1 }),
          outsider.token,
        ),
        404,
      ],
    ];
    for (const [promise, status] of attempts) {
      expect((await promise).status).toBe(status);
    }

    // No stream minted, no log byte moved, no target-stream operation.
    expect(createdStreamIds).toEqual(createdBefore);
    expect(await streamStates()).toEqual(before);
    const delta = observed.operations.slice(opsBefore);
    expect(delta.filter((entry) => entry.op !== "read")).toEqual([]);
    expect(delta.filter((entry) => !entry.streamId.startsWith("ns:"))).toEqual([]);
  });

  it("keeps the frozen sandbox and control door bodies byte-stable", async () => {
    const grantee = await grantToken(OUTSIDER, []);
    await direct.create("sandbox-target");
    const sandbox = await post(
      "/api/dispatch",
      dispatchBody("sandbox-target", { type: "test.created", payload: { n: 1 }, ts: 1 }),
      grantee.token,
    );
    expect(sandbox.status).toBe(202);
    // Exactly the legacy body: no identityOffset key on non-repo dispatches.
    expect(await sandbox.json()).toEqual({ ok: true, actor: OUTSIDER });

    const nsRefused = await post(
      "/api/dispatch",
      dispatchBody("ns:root", { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 }),
      grantee.token,
    );
    expect(nsRefused.status).toBe(409);
    expect(await nsRefused.json()).toEqual({
      error: { class: "validator-rejected", reason: "ns/name-taken" },
    });
  });

  it("rejects unknown repo-route shapes without resolving anything", async () => {
    const opsBefore = observed.operations.length;
    for (const path of [
      "/api/repos",
      "/api/repos/",
      "/api/repos/acme",
      "/api/repos/acme/forest",
      "/api/repos/acme/forest/main",
      "/api/repos/acme/forest/main/events/extra",
      "/api/repos/acme//main/events",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({
        error: { code: "invalid_request", reason: "not_found" },
      });
    }
    const method = await post("/api/repos/acme/forest/main/events", "{}");
    expect(method.status).toBe(405);
    expect(observed.operations.length).toBe(opsBefore);
  });

  it("is forwarded by the platform web app front door", async () => {
    const bearer = new BearerVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW,
      fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
    });
    const app = new PlatformWebApp({
      oidc: new OidcClient({
        issuer: ISSUER,
        clientId: AUDIENCE,
        now: () => NOW,
        fetch: (async () => {
          throw new Error("OIDC browser flow not used");
        }) as typeof fetch,
      }),
      transactions: new OidcTransactions(),
      identity,
      sessionSecret: "0123456789abcdef0123456789abcdef",
      sessionTtlMs: 60_000,
      now: () => NOW,
      gateway: new PlatformGateway({
        verifier: new GrantAwareVerifier({ bearer, identity }),
        streams: observed,
        namespaces: new NamespaceDispatcher(observed),
      }),
      deviceVerifier: bearer,
    });
    const response = await app.handle(
      new Request("https://platform.example.test/api/repos/acme/forest/main/events"),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { basis: string }).basis).toBe("public");
  });

  it("fails closed on plain-verifier gateways: public reads work, repo writes never do", async () => {
    const verifier = new BearerVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW,
      fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
    });
    const server = createPlatformServer(
      createPlatformHandler({ verifier, streams: new ObservedAdapter(direct) }),
    );
    const plainUrl = await listenPlatformServer(server);
    try {
      const read = await get("/api/repos/acme/forest/main/events", undefined, plainUrl);
      expect(read.status).toBe(200);
      const body = (await read.json()) as { identityOffset: string; basis: string };
      expect(body.basis).toBe("public");
      expect(body.identityOffset).toBe("-1");

      const token = signedToken(fixture, OWNER);
      const write = await post(
        "/api/dispatch",
        dispatchBody("fs:acme/forest:main:meta", { type: "x", payload: {}, ts: 1 }),
        token,
        plainUrl,
      );
      expect(write.status).toBe(403);
      // The namespace view alone still identifies the org owner; a
      // non-owner subject has no grant view to earn private access from.
      const ownerRead = await get("/api/repos/acme/secret/main/events", token, plainUrl);
      expect(ownerRead.status).toBe(200);
      expect(((await ownerRead.json()) as { basis: string }).basis).toBe("repo-owner");
      const outsiderToken = signedToken(fixture, OUTSIDER);
      const privateRead = await get(
        "/api/repos/acme/secret/main/events",
        outsiderToken,
        plainUrl,
      );
      expect(privateRead.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
