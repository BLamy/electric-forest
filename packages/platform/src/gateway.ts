import { isDurableNotFound } from "@eforest/client";
import { isEvent, type Event } from "@eforest/protocol";
import { UnauthorizedError } from "./auth.js";
import {
  GrantTargetCommitError,
  GrantTargetUnavailableError,
  TokenRevokedError,
  type AuthorizationVerifier,
} from "./auth/grants.js";
import type { StreamAdapter } from "./official.js";
import { NamespaceDispatcher, NamespaceRefusalError, NamespaceSchemaError } from "./ns/dispatch.js";

export interface PlatformGatewayOptions {
  readonly verifier: AuthorizationVerifier;
  readonly streams: StreamAdapter;
  readonly namespaces?: NamespaceDispatcher;
}

type ErrorCode = "unauthorized" | "invalid_request" | "dispatch_failed";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: ErrorCode, reason: string): Response {
  return json(status, { error: { code, reason } });
}

function ownActor(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.prototype.hasOwnProperty.call(payload, "actor")
  );
}

function parseDispatch(value: unknown): { readonly streamId: string; readonly event: Event } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("body_must_be_object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.streamId !== "string" || record.streamId.length === 0) {
    throw new TypeError("invalid_stream_id");
  }
  if (!isEvent(record.event)) throw new TypeError("invalid_event");
  if (
    record.event.payload === null ||
    typeof record.event.payload !== "object" ||
    Array.isArray(record.event.payload)
  ) {
    throw new TypeError("payload_must_be_object");
  }
  return { streamId: record.streamId, event: record.event };
}

export class PlatformGateway {
  private readonly verifier: AuthorizationVerifier;
  private readonly streams: StreamAdapter;
  private readonly namespaces: NamespaceDispatcher;

  constructor(options: PlatformGatewayOptions) {
    this.verifier = options.verifier;
    this.streams = options.streams;
    this.namespaces = options.namespaces ?? new NamespaceDispatcher(options.streams);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/dispatch") return failure(404, "invalid_request", "not_found");
    if (request.method !== "POST") {
      return failure(405, "invalid_request", "method_not_allowed");
    }

    let preliminaryIdentity;
    try {
      preliminaryIdentity = await this.verifier.verifyAuthorization(
        request.headers.get("authorization"),
      );
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      return failure(401, "unauthorized", "malformed_token");
    }

    let parsed;
    try {
      parsed = parseDispatch(await request.json());
    } catch (error) {
      const reason = error instanceof TypeError ? error.message : "malformed_json";
      return failure(400, "invalid_request", reason);
    }
    const namespaceEvent = await this.namespaces.isEventType(parsed.event.type);
    if (!namespaceEvent && ownActor(parsed.event.payload)) {
      return failure(400, "invalid_request", "client_actor_forbidden");
    }

    try {
      const eventFor = async (identity: { readonly sub: string }): Promise<Event> => {
        if (namespaceEvent) {
          return this.namespaces.stampEvent(parsed.event, identity.sub);
        }
        const payload = parsed.event.payload as Record<string, unknown>;
        return {
          ...parsed.event,
          payload: { ...payload, actor: identity.sub },
        };
      };
      const mutate = async (
        identity: { readonly sub: string },
        operationId?: string,
        assertActive?: () => Promise<void>,
      ): Promise<Response> => {
        if (namespaceEvent) {
          await this.namespaces.dispatch(
            parsed.streamId,
            parsed.event,
            identity.sub,
            operationId,
            assertActive,
          );
          return json(202, { ok: true, actor: identity.sub });
        }
        const event = await eventFor(identity);
        try {
          if (operationId === undefined) {
            await this.streams.append(parsed.streamId, event);
          } else {
            await assertActive?.();
            const result = await this.streams.append(parsed.streamId, event, {
              idempotencyKey: operationId,
            });
            // A recovery fence may win at the official producer boundary while
            // this request is in flight. A closed-producer duplicate appends no
            // event, so re-read the durable operation before reporting 202.
            if (result === "producer-duplicate-closed") await assertActive?.();
          }
        } catch (error) {
          if (error instanceof TokenRevokedError) throw error;
          if (isDurableNotFound(error)) throw new GrantTargetUnavailableError();
          throw new GrantTargetCommitError(error);
        }
        return json(202, { ok: true, actor: identity.sub });
      };
      if (this.verifier.withAuthorizedMutation !== undefined) {
        return await this.verifier.withAuthorizedMutation(
          request.headers.get("authorization"),
          async (identity) => ({ streamId: parsed.streamId, event: await eventFor(identity) }),
          mutate,
        );
      }
      return await mutate(preliminaryIdentity);
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof NamespaceSchemaError || error instanceof TypeError) {
        return json(422, { error: { class: "schema-violation" } });
      }
      if (error instanceof NamespaceRefusalError) {
        return json(409, {
          error: { class: "validator-rejected", reason: error.reason },
        });
      }
      if (error instanceof GrantTargetUnavailableError || error instanceof GrantTargetCommitError) {
        return failure(502, "dispatch_failed", "official_stream_append_failed");
      }
      return failure(401, "unauthorized", "malformed_token");
    }
  }
}

export function createPlatformHandler(
  options: PlatformGatewayOptions,
): (request: Request) => Promise<Response> {
  const gateway = new PlatformGateway(options);
  return (request) => gateway.handle(request);
}
