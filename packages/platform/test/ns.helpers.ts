import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  BearerVerifier,
  createPlatformHandler,
  createPlatformServer,
  listenPlatformServer,
  OfficialStreamAdapter,
} from "../src/index.js";

const ISSUER = "https://namespace.test/";
const AUDIENCE = "eforest-api";
const NOW_MS = 1_700_000_000_000;
const KID = "namespace-key";

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
    } as SigningFixture["publicJwk"],
  };
}

function signedToken(fixture: SigningFixture, sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub,
      iat: NOW_MS / 1000,
      exp: NOW_MS / 1000 + 300,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`;
}

export interface NamespaceHttpFixture {
  readonly baseUrl: string;
  readonly officialUrl: string;
  readonly streams: OfficialStreamAdapter;
  token(sub: string): string;
  stop(): Promise<void>;
}

export async function namespaceHttpFixture(): Promise<NamespaceHttpFixture> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const fixture = signingFixture();
  const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
  const verifier = new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW_MS,
    fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
  });
  const server = createPlatformServer(createPlatformHandler({ verifier, streams }));
  const baseUrl = await listenPlatformServer(server);
  return {
    baseUrl,
    officialUrl,
    streams,
    token: (sub) => signedToken(fixture, sub),
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await official.stop();
    },
  };
}

export function nsEvent(type: string, payload: unknown, ts = 1): Record<string, unknown> {
  return { type, payload, ts };
}

export async function dispatch(
  fixture: NamespaceHttpFixture,
  streamId: string,
  event: Record<string, unknown>,
  sub?: string,
  authorization?: string,
): Promise<Response> {
  return fetch(`${fixture.baseUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization !== undefined
        ? { authorization }
        : sub === undefined
          ? {}
          : { authorization: `Bearer ${fixture.token(sub)}` }),
    },
    body: JSON.stringify({ streamId, event }),
  });
}
