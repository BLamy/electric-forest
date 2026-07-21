import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  BearerVerifier,
  createPlatformHandler,
  createPlatformServer,
  GrantAwareVerifier,
  IdentityStore,
  listenPlatformServer,
  NamespaceDispatcher,
  OfficialStreamAdapter,
  tokenHash,
} from "../src/index.js";
import type { StreamAdapter } from "../src/official.js";

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
  readonly createdStreamIds: readonly string[];
  readonly officialUrl: string;
  readonly streams: OfficialStreamAdapter;
  token(sub: string): string;
  /** Start a second, independent gateway (own dispatcher) over the same stream store. */
  attachGateway(): Promise<{ readonly baseUrl: string; stop(): Promise<void> }>;
  stop(): Promise<void>;
}

export async function namespaceHttpFixture(): Promise<NamespaceHttpFixture> {
  const createdStreamIds: string[] = [];
  const official = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path }) => {
      createdStreamIds.push(path);
    },
  });
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
  const attached: Array<() => Promise<void>> = [];
  return {
    baseUrl,
    createdStreamIds,
    officialUrl,
    streams,
    token: (sub) => signedToken(fixture, sub),
    async attachGateway() {
      const secondVerifier = new BearerVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        now: () => NOW_MS,
        fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
      });
      const secondStreams = new OfficialStreamAdapter({ baseUrl: officialUrl });
      const secondServer = createPlatformServer(
        createPlatformHandler({ verifier: secondVerifier, streams: secondStreams }),
      );
      const secondBaseUrl = await listenPlatformServer(secondServer);
      const stop = async (): Promise<void> => {
        await new Promise<void>((resolve) => secondServer.close(() => resolve()));
      };
      attached.push(stop);
      return { baseUrl: secondBaseUrl, stop };
    },
    async stop() {
      await Promise.all(attached.splice(0).map((stop) => stop()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await official.stop();
    },
  };
}

export interface GrantNamespaceFixture {
  readonly baseUrl: string;
  readonly officialUrl: string;
  readonly streams: OfficialStreamAdapter;
  readonly identity: IdentityStore;
  readonly namespaces: NamespaceDispatcher;
  grantToken(sub: string): Promise<{ readonly token: string; readonly grantId: string }>;
  stop(): Promise<void>;
}

/**
 * The production wiring in miniature: GrantAwareVerifier over a real IdentityStore,
 * the shared NamespaceDispatcher passed to the gateway, and namespace grant-operation
 * recovery routed through NamespaceDispatcher.recover exactly as production.ts does.
 */
export async function grantNamespaceFixture(): Promise<GrantNamespaceFixture> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const fixture = signingFixture();
  const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
  const namespaces = new NamespaceDispatcher(streams);
  const identity = new IdentityStore({
    baseUrl: officialUrl,
    now: () => NOW_MS,
    recoverNamespaceOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
  });
  await identity.ensure();
  const bearer = new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW_MS,
    fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
  });
  const verifier = new GrantAwareVerifier({ bearer, identity });
  const server = createPlatformServer(createPlatformHandler({ verifier, streams, namespaces }));
  const baseUrl = await listenPlatformServer(server);
  let grantOrdinal = 0;
  return {
    baseUrl,
    officialUrl,
    streams,
    identity,
    namespaces,
    async grantToken(sub) {
      const token = signedToken(fixture, sub);
      await identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
      grantOrdinal += 1;
      const grantId = `ns-grant-${grantOrdinal}`;
      await identity.issueCliGrant({
        grantId,
        sub,
        tokenKind: "device",
        tokenHash: tokenHash(token),
        scopes: ["repo:write"],
      });
      return { token, grantId };
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await official.stop();
    },
  };
}

export interface StalledNamespaceFixture {
  /** The gateway HTTP door wired over the stalled store. */
  readonly baseUrl: string;
  /** The stalled adapter itself, for direct dispatcher-level assertions. */
  readonly streams: StreamAdapter;
  token(sub: string): string;
  stop(): Promise<void>;
}

/**
 * A gateway over a store that can never make progress: every append re-raises
 * a GENUINE durable sequence-conflict error (captured from the real official
 * test server, not hand-built) while reads stay empty forever — the
 * no-progress shape only a misbehaving store produces. This is the permanent
 * home of the run-9 critic probe for the NamespaceContentionError → 503 path.
 */
export async function stalledNamespaceFixture(): Promise<StalledNamespaceFixture> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const real = new OfficialStreamAdapter({ baseUrl: officialUrl });
  const record = { offset: "0000000000000000_0000000000000000", type: "x", payload: {}, ts: 1 };
  await real.create("ns:conflict-source");
  await real.append("ns:conflict-source", record, { sequence: record.offset });
  let conflict: unknown;
  try {
    await real.append("ns:conflict-source", { ...record, ts: 2 }, { sequence: record.offset });
  } catch (error) {
    conflict = error;
  }
  if (conflict === undefined) {
    await official.stop();
    throw new Error("stalled fixture failed to capture a genuine durable conflict");
  }
  const streams = {
    async create() {},
    async read() {
      return [];
    },
    async append() {
      throw conflict;
    },
  } as unknown as StreamAdapter;
  const fixture = signingFixture();
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
  baseUrl?: string,
): Promise<Response> {
  return fetch(`${baseUrl ?? fixture.baseUrl}/api/dispatch`, {
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
