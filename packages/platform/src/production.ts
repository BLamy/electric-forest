import type { Server } from "node:http";
import { BearerVerifier } from "./auth.js";
import { GrantAwareVerifier } from "./auth/grants.js";
import { OidcClient, OidcTransactions } from "./auth/oidc.js";
import { IdentityStore } from "./auth/provision.js";
import { PlatformWebApp } from "./auth/routes.js";
import { PlatformGateway } from "./gateway.js";
import { NamespaceDispatcher } from "./ns/dispatch.js";
import { OfficialStreamAdapter } from "./official.js";
import { createPlatformServer } from "./server.js";

export interface PlatformEnvironment {
  readonly EF_OIDC_ISSUER: string;
  readonly EF_OIDC_CLIENT_ID: string;
  readonly EF_SESSION_SECRET: string;
  readonly EF_SESSION_TTL: string;
  readonly EFOREST_SERVER_URL: string;
}

export interface PlatformProductionRuntime {
  readonly oidc: OidcClient;
  readonly transactions: OidcTransactions;
  readonly identity: IdentityStore;
  readonly bearer: BearerVerifier;
  readonly gateway: PlatformGateway;
  readonly app: PlatformWebApp;
  readonly server: Server;
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

export function readPlatformEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PlatformEnvironment {
  return {
    EF_OIDC_ISSUER: absoluteHttpUrl(required(environment, "EF_OIDC_ISSUER"), "EF_OIDC_ISSUER"),
    EF_OIDC_CLIENT_ID: required(environment, "EF_OIDC_CLIENT_ID"),
    EF_SESSION_SECRET: required(environment, "EF_SESSION_SECRET"),
    EF_SESSION_TTL: required(environment, "EF_SESSION_TTL"),
    EFOREST_SERVER_URL: absoluteHttpUrl(
      required(environment, "EFOREST_SERVER_URL"),
      "EFOREST_SERVER_URL",
    ),
  };
}

export async function createPlatformProductionRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PlatformProductionRuntime> {
  const config = readPlatformEnvironment(environment);
  const oidc = new OidcClient({
    issuer: config.EF_OIDC_ISSUER,
    clientId: config.EF_OIDC_CLIENT_ID,
  });
  const transactions = new OidcTransactions();
  const streams = new OfficialStreamAdapter({ baseUrl: config.EFOREST_SERVER_URL });
  const namespaces = new NamespaceDispatcher(streams);
  const identity = new IdentityStore({
    baseUrl: config.EFOREST_SERVER_URL,
    recoverGrantOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
  });
  await identity.ensure();
  await namespaces.reconcile();
  const bearer = new BearerVerifier({
    issuer: config.EF_OIDC_ISSUER,
    audience: config.EF_OIDC_CLIENT_ID,
  });
  const gateway = new PlatformGateway({
    verifier: new GrantAwareVerifier({ bearer, identity }),
    streams,
    namespaces,
  });
  const app = new PlatformWebApp({
    oidc,
    transactions,
    identity,
    sessionSecret: config.EF_SESSION_SECRET,
    sessionTtlMs: sessionTtlMilliseconds(config.EF_SESSION_TTL),
    gateway,
    deviceVerifier: bearer,
  });
  const server = createPlatformServer((request) => app.handle(request));
  return { oidc, transactions, identity, bearer, gateway, app, server };
}
