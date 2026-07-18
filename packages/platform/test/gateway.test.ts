import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Event } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import { BearerVerifier, PlatformGateway, type StreamAdapter } from "../src/index.js";

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
    const forged = `${valid.slice(0, -2)}aa`;
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
});
