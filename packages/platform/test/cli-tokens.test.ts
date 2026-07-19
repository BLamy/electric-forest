import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createDurableJsonStream, readDurableJson } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import type { Event } from "@eforest/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BearerVerifier,
  GrantOperationAbortedError,
  GrantAwareVerifier,
  IdentityStore,
  OidcClient,
  OidcTransactions,
  OfficialStreamAdapter,
  PlatformGateway,
  PlatformWebApp,
  TokenRevokedError,
  createPlatformProductionRuntime,
  signedSessionCookie,
  tokenHash,
  type StreamAdapter,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const ISSUER = "https://issuer.example.test/";
const AUDIENCE = "eforest-cli";
const SECRET = "e2-t05-session-secret-is-long-enough-for-hmac";

class TargetStreams implements StreamAdapter {
  readonly events: Event[] = [];
  beforeAppend: (() => Promise<void>) | undefined;
  private readonly idempotentWrites = new Map<string, Promise<void>>();
  async create(): Promise<void> {}
  async append(
    _streamId: string,
    event: Event,
    options?: { readonly idempotencyKey: string },
  ): Promise<void> {
    if (options === undefined) {
      await this.beforeAppend?.();
      this.events.push(event);
      return;
    }
    const existing = this.idempotentWrites.get(options.idempotencyKey);
    if (existing !== undefined) return existing;
    const write = (async () => {
      await this.beforeAppend?.();
      this.events.push(event);
    })();
    this.idempotentWrites.set(options.idempotencyKey, write);
    try {
      await write;
    } catch (error) {
      this.idempotentWrites.delete(options.idempotencyKey);
      throw error;
    }
  }
  async read(): Promise<readonly unknown[]> {
    return this.events;
  }
  follow(): AsyncIterable<unknown> {
    return (async function* (): AsyncGenerator<unknown> {
      yield* [];
    })();
  }
}

interface SigningFixture {
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey & { readonly kid: string; readonly alg: string; readonly use: string };
}

function signingFixture(): SigningFixture {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    jwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "e2-t05-key",
      alg: "RS256",
      use: "sig",
    } as SigningFixture["jwk"],
  };
}

function jwt(
  fixture: SigningFixture,
  sub: string,
  claims: Readonly<Record<string, unknown>> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: fixture.jwk.kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub,
      iat: NOW / 1_000,
      exp: NOW / 1_000 + 300,
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
}

function deterministicRandom(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 41 + index * 13) & 0xff);
  };
}

let official: ReturnType<typeof createDurableStreamTestServer>;
let officialUrl: string;
let identity: IdentityStore;
let app: PlatformWebApp;
let targets: TargetStreams;
let fixture: SigningFixture;
let cookie: string;

beforeEach(async () => {
  official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  officialUrl = await official.start();
  identity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
  await identity.ensure();
  await identity.login("auth0|web-user", "web@example.test", "session-web");
  cookie = signedSessionCookie(SECRET, "session-web", 60);
  fixture = signingFixture();
  const bearer = new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    fetch: (async () => Response.json({ keys: [fixture.jwk] })) as typeof fetch,
  });
  targets = new TargetStreams();
  const gateway = new PlatformGateway({
    verifier: new GrantAwareVerifier({
      bearer,
      identity,
      operationId: (() => {
        let ordinal = 0;
        return () => `test-operation-${++ordinal}`;
      })(),
    }),
    streams: targets,
  });
  app = new PlatformWebApp({
    oidc: new OidcClient({
      issuer: ISSUER,
      clientId: AUDIENCE,
      now: () => NOW,
      fetch: (async () => {
        throw new Error("OIDC browser flow not used");
      }) as typeof fetch,
    }),
    transactions: new OidcTransactions(deterministicRandom()),
    identity,
    sessionSecret: SECRET,
    sessionTtlMs: 60_000,
    now: () => NOW,
    random: deterministicRandom(),
    gateway,
    deviceVerifier: bearer,
  });
});

afterEach(async () => {
  await official.stop();
});

function webRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://platform.example.test${path}`, {
    ...init,
    headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function mintRequest(headers: HeadersInit = { cookie }): Request {
  return new Request("https://platform.example.test/api/cli-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify({ name: "workstation", scopes: ["repo:write"] }),
  });
}

async function dispatch(token: string): Promise<Response> {
  return app.handle(
    new Request("https://platform.example.test/api/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        streamId: "target",
        event: { type: "test.created", payload: { value: 1 }, ts: NOW },
      }),
    }),
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("event-backed CLI grants", () => {
  it("mints once, lists without a secret, revokes, and flips the same door log-neutrally", async () => {
    const beforeMissing = await identity.snapshot();
    const missing = await app.handle(mintRequest({}));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { class: "auth-refused", reason: "bad-token" } });
    const afterMissing = await identity.snapshot();
    expect([afterMissing.offset, afterMissing.digest]).toEqual([
      beforeMissing.offset,
      beforeMissing.digest,
    ]);

    const beforeMint = await identity.snapshot();
    const minted = await app.handle(mintRequest());
    expect(minted.status).toBe(201);
    const mintedText = await minted.text();
    const mint = JSON.parse(mintedText) as { readonly grantId: string; readonly token: string };
    expect(mintedText.split(mint.token)).toHaveLength(2);
    const afterMint = await identity.snapshot();
    expect(afterMint.events).toHaveLength(beforeMint.events.length + 1);
    expect(afterMint.events.at(-1)).toMatchObject({
      type: "identity.grant.issued",
      payload: {
        grantId: mint.grantId,
        sub: "auth0|web-user",
        tokenKind: "web-mint",
        tokenHash: tokenHash(mint.token),
      },
    });

    const listed = await app.handle(webRequest("/api/cli-tokens"));
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(mint.token);
    expect(listedText).not.toContain(tokenHash(mint.token));
    expect(JSON.parse(listedText)).toMatchObject({
      tokens: [{ grantId: mint.grantId, name: "workstation", tokenKind: "web-mint" }],
    });

    const beforeDoor = targets.events.length;
    expect((await dispatch(mint.token)).status).toBe(202);
    expect(targets.events).toHaveLength(beforeDoor + 1);

    const beforeRevoke = await identity.snapshot();
    const revoked = await app.handle(
      webRequest(`/api/cli-tokens/${encodeURIComponent(mint.grantId)}`, { method: "DELETE" }),
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await identity.snapshot();
    expect(afterRevoke.events).toHaveLength(beforeRevoke.events.length + 1);
    expect(afterRevoke.events.at(-1)).toMatchObject({
      type: "identity.grant.revoked",
      payload: { grantId: mint.grantId, revokedAt: NOW },
    });

    const targetBeforeRefusal = [...targets.events];
    const refused = await dispatch(mint.token);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: { class: "token-revoked" } });
    expect(targets.events).toEqual(targetBeforeRefusal);

    const beforeDouble = await identity.snapshot();
    const double = await app.handle(
      webRequest(`/api/cli-tokens/${encodeURIComponent(mint.grantId)}`, { method: "DELETE" }),
    );
    expect(double.status).toBe(409);
    expect(await double.json()).toEqual({ error: { class: "grant-already-revoked" } });
    const afterDouble = await identity.snapshot();
    expect([afterDouble.offset, afterDouble.digest]).toEqual([
      beforeDouble.offset,
      beforeDouble.digest,
    ]);

    const unknown = await app.handle(
      webRequest("/api/cli-tokens/grant_unknown", { method: "DELETE" }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { class: "grant-not-found" } });
    const afterUnknown = await identity.snapshot();
    expect([afterUnknown.offset, afterUnknown.digest]).toEqual([
      beforeDouble.offset,
      beforeDouble.digest,
    ]);

    expect(JSON.stringify(afterUnknown.events)).not.toContain(mint.token);
  });

  it("requires a web session for mint and revoke even when a CLI token is valid", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string; readonly token: string };
    for (const request of [
      mintRequest({ authorization: `Bearer ${mint.token}` }),
      new Request(`https://platform.example.test/api/cli-tokens/${mint.grantId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${mint.token}` },
      }),
    ]) {
      const before = await identity.snapshot();
      const response = await app.handle(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { class: "web-session-required" } });
      const after = await identity.snapshot();
      expect([after.offset, after.digest]).toEqual([before.offset, before.digest]);
    }
  });

  it("registers a verified device JWT by hash and rejects mismatched identity", async () => {
    const access = jwt(fixture, "auth0|device-user");
    const idToken = jwt(fixture, "auth0|device-user", { email: "device@example.test" });
    const registered = await app.handle(
      new Request("https://platform.example.test/api/device-grants", {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({ idToken, name: "device", scopes: ["repo:write"] }),
      }),
    );
    expect(registered.status).toBe(201);
    const snapshot = await identity.snapshot();
    expect(snapshot.events.at(-1)).toMatchObject({
      type: "identity.grant.issued",
      payload: {
        sub: "auth0|device-user",
        tokenKind: "device",
        tokenHash: tokenHash(access),
      },
    });
    expect((await dispatch(access)).status).toBe(202);

    const beforeMismatch = await identity.snapshot();
    const mismatch = await app.handle(
      new Request("https://platform.example.test/api/device-grants", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt(fixture, "auth0|other")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idToken, scopes: ["repo:write"] }),
      }),
    );
    expect(mismatch.status).toBe(401);
    const afterMismatch = await identity.snapshot();
    expect([afterMismatch.offset, afterMismatch.digest]).toEqual([
      beforeMismatch.offset,
      beforeMismatch.digest,
    ]);
  });

  it("verifies JWT signatures before grant lookup and preserves the E2-T03 taxonomy", async () => {
    const attacker = signingFixture();
    const forged = jwt(
      { ...attacker, jwk: { ...attacker.jwk, kid: fixture.jwk.kid } },
      "auth0|device-user",
    );
    const before = await identity.snapshot();
    const response = await dispatch(forged);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", reason: "invalid_signature" },
    });
    const after = await identity.snapshot();
    expect([after.offset, after.digest]).toEqual([before.offset, before.digest]);
    expect(targets.events).toEqual([]);
  });

  it("serializes a cross-runtime in-flight append before revocation and survives restart", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string; readonly token: string };
    const appendEntered = deferred();
    const releaseAppend = deferred();
    targets.beforeAppend = async () => {
      appendEntered.resolve();
      await releaseAppend.promise;
    };

    const inFlight = dispatch(mint.token);
    await appendEntered.promise;
    const revokeAttempted = deferred();
    const remoteIdentity = new IdentityStore({
      baseUrl: officialUrl,
      now: () => NOW,
      onGrantRevocationBlocked: (grantId) => {
        expect(grantId).toBe(mint.grantId);
        revokeAttempted.resolve();
      },
      recoverGrantOperation: (operationId, operation) =>
        targets.append(operation.streamId, operation.event, { idempotencyKey: operationId }),
    });
    const revoking = remoteIdentity.revokeCliGrant(mint.grantId);
    const firstOutcome = await Promise.race([
      revokeAttempted.promise.then(() => "blocked" as const),
      revoking.then(() => "committed" as const),
    ]);
    expect(firstOutcome).toBe("blocked");
    const blocked = await remoteIdentity.snapshot();
    expect(blocked.view.grants[mint.grantId]?.status).toBe("active");
    expect(
      Object.values(blocked.view.grantOperations ?? {}).filter(
        (operation) => operation.grantId === mint.grantId && operation.status === "active",
      ),
    ).toHaveLength(1);

    releaseAppend.resolve();
    expect((await inFlight).status).toBe(202);
    await revoking;
    expect(targets.events).toHaveLength(1);
    const revoked = await remoteIdentity.snapshot();
    expect(revoked.view.grants[mint.grantId]?.status).toBe("revoked");
    expect(
      Object.values(revoked.view.grantOperations ?? {}).filter(
        (operation) => operation.grantId === mint.grantId && operation.status === "active",
      ),
    ).toEqual([]);
    expect(
      revoked.events
        .filter((event) =>
          [
            "identity.grant.operation.started",
            "identity.grant.operation.completed",
            "identity.grant.revoked",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "identity.grant.operation.started",
      "identity.grant.operation.completed",
      "identity.grant.revoked",
    ]);

    targets.beforeAppend = undefined;
    const restartedIdentity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
    const restartedGateway = new PlatformGateway({
      verifier: new GrantAwareVerifier({
        bearer: new BearerVerifier({
          issuer: ISSUER,
          audience: AUDIENCE,
          now: () => NOW,
          fetch: (async () => Response.json({ keys: [fixture.jwk] })) as typeof fetch,
        }),
        identity: restartedIdentity,
      }),
      streams: targets,
    });
    const restartedResponse = await restartedGateway.handle(
      new Request("https://platform.example.test/api/dispatch", {
        method: "POST",
        headers: { authorization: `Bearer ${mint.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "another-target",
          event: { type: "test.created", payload: { value: 2 }, ts: NOW + 1 },
        }),
      }),
    );
    expect(restartedResponse.status).toBe(401);
    expect(await restartedResponse.json()).toEqual({ error: { class: "token-revoked" } });
    expect(targets.events).toHaveLength(1);
  });

  it("recovers orphaned operations exactly once across both target-append crash points", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string };
    const plans = [
      {
        operationId: "orphan-before-target-append",
        streamId: "orphan-before-target",
        event: {
          type: "test.created",
          payload: { actor: "auth0|web-user", value: 4 },
          ts: NOW + 3,
        },
      },
      {
        operationId: "orphan-after-target-append",
        streamId: "orphan-after-target",
        event: {
          type: "test.created",
          payload: { actor: "auth0|web-user", value: 5 },
          ts: NOW + 4,
        },
      },
    ] as const;

    for (const plan of plans) {
      await createDurableJsonStream({ url: `${officialUrl}/streams/${plan.streamId}` });
      await identity.beginGrantOperation(mint.grantId, plan.operationId, plan);
    }
    const officialTargets = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const alreadyAppended = plans[1];
    await officialTargets.append(alreadyAppended.streamId, alreadyAppended.event, {
      idempotencyKey: alreadyAppended.operationId,
    });

    const restartedIdentity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
    await restartedIdentity.revokeCliGrant(mint.grantId);

    for (const plan of plans) {
      const url = `${officialUrl}/streams/${plan.streamId}`;
      expect(await readDurableJson({ url })).toEqual([plan.event]);
      // A runtime resuming after recovery must receive the producer duplicate
      // response without appending a second item.
      await officialTargets.append(plan.streamId, plan.event, {
        idempotencyKey: plan.operationId,
      });
      expect(await readDurableJson({ url })).toEqual([plan.event]);
    }
    const recovered = await restartedIdentity.snapshot();
    expect(recovered.view.grants[mint.grantId]?.status).toBe("revoked");
    expect(
      Object.values(recovered.view.grantOperations ?? {}).filter(
        (operation) => operation.grantId === mint.grantId && operation.status === "active",
      ),
    ).toEqual([]);
  });

  it("aborts a missing-target operation durably and permits revocation", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string };
    const operationId = "orphan-missing-target";
    const event = {
      type: "test.created",
      payload: { actor: "auth0|web-user", value: 6 },
      ts: NOW + 5,
    } satisfies Event;
    await identity.beginGrantOperation(mint.grantId, operationId, {
      streamId: "target-never-created",
      event,
    });

    const restartedIdentity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
    await restartedIdentity.revokeCliGrant(mint.grantId);

    const snapshot = await restartedIdentity.snapshot();
    expect(snapshot.view.grantOperations?.[operationId]).toMatchObject({
      status: "aborted",
      abortReason: "target-unavailable",
      abortedAt: NOW,
    });
    expect(snapshot.view.grants[mint.grantId]?.status).toBe("revoked");
    expect(
      snapshot.events
        .filter((record) =>
          [
            "identity.grant.operation.started",
            "identity.grant.operation.aborted",
            "identity.grant.revoked",
          ].includes(record.type),
        )
        .map((record) => record.type),
    ).toEqual([
      "identity.grant.operation.started",
      "identity.grant.operation.aborted",
      "identity.grant.revoked",
    ]);
    await expect(restartedIdentity.assertGrantOperationActive(operationId)).rejects.toBeInstanceOf(
      GrantOperationAbortedError,
    );
  });

  it("fences a late original runtime after its deleted target operation is aborted", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string; readonly token: string };
    const streamId = "target-deleted-before-recovery";
    const operationId = "late-runtime-deleted-target";
    const event = {
      type: "test.created",
      payload: { actor: "auth0|web-user", value: 7 },
      ts: NOW + 6,
    } satisfies Event;
    await createDurableJsonStream({ url: `${officialUrl}/streams/${streamId}` });
    const enteredMutation = deferred();
    const releaseMutation = deferred();
    const originalVerifier = new GrantAwareVerifier({
      bearer: new BearerVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        now: () => NOW,
        fetch: (async () => Response.json({ keys: [fixture.jwk] })) as typeof fetch,
      }),
      identity,
      operationId: () => operationId,
    });
    const officialTargets = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const lateOriginal = originalVerifier.withAuthorizedMutation(
      `Bearer ${mint.token}`,
      () => ({ streamId, event }),
      async (_requestIdentity, id, assertActive) => {
        enteredMutation.resolve();
        await releaseMutation.promise;
        await assertActive();
        await officialTargets.append(streamId, event, { idempotencyKey: id });
      },
    );
    await enteredMutation.promise;

    const deleted = await fetch(`${officialUrl}/streams/${streamId}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const restartedIdentity = new IdentityStore({ baseUrl: officialUrl, now: () => NOW });
    await restartedIdentity.revokeCliGrant(mint.grantId);
    await createDurableJsonStream({ url: `${officialUrl}/streams/${streamId}` });

    releaseMutation.resolve();
    await expect(lateOriginal).rejects.toBeInstanceOf(TokenRevokedError);
    expect(await readDurableJson({ url: `${officialUrl}/streams/${streamId}` })).toEqual([]);
    const snapshot = await restartedIdentity.snapshot();
    expect(snapshot.view.grantOperations?.[operationId]).toMatchObject({
      status: "aborted",
      abortReason: "target-unavailable",
    });
    expect(snapshot.view.grants[mint.grantId]?.status).toBe("revoked");
  });

  it("returns one success and one typed conflict for simultaneous HTTP revokes", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string };
    const path = `/api/cli-tokens/${encodeURIComponent(mint.grantId)}`;
    const [left, right] = await Promise.all([
      app.handle(webRequest(path, { method: "DELETE" })),
      app.handle(webRequest(path, { method: "DELETE" })),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(await conflict.json()).toEqual({ error: { class: "grant-already-revoked" } });
    const snapshot = await identity.snapshot();
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "identity.grant.revoked" &&
          (event.payload as { grantId?: string }).grantId === mint.grantId,
      ),
    ).toHaveLength(1);
  });

  it("rechecks the grant after a stalled request body before entering the append boundary", async () => {
    const minted = await app.handle(mintRequest());
    const mint = (await minted.json()) as { readonly grantId: string; readonly token: string };
    const bodyEntered = deferred();
    const releaseBody = deferred();
    const request = new Request("https://platform.example.test/api/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${mint.token}`, "content-type": "application/json" },
      body: "{}",
    });
    Object.defineProperty(request, "json", {
      value: async () => {
        bodyEntered.resolve();
        await releaseBody.promise;
        return {
          streamId: "target",
          event: { type: "test.created", payload: { value: 3 }, ts: NOW + 2 },
        };
      },
    });

    const stalled = app.handle(request);
    await bodyEntered.promise;
    const revoked = await app.handle(
      webRequest(`/api/cli-tokens/${encodeURIComponent(mint.grantId)}`, { method: "DELETE" }),
    );
    expect(revoked.status).toBe(200);
    releaseBody.resolve();

    const response = await stalled;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { class: "token-revoked" } });
    expect(targets.events).toEqual([]);
  });

  it("wires the grant-aware gateway in the production composition", async () => {
    const runtime = await createPlatformProductionRuntime({
      EF_OIDC_ISSUER: ISSUER,
      EF_OIDC_CLIENT_ID: AUDIENCE,
      EF_SESSION_SECRET: SECRET,
      EF_SESSION_TTL: "60",
      EFOREST_SERVER_URL: officialUrl,
    });
    expect(runtime.identity.streamId).toBe("__identity__");
    const response = await runtime.gateway.handle(
      new Request("https://platform.example.test/api/dispatch", {
        method: "POST",
        headers: { authorization: "Bearer forged.jwt.value", "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "target",
          event: { type: "test.created", payload: {}, ts: NOW },
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", reason: "malformed_token" },
    });
  });
});
