import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
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
  RegistryProjector,
  tokenHash,
} from "../src/index.js";

const ISSUER = "https://registry.test/";
const AUDIENCE = "eforest-api";
const NOW_MS = 1_700_000_000_000;
const KID = "registry-key";

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

export interface RegistryHttpFixture {
  readonly baseUrl: string;
  readonly officialUrl: string;
  readonly streams: OfficialStreamAdapter;
  readonly identity: IdentityStore;
  readonly namespaces: NamespaceDispatcher;
  readonly projector: RegistryProjector;
  /** A signed JWT backed by an active CLI grant (provisioned on first use). */
  token(sub: string): Promise<string>;
  /** A signed JWT with NO grant behind it — resolves to a revoked principal. */
  grantlessToken(sub: string): string;
  stop(): Promise<void>;
}

export interface RegistryFixtureOptions {
  /** Persist the stream store here (restart/destruction proofs). */
  readonly dataDir?: string;
  /** Do not start the projector loop (crash tests drive syncOnce themselves). */
  readonly manualProjector?: boolean;
}

/**
 * The production wiring in miniature, E2-T08 edition: GrantAwareVerifier over
 * a real IdentityStore (so org memberships flow from the replayed E2-T01
 * view), the shared NamespaceDispatcher, and a RegistryProjector wired into
 * the gateway exactly as production.ts does.
 */
export async function registryHttpFixture(
  options: RegistryFixtureOptions = {},
): Promise<RegistryHttpFixture> {
  const official = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
  });
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
  const projector = new RegistryProjector(streams, { pollMs: 100 });
  if (options.manualProjector !== true) projector.start();
  const server = createPlatformServer(
    createPlatformHandler({ verifier, streams, namespaces, registry: projector }),
  );
  const baseUrl = await listenPlatformServer(server);
  const issued = new Map<string, Promise<string>>();
  const issueToken = async (sub: string): Promise<string> => {
    const token = signedToken(fixture, sub);
    await identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
    await identity.issueCliGrant({
      grantId: `registry-grant-${randomUUID()}`,
      sub,
      tokenKind: "device",
      tokenHash: tokenHash(token),
      scopes: ["repo:write"],
    });
    return token;
  };
  return {
    baseUrl,
    officialUrl,
    streams,
    identity,
    namespaces,
    projector,
    token: (sub) => {
      let pending = issued.get(sub);
      if (pending === undefined) {
        pending = issueToken(sub);
        issued.set(sub, pending);
      }
      return pending;
    },
    grantlessToken: (sub) => signedToken(fixture, sub),
    async stop() {
      projector.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await official.stop();
    },
  };
}

export function nsEvent(type: string, payload: unknown, ts = 1): Record<string, unknown> {
  return { type, payload, ts };
}

export async function dispatchHttp(
  fixture: RegistryHttpFixture,
  streamId: string,
  event: Record<string, unknown>,
  sub?: string,
): Promise<Response> {
  return fetch(`${fixture.baseUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sub === undefined ? {} : { authorization: `Bearer ${await fixture.token(sub)}` }),
    },
    body: JSON.stringify({ streamId, event }),
  });
}

/** Wait until the projector has materialized at least `count` derived events. */
export async function awaitRegistryLength(
  fixture: RegistryHttpFixture,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const records = await fixture.streams.read("__registry__");
      if (records.length >= count) return;
    } catch {
      // not created yet
    }
    if (Date.now() > deadline) {
      throw new Error(`__registry__ did not reach ${String(count)} events in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Minimal SSE tail over fetch: collects data frames (with their `id:` offsets)
 * until closed. Parsing happens on raw text — no SSE library on the assertion
 * path.
 */
export interface SseTail {
  readonly frames: { readonly id: string; readonly data: string; readonly atMs: number }[];
  close(): void;
  waitForFrame(count: number, timeoutMs: number): Promise<void>;
}

export async function openSseTail(url: string, headers: Record<string, string>): Promise<SseTail> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200 || response.body === null) {
    controller.abort();
    throw new Error(`SSE tail failed: ${String(response.status)}`);
  }
  const frames: { id: string; data: string; atMs: number }[] = [];
  const decoder = new TextDecoder();
  let buffered = "";
  const reader = response.body.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (block.startsWith(":")) continue;
        const lines = block.split("\n");
        const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
        if (id !== undefined && data !== undefined) {
          frames.push({ id, data, atMs: Date.now() });
        }
      }
    }
  })().catch(() => undefined);
  return {
    frames,
    close() {
      controller.abort();
      void pump;
    },
    async waitForFrame(count, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `SSE tail did not receive frame ${String(count)} in ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

export const SUBJECTS = {
  alice: "auth0|alice",
  bob: "auth0|bob",
  carol: "auth0|carol",
  dave: "auth0|dave",
} as const;

async function acceptedOrThrow(response: Response): Promise<void> {
  if (response.status !== 202) {
    throw new Error(`dispatch refused: ${String(response.status)} ${await response.text()}`);
  }
}

/**
 * Golden (a): two orgs, mixed public/private repos by two subjects, one
 * rename, one private→public flip, one public→private flip — all five
 * derived event types. Carol is an acme member via the E2-T01 identity view.
 */
export async function buildLifecycleTree(fixture: RegistryHttpFixture): Promise<void> {
  const { alice, bob, carol, dave } = SUBJECTS;
  for (const sub of [alice, bob, carol, dave]) {
    await fixture.identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
  }
  await fixture.identity.createOrg("acme", "acme", alice);
  await fixture.identity.createOrg("beta", "beta", bob);
  await fixture.identity.grantMembership("acme", carol, "member");
  const steps: readonly [string, string, string, Record<string, unknown>, number][] = [
    [alice, "ns:root", "ns.org.create", { v: 1, name: "acme" }, 1],
    [alice, "ns:org:acme", "ns.project.create", { v: 1, name: "web" }, 2],
    [
      alice,
      "ns:org:acme",
      "ns.repo.create",
      { v: 1, name: "forest", project: "web", visibility: "public" },
      3,
    ],
    [
      alice,
      "ns:org:acme",
      "ns.repo.create",
      { v: 1, name: "secret", project: "web", visibility: "private" },
      4,
    ],
    [bob, "ns:root", "ns.org.create", { v: 1, name: "beta" }, 5],
    [bob, "ns:org:beta", "ns.project.create", { v: 1, name: "api" }, 6],
    [
      bob,
      "ns:org:beta",
      "ns.repo.create",
      { v: 1, name: "edge", project: "api", visibility: "private" },
      7,
    ],
    [
      bob,
      "ns:org:beta",
      "ns.repo.create",
      { v: 1, name: "open", project: "api", visibility: "public" },
      8,
    ],
    [alice, "ns:org:acme", "ns.repo.rename", { v: 1, name: "forest", newName: "grove" }, 9],
    [
      bob,
      "ns:org:beta",
      "ns.repo.set-visibility",
      { v: 1, name: "edge", visibility: "public" },
      10,
    ],
    [
      alice,
      "ns:org:acme",
      "ns.repo.set-visibility",
      { v: 1, name: "grove", visibility: "private" },
      11,
    ],
  ];
  for (const [sub, streamId, type, payload, ts] of steps) {
    await acceptedOrThrow(await dispatchHttp(fixture, streamId, nsEvent(type, payload, ts), sub));
  }
  await awaitRegistryLength(fixture, 11);
}
