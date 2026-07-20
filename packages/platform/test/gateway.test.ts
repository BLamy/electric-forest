import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Event } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  BearerVerifier,
  createPlatformHandler,
  OfficialStreamAdapter,
  PlatformGateway,
  type StreamAdapter,
} from "../src/index.js";

const ISSUER = "https://issuer.example.test/";
const AUDIENCE = "eforest-api";
const NOW_MS = 1_700_000_000_000;
const KID = "gateway-test-key";

interface SigningFixture {
  readonly privateKey: KeyObject;
  readonly publicJwk: JsonWebKey & {
    readonly kid: string;
    readonly alg: string;
    readonly use: string;
  };
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
    } as JsonWebKey & { readonly kid: string; readonly alg: string; readonly use: string },
  };
}

function token(
  fixture: SigningFixture,
  payload: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, ...header })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "auth0|alice",
      iat: NOW_MS / 1000,
      exp: NOW_MS / 1000 + 300,
      ...payload,
    }),
  ).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
}

function tokenFromPayloadJson(fixture: SigningFixture, payloadJson: string): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID })).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(payloadJson).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
}

class CountingAdapter implements StreamAdapter {
  readonly calls = { create: 0, append: 0, read: 0, follow: 0 };
  readonly events: Event[] = [];

  async create(): Promise<void> {
    this.calls.create += 1;
  }

  async append(_streamId: string, event: Event): Promise<void> {
    this.calls.append += 1;
    this.events.push(event);
  }

  async read(): Promise<readonly unknown[]> {
    this.calls.read += 1;
    return [];
  }

  follow(): AsyncIterable<unknown> {
    this.calls.follow += 1;
    return (async function* (): AsyncGenerator<unknown> {
      yield* [];
    })();
  }
}

function verifier(fixture: SigningFixture, fetcher?: typeof fetch): BearerVerifier {
  return new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW_MS,
    fetch:
      fetcher ??
      ((async () => Response.json({ keys: [fixture.publicJwk] })) as unknown as typeof fetch),
  });
}

function request(authorization?: string, payload: Record<string, unknown> = { value: 1 }): Request {
  return new Request("https://platform.example.test/api/dispatch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      streamId: "target",
      event: { type: "test.created", payload, ts: 1 },
    }),
  });
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("platform gateway authentication boundary", () => {
  it("injects the verified subject and only then appends", async () => {
    const fixture = signingFixture();
    const streams = new CountingAdapter();
    const gateway = new PlatformGateway({ verifier: verifier(fixture), streams });

    const response = await gateway.handle(request(`Bearer ${token(fixture)}`));

    expect(response.status).toBe(202);
    expect(await body(response)).toEqual({ ok: true, actor: "auth0|alice" });
    expect(streams.calls).toEqual({ create: 0, append: 1, read: 0, follow: 0 });
    expect(streams.events).toEqual([
      { type: "test.created", payload: { value: 1, actor: "auth0|alice" }, ts: 1 },
    ]);
  });

  it("treats the HTTP authentication scheme case-insensitively", async () => {
    const fixture = signingFixture();
    const streams = new CountingAdapter();
    const response = await new PlatformGateway({ verifier: verifier(fixture), streams }).handle(
      request(`bEaReR ${token(fixture)}`),
    );
    expect(response.status).toBe(202);
    expect(streams.calls.append).toBe(1);
  });

  it("rejects a client-supplied actor without touching streams", async () => {
    const fixture = signingFixture();
    const streams = new CountingAdapter();
    const gateway = new PlatformGateway({ verifier: verifier(fixture), streams });

    const response = await gateway.handle(
      request(`Bearer ${token(fixture)}`, { value: 1, actor: "client|mallory" }),
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      error: { code: "invalid_request", reason: "client_actor_forbidden" },
    });
    expect(streams.calls).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
  });

  it("returns typed 401s for every frozen token refusal before adapter access", async () => {
    const fixture = signingFixture();
    const other = signingFixture();
    const valid = token(fixture);
    const signatureStart = valid.lastIndexOf(".") + 1;
    const forged = `${valid.slice(0, signatureStart)}${valid[signatureStart] === "A" ? "B" : "A"}${valid.slice(signatureStart + 1)}`;
    const cases: Array<readonly [string, string | undefined, string]> = [
      ["missing", undefined, "missing_bearer_token"],
      ["wrong scheme", valid, "malformed_authorization"],
      ["malformed", "Bearer not.a.jwt.extra", "malformed_token"],
      ["forged", `Bearer ${forged}`, "invalid_signature"],
      [
        "wrong issuer",
        `Bearer ${token(fixture, { iss: "https://other.example.test" })}`,
        "wrong_issuer",
      ],
      ["wrong audience", `Bearer ${token(fixture, { aud: "other-api" })}`, "wrong_audience"],
      ["expired", `Bearer ${token(fixture, { exp: NOW_MS / 1000 })}`, "expired_token"],
      ["unknown kid", `Bearer ${token(fixture, {}, { kid: "unknown" })}`, "unknown_kid"],
      ["missing subject", `Bearer ${token(fixture, { sub: "" })}`, "missing_subject"],
      ["not active", `Bearer ${token(fixture, { nbf: NOW_MS / 1000 + 1 })}`, "token_not_active"],
      [
        "non-finite not-before",
        `Bearer ${tokenFromPayloadJson(
          fixture,
          `{"iss":"${ISSUER}","aud":"${AUDIENCE}","sub":"auth0|alice","exp":${NOW_MS / 1000 + 300},"nbf":-1e9999}`,
        )}`,
        "token_not_active",
      ],
      [
        "wrong algorithm",
        `Bearer ${token(fixture, {}, { alg: "HS256" })}`,
        "unsupported_algorithm",
      ],
      ["wrong key", `Bearer ${token(other)}`, "invalid_signature"],
    ];

    for (const [name, authorization, reason] of cases) {
      const streams = new CountingAdapter();
      const response = await new PlatformGateway({ verifier: verifier(fixture), streams }).handle(
        request(authorization),
      );
      expect(response.status, name).toBe(401);
      expect(await body(response), name).toEqual({ error: { code: "unauthorized", reason } });
      expect(streams.calls, name).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
    }
  });

  it("never throws or reaches streams for fuzzed Authorization headers and JWT segments", async () => {
    const fixture = signingFixture();
    const headers = [
      "",
      " ",
      "Bearer",
      "Bearer ",
      "bearer token",
      "Basic abc",
      "Bearer a",
      "Bearer a.b",
      "Bearer a.b.c.d",
      "Bearer ...",
      "Bearer !!!.e30.x",
      "Bearer e30.!!!.x",
      "Bearer e30.e30.!!!",
      "Bearer  e30.e30.x",
      `Bearer ${"a".repeat(16_384)}`,
    ];
    for (const authorization of headers) {
      const streams = new CountingAdapter();
      const response = await new PlatformGateway({ verifier: verifier(fixture), streams }).handle(
        request(authorization),
      );
      expect(response.status).toBe(401);
      expect(response.status).toBeLessThan(500);
      expect(streams.calls).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
    }
  });

  it("refreshes a rotated same-kid key and then rejects tokens from the retired key", async () => {
    const first = signingFixture();
    const second = signingFixture();
    let current = first;
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      return Response.json({ keys: [current.publicJwk] });
    }) as unknown as typeof fetch;
    const auth = verifier(first, fetcher);

    await expect(auth.verifyAuthorization(`Bearer ${token(first)}`)).resolves.toEqual({
      sub: "auth0|alice",
    });
    expect(fetches).toBe(1);
    current = second;
    await expect(auth.verifyAuthorization(`Bearer ${token(second)}`)).resolves.toEqual({
      sub: "auth0|alice",
    });
    expect(fetches).toBe(2);
    await expect(auth.verifyAuthorization(`Bearer ${token(first)}`)).rejects.toMatchObject({
      reason: "invalid_signature",
    });
    expect(fetches).toBe(3);
  });

  it("maps JWKS transport failures to a typed 401 without adapter access", async () => {
    const fixture = signingFixture();
    const streams = new CountingAdapter();
    const auth = verifier(fixture, (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    const response = await new PlatformGateway({ verifier: auth, streams }).handle(
      request(`Bearer ${token(fixture)}`),
    );
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({
      error: { code: "unauthorized", reason: "jwks_unavailable" },
    });
    expect(streams.calls).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
  });

  it("covers the exported handler routes, body validation, and append failure", async () => {
    const fixture = signingFixture();
    const streams = new CountingAdapter();
    const handler = createPlatformHandler({ verifier: verifier(fixture), streams });
    const authorization = `Bearer ${token(fixture)}`;

    const cases: Array<readonly [Request, number, string]> = [
      [new Request("https://platform.example.test/not-dispatch"), 404, "not_found"],
      [new Request("https://platform.example.test/api/dispatch"), 405, "method_not_allowed"],
      [
        new Request("https://platform.example.test/api/dispatch", {
          method: "POST",
          headers: { authorization },
          body: "not-json",
        }),
        400,
        "malformed_json",
      ],
      [
        request(authorization, [] as unknown as Record<string, unknown>),
        400,
        "payload_must_be_object",
      ],
    ];
    for (const [input, status, reason] of cases) {
      const response = await handler(input);
      expect(response.status).toBe(status);
      expect(await body(response)).toMatchObject({ error: { reason } });
    }
    expect(streams.calls).toEqual({ create: 0, append: 0, read: 0, follow: 0 });

    class FailingAdapter extends CountingAdapter {
      override async append(): Promise<void> {
        this.calls.append += 1;
        throw new Error("official stream unavailable");
      }
    }
    const failing = new FailingAdapter();
    const failed = await createPlatformHandler({ verifier: verifier(fixture), streams: failing })(
      request(authorization),
    );
    expect(failed.status).toBe(502);
    expect(await body(failed)).toEqual({
      error: { code: "dispatch_failed", reason: "official_stream_append_failed" },
    });
    expect(failing.calls).toEqual({ create: 0, append: 1, read: 0, follow: 0 });
    expect(failing.events).toEqual([]);
  });

  it("rejects every malformed dispatch shape after authenticating", async () => {
    const fixture = signingFixture();
    const authorization = `Bearer ${token(fixture)}`;
    const values: Array<readonly [unknown, string]> = [
      [null, "body_must_be_object"],
      [[], "body_must_be_object"],
      [{}, "invalid_stream_id"],
      [{ streamId: "" }, "invalid_stream_id"],
      [{ streamId: "target", event: null }, "invalid_event"],
      [
        { streamId: "target", event: { type: "test.created", payload: null, ts: 1 } },
        "payload_must_be_object",
      ],
    ];
    for (const [value, reason] of values) {
      const streams = new CountingAdapter();
      const response = await createPlatformHandler({ verifier: verifier(fixture), streams })(
        new Request("https://platform.example.test/api/dispatch", {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
      );
      expect(response.status, reason).toBe(400);
      expect(await body(response), reason).toEqual({
        error: { code: "invalid_request", reason },
      });
      expect(streams.calls, reason).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
    }
  });

  it("expires and coalesces the cached JWKS deterministically", async () => {
    const fixture = signingFixture();
    let now = NOW_MS;
    let fetches = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = new BearerVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => now,
      cacheTtlMs: 1_000,
      fetch: (async () => {
        fetches += 1;
        if (fetches === 1) await blocked;
        return Response.json({ keys: [fixture.publicJwk] });
      }) as unknown as typeof fetch,
    });
    const authorization = `Bearer ${token(fixture)}`;
    const first = auth.verifyAuthorization(authorization);
    const concurrent = auth.verifyAuthorization(authorization);
    release?.();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { sub: "auth0|alice" },
      { sub: "auth0|alice" },
    ]);
    expect(fetches).toBe(1);
    await auth.verifyAuthorization(authorization);
    expect(fetches).toBe(1);
    now += 1_001;
    await auth.verifyAuthorization(authorization);
    expect(fetches).toBe(2);
  });

  it("fails closed for non-OK, malformed, and unusable JWKS responses", async () => {
    const fixture = signingFixture();
    const authorization = `Bearer ${token(fixture)}`;
    const cases: Array<readonly [string, () => Promise<Response>, string]> = [
      ["non-OK", async () => new Response("offline", { status: 503 }), "jwks_unavailable"],
      ["invalid JSON", async () => new Response("not-json"), "jwks_unavailable"],
      ["missing keys", async () => Response.json({}), "jwks_unavailable"],
      [
        "non-RSA key",
        async () => Response.json({ keys: [{ kid: KID, kty: "EC" }] }),
        "unknown_kid",
      ],
      [
        "malformed RSA key",
        async () => Response.json({ keys: [{ kid: KID, kty: "RSA", use: "sig", alg: "RS256" }] }),
        "unknown_kid",
      ],
    ];
    for (const [name, response, reason] of cases) {
      const streams = new CountingAdapter();
      const gateway = new PlatformGateway({
        verifier: verifier(fixture, response as unknown as typeof fetch),
        streams,
      });
      const result = await gateway.handle(request(authorization));
      expect(result.status, name).toBe(401);
      expect(await body(result), name).toEqual({ error: { code: "unauthorized", reason } });
      expect(streams.calls, name).toEqual({ create: 0, append: 0, read: 0, follow: 0 });
    }
  });

  it("rejects empty stream ids before the official client fetches", async () => {
    let fetches = 0;
    const adapter = new OfficialStreamAdapter({
      baseUrl: "https://streams.example.test/",
      fetch: (async () => {
        fetches += 1;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    await expect(adapter.create("")).rejects.toThrow("streamId must not be empty");
    expect(fetches).toBe(0);
  });
});
