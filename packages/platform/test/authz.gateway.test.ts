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
  TokenRevokedError,
  tokenHash,
  type AuthorizationVerifier,
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

/** Fails every namespace-view read; everything else reaches the delegate. */
class NamespaceViewOutage implements StreamAdapter {
  constructor(private readonly delegate: StreamAdapter) {}

  async create(streamId: string): Promise<void> {
    return this.delegate.create(streamId);
  }

  async append(
    streamId: string,
    event: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): ReturnType<StreamAdapter["append"]> {
    return this.delegate.append(streamId, event, options);
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    if (streamId.startsWith("ns:")) throw new Error("namespace view replay outage");
    return this.delegate.read(streamId);
  }

  follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown> {
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
let bearer: BearerVerifier;

async function grantToken(
  sub: string,
  scopes: readonly string[],
): Promise<{
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

/** Serve one gateway wiring over real HTTP for the duration of `run`. */
async function withGateway(
  options: ConstructorParameters<typeof PlatformGateway>[0],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createPlatformServer(createPlatformHandler(options));
  const base = await listenPlatformServer(server);
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  bearer = new BearerVerifier({
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
    expect(bodies.every((candidate) => candidate === bodies[0])).toBe(true);
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
    const followPromise = get("/api/repos/acme/forest/main/events?live=1&after=1&waitMs=8000");
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
    expect(((await read.json()) as { error: { reason: string } }).error.reason).toBe(
      "authz/grant-revoked",
    );
  });

  it("re-authorizes a resumed private follow at the post-revocation identity offset", async () => {
    const reader = await grantToken(OUTSIDER, ["repo:read:acme/secret"]);
    const initial = await get("/api/repos/acme/secret/main/events", reader.token);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      count: number;
      identityOffset: string;
    };
    expect(initialBody.count).toBe(1);

    const revocation = await identity.revokeCliGrant(reader.grantId);
    expect(initialBody.identityOffset < revocation.offset).toBe(true);
    const operationsBeforeResume = observed.operations.length;
    const resumed = await get(
      `/api/repos/acme/secret/main/events?live=1&after=${initialBody.count}&waitMs=0`,
      reader.token,
    );
    expect(resumed.status).toBe(401);
    const resumedBody = (await resumed.json()) as {
      error: { reason: string; identityOffset: string };
    };
    expect(resumedBody.error.reason).toBe("authz/grant-revoked");
    expect(resumedBody.error.identityOffset >= revocation.offset).toBe(true);
    const resumeOperations = observed.operations.slice(operationsBeforeResume);
    expect(resumeOperations.filter((entry) => entry.op !== "read")).toEqual([]);
    expect(resumeOperations.filter((entry) => !entry.streamId.startsWith("ns:"))).toEqual([]);
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

  it("membership revocation takes effect at the next replayed identity view", async () => {
    const member = await grantToken(MEMBER, []);
    const before = await get("/api/repos/acme/secret/main/events", member.token);
    expect(before.status).toBe(200);
    expect(((await before.json()) as { basis: string }).basis).toBe("membership:member");

    const revocation = await identity.revokeMembership("acme", MEMBER);
    const after = await get("/api/repos/acme/secret/main/events", member.token);
    expect(after.status).toBe(404);
    const body = (await after.json()) as { error: { reason: string; identityOffset: string } };
    // The former member is now indistinguishable from any outsider, and the
    // refusal cites an offset at or after the revocation event.
    expect(body.error.reason).toBe("authz/not-found");
    expect(body.error.identityOffset >= revocation.offset).toBe(true);
  });

  it("refuses a revocation racing the dispatch at the durable serialization point", async () => {
    // The revocation lands AFTER the authorization decision allowed the
    // dispatch but BEFORE the grant operation is durably started: the
    // sequence-guarded operation append re-decides against the revoked view
    // and the refusal cites that exact offset.
    class RacingIdentityStore extends IdentityStore {
      raceRevocationOf: string | undefined;
      revocationOffset: string | undefined;

      override async beginGrantOperation(
        grantId: string,
        operationId: string,
        plan: Parameters<IdentityStore["beginGrantOperation"]>[2],
      ): ReturnType<IdentityStore["beginGrantOperation"]> {
        if (this.raceRevocationOf === grantId) {
          this.raceRevocationOf = undefined;
          this.revocationOffset = (await this.revokeCliGrant(grantId)).offset;
        }
        return super.beginGrantOperation(grantId, operationId, plan);
      }
    }
    const racing = new RacingIdentityStore({ baseUrl: officialUrl, now: () => NOW });
    const bearer = new BearerVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW,
      fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
    });
    const server = createPlatformServer(
      createPlatformHandler({
        verifier: new GrantAwareVerifier({ bearer, identity: racing }),
        streams: observed,
        namespaces: new NamespaceDispatcher(observed),
      }),
    );
    const racingUrl = await listenPlatformServer(server);
    try {
      const token = signedToken(fixture, OWNER, "racing");
      await racing.ensureUser(OWNER, "racing-owner@example.test");
      await racing.issueCliGrant({
        grantId: "racing-grant",
        sub: OWNER,
        tokenKind: "device",
        tokenHash: tokenHash(token),
        scopes: ["repo:write:acme/forest:main"],
      });
      racing.raceRevocationOf = "racing-grant";
      const streamBefore = JSON.stringify(await direct.read("fs:acme/forest:main:meta"));
      const response = await post(
        "/api/dispatch",
        dispatchBody("fs:acme/forest:main:meta", { type: "repo.race", payload: {}, ts: 50 }),
        token,
        racingUrl,
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as {
        error: { code: string; reason: string; identityOffset: string };
      };
      expect(body.error.code).toBe("authz_refused");
      expect(body.error.reason).toBe("authz/grant-revoked");
      expect(racing.revocationOffset).toBeDefined();
      expect(body.error.identityOffset >= racing.revocationOffset!).toBe(true);
      // The refused dispatch appended nothing to the target stream.
      expect(JSON.stringify(await direct.read("fs:acme/forest:main:meta"))).toBe(streamBefore);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      const privateRead = await get("/api/repos/acme/secret/main/events", outsiderToken, plainUrl);
      expect(privateRead.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resolves web-mint opaque tokens and refuses every cross-credential confusion", async () => {
    // (a) The web-mint success path: an opaque (non-JWT-shaped) token minted
    // by the web session resolves to its grant's principal at the gateway,
    // for reads AND for dispatches.
    const opaque = "eforest-web-mint-opaque-credential-1";
    expect(opaque.split(".").length).toBe(1);
    await identity.issueCliGrant({
      grantId: "web-mint-grant",
      sub: OUTSIDER,
      tokenKind: "web-mint",
      tokenHash: tokenHash(opaque),
      scopes: ["repo:read:acme/secret", "repo:write:acme/forest:main"],
    });
    const read = await get("/api/repos/acme/secret/main/events", opaque);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { basis: string }).basis).toBe("grant:read");
    const write = await post(
      "/api/dispatch",
      dispatchBody("fs:acme/forest:main:meta", { type: "repo.webmint", payload: {}, ts: 70 }),
      opaque,
    );
    expect(write.status).toBe(202);
    expect(((await write.json()) as { actor: string }).actor).toBe(OUTSIDER);

    // (b) A JWT-shaped token whose hash matches a web-mint grant is refused
    // as revoked — a device-looking credential never rides a web-mint grant.
    const jwtShaped = signedToken(fixture, OUTSIDER, "web-mint-jwt-confusion");
    await identity.issueCliGrant({
      grantId: "web-mint-jwt-grant",
      sub: OUTSIDER,
      tokenKind: "web-mint",
      tokenHash: tokenHash(jwtShaped),
      scopes: ["repo:read:acme/secret", "repo:write:acme/forest:main"],
    });
    // (c) A validly-signed JWT for sub A whose hash matches a grant issued to
    // sub B is refused as revoked — even though sub A (the org member) could
    // read the private repo on role alone with an honest credential.
    const crossSub = signedToken(fixture, MEMBER, "cross-sub-confusion");
    await identity.issueCliGrant({
      grantId: "cross-sub-grant",
      sub: OUTSIDER,
      tokenKind: "device",
      tokenHash: tokenHash(crossSub),
      scopes: ["repo:read:acme/secret", "repo:write:acme/forest:main"],
    });
    for (const confused of [jwtShaped, crossSub]) {
      const refusedRead = await get("/api/repos/acme/secret/main/events", confused);
      expect(refusedRead.status).toBe(401);
      const readBody = (await refusedRead.json()) as {
        error: { code: string; reason: string; identityOffset: string };
      };
      expect(readBody.error.code).toBe("authz_refused");
      expect(readBody.error.reason).toBe("authz/grant-revoked");
      expect(readBody.error.identityOffset).toMatch(/^\d{16}_\d{16}$/);
      const refusedWrite = await post(
        "/api/dispatch",
        dispatchBody("fs:acme/forest:main:meta", { type: "repo.confused", payload: {}, ts: 71 }),
        confused,
      );
      expect(refusedWrite.status).toBe(401);
      expect(((await refusedWrite.json()) as { error: { reason: string } }).error.reason).toBe(
        "authz/grant-revoked",
      );
    }
  });

  it("maps an unexpected grant-operation liveness failure to 502 with no append", async () => {
    // A verifier whose durable liveness re-check fails for a reason OTHER
    // than revocation must not report success and must not append.
    class FailingLivenessStore extends IdentityStore {
      override async assertGrantOperationActive(): Promise<void> {
        throw new Error("liveness backend exploded");
      }
    }
    const failing = new FailingLivenessStore({ baseUrl: officialUrl, now: () => NOW });
    const writer = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
    const before = JSON.stringify(await direct.read("fs:acme/forest:main:meta"));
    await withGateway(
      { verifier: new GrantAwareVerifier({ bearer, identity: failing }), streams: observed },
      async (base) => {
        const response = await post(
          "/api/dispatch",
          dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: {}, ts: 72 }),
          writer.token,
          base,
        );
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
          error: { code: "dispatch_failed", reason: "official_stream_append_failed" },
        });
      },
    );
    expect(JSON.stringify(await direct.read("fs:acme/forest:main:meta"))).toBe(before);
  });

  it("fails closed with 503 and no append when the namespace view cannot be replayed", async () => {
    const writer = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
    const before = await streamStates();
    const createdBefore = [...createdStreamIds];
    const opsBefore = observed.operations.length;
    await withGateway(
      {
        verifier: new GrantAwareVerifier({ bearer, identity }),
        streams: new NamespaceViewOutage(observed),
      },
      async (base) => {
        for (const route of [
          "/api/repos/acme/forest/main/events",
          "/api/repos/acme/forest/main/events?live=1&waitMs=100",
        ]) {
          const response = await get(route, undefined, base);
          expect(response.status, route).toBe(503);
          expect(await response.json(), route).toEqual({
            error: { code: "dispatch_failed", reason: "authz_view_unavailable" },
          });
        }
        const dispatch = await post(
          "/api/dispatch",
          dispatchBody("fs:acme/forest:main:meta", { type: "repo.write", payload: {}, ts: 73 }),
          writer.token,
          base,
        );
        expect(dispatch.status).toBe(503);
        expect(await dispatch.json()).toEqual({
          error: { code: "dispatch_failed", reason: "authz_view_unavailable" },
        });
      },
    );
    // Fail closed means fail silent: no stream minted, no log byte moved,
    // and no operation ever reached any target stream.
    expect(createdStreamIds).toEqual(createdBefore);
    expect(await streamStates()).toEqual(before);
    expect(observed.operations.slice(opsBefore)).toEqual([]);
  });

  it("replays a missing ns:root as the empty view and refuses as not-found", async () => {
    // A platform whose namespace streams do not exist yet decides against
    // the empty view: every repo is nonexistent, nothing throws.
    const bare = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const bareUrl = await bare.start();
    try {
      const gateway = new PlatformGateway({
        verifier: new GrantAwareVerifier({ bearer, identity }),
        streams: new OfficialStreamAdapter({ baseUrl: bareUrl }),
      });
      const response = await gateway.handle(
        new Request("https://gateway.test/api/repos/acme/forest/main/events"),
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { reason: string } }).error.reason).toBe(
        "authz/not-found",
      );
    } finally {
      await bare.stop();
    }
  });

  it("maps read-route credential failures through the same taxonomy as the door", async () => {
    const opsBefore = observed.operations.length;
    const basic = await fetch(`${baseUrl}/api/repos/acme/forest/main/events`, {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(basic.status).toBe(401);
    expect(await basic.json()).toEqual({
      error: { code: "unauthorized", reason: "malformed_authorization" },
    });
    const garbage = await get("/api/repos/acme/forest/main/events", "aaaa.bbbb.cccc");
    expect(garbage.status).toBe(401);
    expect(await garbage.json()).toEqual({
      error: { code: "unauthorized", reason: "malformed_token" },
    });
    // A verifier that reports revocation by throwing (the door's contract
    // for in-flight revocations) maps to the frozen token-revoked body.
    const throwing: AuthorizationVerifier = {
      verifyAuthorization: async () => {
        throw new TokenRevokedError("0000000000000000_0000000000000042");
      },
      authorizationContext: async () => {
        throw new TokenRevokedError("0000000000000000_0000000000000042");
      },
    };
    const gateway = new PlatformGateway({ verifier: throwing, streams: observed });
    const revoked = await gateway.handle(
      new Request("https://gateway.test/api/repos/acme/forest/main/events?live=1&waitMs=100"),
    );
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: { class: "token-revoked" } });
    // No credential failure ever reached a stream.
    expect(observed.operations.length).toBe(opsBefore);
  });

  it("refuses undecodable percent-escapes as malformed targets with no side effect", async () => {
    const before = await streamStates();
    const opsBefore = observed.operations.length;
    for (const route of [
      "/api/repos/%zz/x/main/events",
      "/api/repos/%c0%af/x/main/events",
      "/api/repos/acme/x/%/events",
      "/api/repos/acme/x/main%c0/events",
    ]) {
      const response = await get(route);
      expect(response.status, route).toBe(404);
      const body = (await response.json()) as { error: { code: string; reason: string } };
      expect(body.error.code, route).toBe("authz_refused");
      expect(body.error.reason, route).toBe("authz/malformed-target");
    }
    // Malformed targets are decided from the request text alone: no view
    // replay, no target-stream operation, no append anywhere.
    expect(observed.operations.length).toBe(opsBefore);
    expect(await streamStates()).toEqual(before);
  });

  it("bounds follow parameters and serves empty and timed-out polls as empty lists", async () => {
    for (const query of [
      "live=1&after=-1",
      "live=1&after=1.5",
      "live=1&after=x",
      "live=1&waitMs=-1",
      "live=1&waitMs=20001",
      "live=1&waitMs=x",
    ]) {
      const response = await get(`/api/repos/acme/forest/main/events?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toEqual({
        error: { code: "invalid_request", reason: "invalid_follow_parameters" },
      });
    }
    // The timeout arm: nothing past `after` arrives before waitMs elapses.
    const timedOut = await get("/api/repos/acme/forest/main/events?live=1&after=50&waitMs=250");
    expect(timedOut.status).toBe(200);
    expect(await timedOut.json()).toMatchObject({ ok: true, events: [], after: 50 });

    // An authorized read/follow of a repo whose physical stream has no
    // events (never created) returns an empty list, unmutated.
    const ns = await grantToken(OWNER, []);
    const created = await post(
      "/api/dispatch",
      dispatchBody("ns:org:acme", {
        type: "ns.repo.create",
        payload: { v: 1, name: "hollow", project: "trees", visibility: "public" },
        ts: 74,
      }),
      ns.token,
    );
    expect(created.status).toBe(202);
    const emptyRead = await get("/api/repos/acme/hollow/main/events");
    expect(emptyRead.status).toBe(200);
    expect(await emptyRead.json()).toMatchObject({ ok: true, events: [], count: 0 });
    const emptyFollow = await get("/api/repos/acme/hollow/main/events?live=1&waitMs=250");
    expect(emptyFollow.status).toBe(200);
    expect(await emptyFollow.json()).toMatchObject({ ok: true, events: [] });
  });

  it("returns the items gathered so far when the long-poll transport aborts on timeout", async () => {
    // The defensive arm for transports that surface the waitMs abort as an
    // AbortError/TimeoutError instead of a clean close: the poll still
    // answers 200 with whatever arrived, never a 500.
    const aborting: StreamAdapter = {
      create: async (streamId) => direct.create(streamId),
      append: async (streamId, event, options) => direct.append(streamId, event, options),
      read: async (streamId) => direct.read(streamId),
      follow: (): AsyncIterable<unknown> => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject(
              Object.assign(new Error("long-poll timed out"), { name: "TimeoutError" }),
            ),
        }),
      }),
    };
    const gateway = new PlatformGateway({
      verifier: new GrantAwareVerifier({ bearer, identity }),
      streams: aborting,
    });
    const response = await gateway.handle(
      new Request("https://gateway.test/api/repos/acme/forest/main/events?live=1&waitMs=100"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, events: [] });
  });

  it("rethrows non-not-found stream failures instead of masking them", async () => {
    const failing: StreamAdapter = {
      create: async (streamId) => direct.create(streamId),
      append: async (streamId, event, options) => direct.append(streamId, event, options),
      read: async (streamId) => {
        if (streamId.startsWith("fs:")) throw new Error("stream backend exploded");
        return direct.read(streamId);
      },
      follow: (streamId, signal): AsyncIterable<unknown> => {
        if (!streamId.startsWith("fs:")) return direct.follow(streamId, signal);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("stream backend exploded")),
          }),
        };
      },
    };
    const gateway = new PlatformGateway({
      verifier: new GrantAwareVerifier({ bearer, identity }),
      streams: failing,
    });
    await expect(
      gateway.handle(new Request("https://gateway.test/api/repos/acme/forest/main/events")),
    ).rejects.toThrow("stream backend exploded");
    await expect(
      gateway.handle(
        new Request("https://gateway.test/api/repos/acme/forest/main/events?live=1&waitMs=100"),
      ),
    ).rejects.toThrow("stream backend exploded");
  });

  it("classifies a revoked credential before the body parses and survives verifier throws", async () => {
    // Revocation classification is decided even when the body is unparseable:
    // the response is the frozen token-revoked body, never a 400.
    const revoked = await grantToken(OUTSIDER, []);
    await identity.revokeCliGrant(revoked.grantId);
    const before = await streamStates();
    const response = await fetch(`${baseUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${revoked.token}`,
      },
      body: "{not json",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { class: "token-revoked" } });

    // A verifier that throws something other than Unauthorized/TokenRevoked
    // is defended: the door answers 401 malformed_token, never a 500.
    const exploding: AuthorizationVerifier = {
      verifyAuthorization: async () => {
        throw new Error("verifier exploded");
      },
    };
    await withGateway({ verifier: exploding, streams: observed }, async (base) => {
      const defended = await post(
        "/api/dispatch",
        dispatchBody("sandbox-defended", { type: "x", payload: {}, ts: 75 }),
        "any-token",
        base,
      );
      expect(defended.status).toBe(401);
      expect(await defended.json()).toEqual({
        error: { code: "unauthorized", reason: "malformed_token" },
      });
    });
    expect(await streamStates()).toEqual(before);
  });
});
