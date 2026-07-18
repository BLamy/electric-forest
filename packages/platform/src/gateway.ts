import { isEvent, type Event } from "@eforest/protocol";
import { UnauthorizedError } from "./auth.js";
import { TokenRevokedError, type AuthorizationVerifier } from "./auth/grants.js";
import type { StreamAdapter } from "./official.js";

export interface PlatformGatewayOptions {
  readonly verifier: AuthorizationVerifier;
  readonly streams: StreamAdapter;
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
  if (ownActor(record.event.payload)) throw new TypeError("client_actor_forbidden");
  return { streamId: record.streamId, event: record.event };
}

export class PlatformGateway {
  private readonly verifier: AuthorizationVerifier;
  private readonly streams: StreamAdapter;

  constructor(options: PlatformGatewayOptions) {
    this.verifier = options.verifier;
    this.streams = options.streams;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/dispatch") return failure(404, "invalid_request", "not_found");
    if (request.method !== "POST") {
      return failure(405, "invalid_request", "method_not_allowed");
    }

    let identity;
    try {
      identity = await this.verifier.verifyAuthorization(request.headers.get("authorization"));
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

    const payload = parsed.event.payload as Record<string, unknown>;
    const event: Event = {
      ...parsed.event,
      payload: { ...payload, actor: identity.sub },
    };
    try {
      await this.streams.append(parsed.streamId, event);
    } catch {
      return failure(502, "dispatch_failed", "official_stream_append_failed");
    }
    return json(202, { ok: true, actor: identity.sub });
  }
}

export function createPlatformHandler(
  options: PlatformGatewayOptions,
): (request: Request) => Promise<Response> {
  const gateway = new PlatformGateway(options);
  return (request) => gateway.handle(request);
}
