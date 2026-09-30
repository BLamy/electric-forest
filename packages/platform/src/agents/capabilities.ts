import { randomBytes } from "node:crypto";
import { emptyView } from "@eforest/identity";
import {
  TokenRevokedError,
  type AuthorizationContext,
  type AuthorizationVerifier,
} from "../auth/grants.js";

/**
 * Per-run agent capabilities (the E6-T07 "role-scoped branch capability", in memory).
 *
 * An agent run gets a bearer token that exists only in this process's table and dies
 * with the run. The token resolves to the `agent:<handle>` principal with `agentOf` and
 * `agentBranch`, so the pure authz decision lets it read the org's repositories and
 * write exactly one branch. The token is JWT-shaped only so the `ef` CLI can derive its
 * writer id from `sub`; the platform never trusts its contents — lookup is by exact
 * string, and nothing about it is persisted.
 */

export interface AgentCapability {
  readonly org: string;
  readonly handle: string;
  readonly branch: string;
}

export interface IssuedAgentCapability {
  readonly token: string;
  revoke(): void;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export class AgentCapabilities {
  private readonly live = new Map<string, AgentCapability>();

  issue(capability: AgentCapability): IssuedAgentCapability {
    const token = [
      base64url(JSON.stringify({ alg: "none", typ: "eforest-agent-capability" })),
      base64url(JSON.stringify({ sub: `agent:${capability.handle}`, org: capability.org })),
      base64url(randomBytes(32)),
    ].join(".");
    this.live.set(token, capability);
    return { token, revoke: () => void this.live.delete(token) };
  }

  resolve(header: string | null): AgentCapability | undefined {
    if (header === null || !header.startsWith("Bearer ")) return undefined;
    return this.live.get(header.slice("Bearer ".length).trim());
  }
}

function contextFor(capability: AgentCapability): AuthorizationContext {
  return {
    principal: {
      kind: "identified",
      sub: `agent:${capability.handle}`,
      agentOf: capability.org,
      agentBranch: capability.branch,
    },
    identity: emptyView(),
    identityOffset: "-1",
  };
}

/** Wrap the platform verifier so live agent capability tokens resolve to agent principals. */
export function withAgentCapabilities(
  base: AuthorizationVerifier,
  capabilities: AgentCapabilities,
): AuthorizationVerifier {
  const withAuthorizedMutation: AuthorizationVerifier["withAuthorizedMutation"] =
    base.withAuthorizedMutation === undefined
      ? undefined
      : async (header, plan, mutation) => {
          const capability = capabilities.resolve(header);
          if (capability === undefined) {
            return base.withAuthorizedMutation!(header, plan, mutation);
          }
          const identity = { sub: `agent:${capability.handle}` };
          const operationId = `agent-${randomBytes(12).toString("hex")}`;
          // The run's capability is the grant: once revoked, no further write lands.
          const assertActive = (): Promise<void> =>
            capabilities.resolve(header) === undefined
              ? Promise.reject(new TokenRevokedError())
              : Promise.resolve();
          return mutation(identity, operationId, assertActive);
        };
  return {
    verifyAuthorization: async (header) => {
      const capability = capabilities.resolve(header);
      return capability === undefined
        ? base.verifyAuthorization(header)
        : { sub: `agent:${capability.handle}` };
    },
    authorizationContext: async (header) => {
      const capability = capabilities.resolve(header);
      if (capability !== undefined) return contextFor(capability);
      if (base.authorizationContext !== undefined) return base.authorizationContext(header);
      if (header === null || header.trim() === "") {
        return { principal: { kind: "anonymous" }, identity: emptyView(), identityOffset: "-1" };
      }
      const identity = await base.verifyAuthorization(header);
      return {
        principal: { kind: "identified", sub: identity.sub },
        identity: emptyView(),
        identityOffset: "-1",
      };
    },
    ...(withAuthorizedMutation === undefined ? {} : { withAuthorizedMutation }),
  };
}
