import type { Server } from "node:http";
import { isAbsolute } from "node:path";
import { BearerVerifier } from "./auth.js";
import { GrantAwareVerifier } from "./auth/grants.js";
import { OidcClient, OidcTransactions } from "./auth/oidc.js";
import { IdentityStore } from "./auth/provision.js";
import { PlatformWebApp } from "./auth/routes.js";
import { PlatformGateway } from "./gateway.js";
import { NamespaceDispatcher } from "./ns/dispatch.js";
import { WriterLaneDispatcher } from "./writer-lanes.js";
import { OfficialStreamAdapter } from "./official.js";
import { RegistryProjector } from "./registry/projector.js";
import { createPlatformServer } from "./server.js";
import {
  DEFAULT_PLATFORM_RATE_LIMIT,
  FixedWindowRateLimiter,
  type FixedWindowRateLimitOptions,
} from "./rate-limit.js";

export interface PlatformEnvironment {
  readonly EF_OIDC_ISSUER: string;
  readonly EF_OIDC_CLIENT_ID: string;
  readonly EF_SESSION_SECRET: string;
  readonly EF_SESSION_TTL: string;
  readonly EFOREST_SERVER_URL: string;
  readonly EF_WEB_ROOT?: string;
}

export interface PlatformProductionRuntime {
  readonly oidc: OidcClient;
  readonly transactions: OidcTransactions;
  readonly identity: IdentityStore;
  readonly bearer: BearerVerifier;
  readonly namespaces: NamespaceDispatcher;
  readonly gateway: PlatformGateway;
  readonly registry: RegistryProjector;
  readonly rateLimiter: FixedWindowRateLimiter;
  readonly app: PlatformWebApp;
  readonly server: Server;
}

/**
 * Deterministic inputs for conformance/proof runs. Production callers omit
 * this object and retain cryptographic randomness, wall-clock time, and UUIDs.
 */
export interface PlatformProductionRuntimeOptions {
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
  readonly operationId?: () => string;
  readonly rateLimit?: Omit<FixedWindowRateLimitOptions, "now">;
  readonly webRoot?: string;
  readonly oidcFetch?: typeof fetch;
  /** Test-only proof data source; forbidden under NODE_ENV=production and absent from env config. */
  readonly testProofReceipt?: () => Promise<unknown | undefined>;
}

function required(environment: NodeJS.ProcessEnv, name: keyof PlatformEnvironment): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function absoluteHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must not contain a query or fragment`);
  }
  return url.href;
}

function sessionTtlMilliseconds(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("EF_SESSION_TTL must be a positive whole number of seconds");
  }
  const seconds = Number(value);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("EF_SESSION_TTL is too large");
  }
  return milliseconds;
}

function optionalAbsolutePath(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function readPlatformEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PlatformEnvironment {
  const webRoot = optionalAbsolutePath(environment.EF_WEB_ROOT, "EF_WEB_ROOT");
  return {
    EF_OIDC_ISSUER: absoluteHttpUrl(required(environment, "EF_OIDC_ISSUER"), "EF_OIDC_ISSUER"),
    EF_OIDC_CLIENT_ID: required(environment, "EF_OIDC_CLIENT_ID"),
    EF_SESSION_SECRET: required(environment, "EF_SESSION_SECRET"),
    EF_SESSION_TTL: required(environment, "EF_SESSION_TTL"),
    EFOREST_SERVER_URL: absoluteHttpUrl(
      required(environment, "EFOREST_SERVER_URL"),
      "EFOREST_SERVER_URL",
    ),
    ...(webRoot === undefined ? {} : { EF_WEB_ROOT: webRoot }),
  };
}

export async function createPlatformProductionRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: PlatformProductionRuntimeOptions = {},
): Promise<PlatformProductionRuntime> {
  if (process.env.NODE_ENV === "production" && options.testProofReceipt !== undefined) {
    throw new Error("test proof receipt is forbidden in production");
  }
  const config = readPlatformEnvironment(environment);
  const webRoot = options.webRoot ?? config.EF_WEB_ROOT;
  const oidc = new OidcClient({
    issuer: config.EF_OIDC_ISSUER,
    clientId: config.EF_OIDC_CLIENT_ID,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.oidcFetch === undefined ? {} : { fetch: options.oidcFetch }),
  });
  const transactions = new OidcTransactions(options.random);
  const streams = new OfficialStreamAdapter({ baseUrl: config.EFOREST_SERVER_URL });
  const namespaces = new NamespaceDispatcher(streams);
  const writers = new WriterLaneDispatcher(streams);
  const identity = new IdentityStore({
    baseUrl: config.EFOREST_SERVER_URL,
    ...(options.now === undefined ? {} : { now: options.now }),
    recoverNamespaceOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
    recoverGrantOperation: (operationId, operation) =>
      writers.recover(operationId, operation.streamId, operation.event).then(() => undefined),
  });
  await identity.ensure();
  await namespaces.reconcile();
  const bearer = new BearerVerifier({
    issuer: config.EF_OIDC_ISSUER,
    audience: config.EF_OIDC_CLIENT_ID,
    ...(options.oidcFetch === undefined ? {} : { fetch: options.oidcFetch }),
  });
  const registry = new RegistryProjector(streams);
  registry.start();
  const rateLimiter = new FixedWindowRateLimiter({
    ...(options.rateLimit ?? DEFAULT_PLATFORM_RATE_LIMIT),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const gateway = new PlatformGateway({
    verifier: new GrantAwareVerifier({
      bearer,
      identity,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    }),
    streams,
    namespaces,
    registry,
    rateLimiter,
    ...(webRoot === undefined ? {} : { webRoot }),
  });
  const app = new PlatformWebApp({
    oidc,
    transactions,
    identity,
    sessionSecret: config.EF_SESSION_SECRET,
    sessionTtlMs: sessionTtlMilliseconds(config.EF_SESSION_TTL),
    gateway,
    deviceVerifier: bearer,
    rateLimiter,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(options.testProofReceipt === undefined
      ? {}
      : { testProofReceipt: options.testProofReceipt }),
  });
  const server = createPlatformServer((request) => app.handle(request));
  return {
    oidc,
    transactions,
    identity,
    bearer,
    namespaces,
    gateway,
    registry,
    rateLimiter,
    app,
    server,
  };
}
