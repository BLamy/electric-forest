import type { Server } from "node:http";
import { isAbsolute } from "node:path";
import { parseBranchStreamId } from "@eforest/pr";
import { StreamFsRepo } from "@eforest/streamfs";
import { BearerVerifier } from "./auth.js";
import { GrantAwareVerifier, type AuthorizationVerifier } from "./auth/grants.js";
import { OidcClient, OidcTransactions } from "./auth/oidc.js";
import { IdentityStore } from "./auth/provision.js";
import { PlatformWebApp } from "./auth/routes.js";
import { PlatformGateway, type PlatformGatewayOptions } from "./gateway.js";
import { AgentRunCoordinator } from "./agent-runs.js";
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
  readonly EF_OIDC_PROXY_TARGET?: string;
  readonly EF_PUBLIC_ORIGIN?: string;
  readonly EF_WEB_ROOT?: string;
  readonly EF_RESEND_URL?: string;
  readonly EF_RESEND_API_KEY?: string;
  readonly EF_RESEND_FROM?: string;
  readonly EF_BOARD_CACHE_DIR?: string;
}

export interface PlatformProductionRuntime {
  readonly oidc: OidcClient;
  readonly transactions: OidcTransactions;
  readonly identity: IdentityStore;
  readonly bearer: BearerVerifier;
  readonly namespaces: NamespaceDispatcher;
  readonly gateway: PlatformGateway;
  readonly agentRuns: AgentRunCoordinator;
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
  /** Test-only gateway verifier for exercising a real app against a controlled local server. */
  readonly gatewayVerifier?: AuthorizationVerifier;
  /** Test-only authorization decision seam for controlled local integration harnesses. */
  readonly gatewayDecideAuthorization?: PlatformGatewayOptions["decideAuthorization"];
  /** Test-only namespace view seam for focused browser oracles outside the authz capstone. */
  readonly gatewayNamespaceViewReader?: PlatformGatewayOptions["namespaceViewReader"];
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
  const boardCacheDir = optionalAbsolutePath(environment.EF_BOARD_CACHE_DIR, "EF_BOARD_CACHE_DIR");
  return {
    EF_OIDC_ISSUER: absoluteHttpUrl(required(environment, "EF_OIDC_ISSUER"), "EF_OIDC_ISSUER"),
    EF_OIDC_CLIENT_ID: required(environment, "EF_OIDC_CLIENT_ID"),
    EF_SESSION_SECRET: required(environment, "EF_SESSION_SECRET"),
    EF_SESSION_TTL: required(environment, "EF_SESSION_TTL"),
    EFOREST_SERVER_URL: absoluteHttpUrl(
      required(environment, "EFOREST_SERVER_URL"),
      "EFOREST_SERVER_URL",
    ),
    ...(environment.EF_OIDC_PROXY_TARGET === undefined
      ? {}
      : {
          EF_OIDC_PROXY_TARGET: absoluteHttpUrl(
            environment.EF_OIDC_PROXY_TARGET,
            "EF_OIDC_PROXY_TARGET",
          ),
        }),
    ...(environment.EF_PUBLIC_ORIGIN === undefined
      ? {}
      : { EF_PUBLIC_ORIGIN: absoluteHttpUrl(environment.EF_PUBLIC_ORIGIN, "EF_PUBLIC_ORIGIN") }),
    ...(webRoot === undefined ? {} : { EF_WEB_ROOT: webRoot }),
    ...(boardCacheDir === undefined ? {} : { EF_BOARD_CACHE_DIR: boardCacheDir }),
    ...(environment.EF_RESEND_URL === undefined
      ? {}
      : { EF_RESEND_URL: absoluteHttpUrl(environment.EF_RESEND_URL, "EF_RESEND_URL") }),
    ...(environment.EF_RESEND_API_KEY === undefined
      ? {}
      : { EF_RESEND_API_KEY: environment.EF_RESEND_API_KEY }),
    ...(environment.EF_RESEND_FROM === undefined
      ? {}
      : { EF_RESEND_FROM: environment.EF_RESEND_FROM }),
  };
}

export async function createPlatformProductionRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: PlatformProductionRuntimeOptions = {},
): Promise<PlatformProductionRuntime> {
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
  const agentRuns = new AgentRunCoordinator({
    streams,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  let gateway!: PlatformGateway;
  const identity = new IdentityStore({
    baseUrl: config.EFOREST_SERVER_URL,
    ...(options.now === undefined ? {} : { now: options.now }),
    recoverNamespaceOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
    recoverGrantOperation: async (operationId, operation) => {
      if (operation.event.type === "pr.merge") {
        await gateway.recoverPrMergeOperation(operationId, operation.streamId, operation.event);
        return;
      }
      if (operation.event.type === "pr.opened") {
        // E5_T07_PRODUCTION_RECOVERY_BOUNDARY: recovery must re-enter target
        // admission, the source writer fence, and causal link propagation.
        await gateway.recoverPrOpenedGrantOperation(
          operationId,
          operation.streamId,
          operation.event,
        );
        return;
      }
      await writers.recover(operationId, operation.streamId, operation.event);
    },
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
  gateway = new PlatformGateway({
    verifier:
      options.gatewayVerifier ??
      new GrantAwareVerifier({
        bearer,
        identity,
        ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      }),
    streams,
    namespaces,
    registry,
    agentRuns,
    rateLimiter,
    prMerge: {
      resolveBranch: async (streamId) => {
        const branch = parseBranchStreamId(streamId);
        if (branch === undefined || !(await streams.exists(streamId))) return undefined;
        return new StreamFsRepo(
          config.EFOREST_SERVER_URL.replace(/\/+$/, ""),
          globalThis.fetch,
          `${branch.org}/${branch.repo}`,
          branch.branch,
          options.now ?? Date.now,
        );
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(options.gatewayDecideAuthorization === undefined
      ? {}
      : { decideAuthorization: options.gatewayDecideAuthorization }),
    ...(options.gatewayNamespaceViewReader === undefined
      ? {}
      : { namespaceViewReader: options.gatewayNamespaceViewReader }),
    ...(config.EF_BOARD_CACHE_DIR === undefined
      ? {}
      : { boardCacheDir: config.EF_BOARD_CACHE_DIR }),
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
    ...(config.EF_OIDC_PROXY_TARGET === undefined
      ? {}
      : { oidcProxyTarget: config.EF_OIDC_PROXY_TARGET }),
    ...(config.EF_PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: config.EF_PUBLIC_ORIGIN }),
    ...(config.EF_RESEND_URL === undefined || config.EF_RESEND_API_KEY === undefined
      ? {}
      : {
          resend: {
            baseUrl: config.EF_RESEND_URL,
            apiKey: config.EF_RESEND_API_KEY,
            from: config.EF_RESEND_FROM ?? "Electric Forest <invites@electric-forest.test>",
          },
        }),
  });
  const server = createPlatformServer((request) => app.handle(request));
  return {
    oidc,
    transactions,
    identity,
    bearer,
    namespaces,
    gateway,
    agentRuns,
    registry,
    rateLimiter,
    app,
    server,
  };
}
