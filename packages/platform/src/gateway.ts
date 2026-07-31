import {
  checkpoint as applicationCheckpoint,
  isDurableNotFound,
  type StreamBatch,
  type StreamCheckpoint,
  type StreamRecord,
} from "@eforest/client";
import { emptyView } from "@eforest/identity";
import {
  compareOffsets,
  isEvent,
  OFFSET_BEFORE_FIRST,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { requireReducer, type ReducerDefinition } from "@eforest/reducers";
import { UnauthorizedError } from "./auth.js";
import {
  GrantTargetCommitError,
  GrantTargetUnavailableError,
  TokenRevokedError,
  type AuthorizationContext,
  type AuthorizationVerifier,
} from "./auth/grants.js";
import {
  classifyDispatchTarget,
  decideStreamAuthorization,
  isAuthzName,
  repoTargetFromPath,
  type AuthzDecision,
  type AuthzRefused,
  type AuthzTarget,
} from "./authz/decide.js";
import { AuthzViewUnavailableError, NamespaceViewReader } from "./authz/view.js";
import type { NamespaceView } from "./ns/reducer.js";
import type { StreamAdapter } from "./official.js";
import {
  NamespaceContentionError,
  NamespaceDispatcher,
  NamespaceRefusalError,
  NamespaceSchemaError,
} from "./ns/dispatch.js";
import { resolvePath } from "./ns/resolve.js";
import {
  registryApplicationProjectionResponse,
  registryLongPollResponse,
  registrySnapshotResponse,
  registrySseResponse,
  type RegistryScope,
} from "./registry/doors.js";
import type { RegistryProjector } from "./registry/projector.js";
import { isWellFormedOffset, nextAllocatedOffset } from "@eforest/protocol/offset-allocation";
import type { AuthorizationView } from "@eforest/identity";
import {
  WriterLaneContentionError,
  WriterLaneCorruptionError,
  WriterLaneDispatcher,
  WriterLaneRefusalError,
} from "./writer-lanes.js";
import { classifyPlatformRoute } from "./route-topology.js";
import {
  DEFAULT_PLATFORM_RATE_LIMIT,
  FixedWindowRateLimiter,
  RateLimitExceededError,
  rateLimitResponse,
  type RateLimitOperation,
} from "./rate-limit.js";
import { decideTenantAccess } from "./tenant-isolation.js";

export interface PlatformGatewayOptions {
  readonly verifier: AuthorizationVerifier;
  readonly streams: StreamAdapter;
  readonly namespaces?: NamespaceDispatcher;
  /** Decision seam used by conformance sensitivity; production defaults to the pure door. */
  readonly decideAuthorization?: typeof decideStreamAuthorization;
  /** E2-T08: the registry projector to nudge after accepted namespace dispatches. */
  readonly registry?: RegistryProjector;
  /** Shared with the web app in production; tests inject a deterministic clock and limit. */
  readonly rateLimiter?: FixedWindowRateLimiter;
  /** Deterministic test seam; production always constructs the isolated replay reader. */
  readonly namespaceViewReader?: Pick<NamespaceViewReader, "viewFor">;
}

type ErrorCode = "unauthorized" | "invalid_request" | "dispatch_failed";

const MAX_FOLLOW_WAIT_MS = 20_000;
const DEFAULT_FOLLOW_WAIT_MS = 10_000;

class ApplicationProjectionError extends Error {
  readonly offset: string;

  constructor(offset: string, message: string) {
    super(message);
    this.name = "ApplicationProjectionError";
    this.offset = offset;
  }
}

function projectionRecord(value: unknown, previous: Offset): StreamRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationProjectionError(previous, "record is not an object");
  }
  const candidate = value as Record<string, unknown>;
  const offset = candidate.offset;
  if (typeof offset !== "string" || !isWellFormedOffset(offset) || offset === OFFSET_BEFORE_FIRST) {
    throw new ApplicationProjectionError(String(offset ?? previous), "invalid application offset");
  }
  if (compareOffsets(offset, previous) <= 0) {
    throw new ApplicationProjectionError(offset, "duplicate or out-of-order application offset");
  }
  let expected: Offset;
  try {
    expected = nextAllocatedOffset(previous);
  } catch {
    throw new ApplicationProjectionError(previous, "invalid prior application checkpoint");
  }
  if (offset !== expected) {
    throw new ApplicationProjectionError(
      expected,
      `missing application event before observed offset ${offset}`,
    );
  }
  const event = { type: candidate.type, payload: candidate.payload, ts: candidate.ts };
  if (!isEvent(event)) {
    throw new ApplicationProjectionError(offset, "invalid application event");
  }
  return { offset, ...event };
}

function projectionRecords(values: readonly unknown[], from: Offset): readonly StreamRecord[] {
  const records: StreamRecord[] = [];
  let previous = from;
  for (const value of values) {
    const record = projectionRecord(value, previous);
    records.push(record);
    previous = record.offset;
  }
  return records;
}

function validateProjectionReducer(
  definition: ReducerDefinition,
  events: readonly StreamRecord[],
): void {
  let state = definition.initialState;
  for (const event of events) {
    try {
      state = definition.reduce(state, event);
    } catch (error) {
      throw new ApplicationProjectionError(
        event.offset,
        `reducer rejected event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: ErrorCode, reason: string): Response {
  return json(status, { error: { code, reason } });
}

/**
 * Map a pure refusal to its transport response. Private-unauthorized and
 * nonexistent targets share one refusal (`authz/not-found`), so their
 * responses are byte-identical by construction. Every refusal cites the
 * exact identity-view offset the decision was replayed at.
 */
function authzRefusalResponse(decision: AuthzRefused): Response {
  const status =
    decision.refusal === "authz/grant-revoked" || decision.refusal === "authz/unauthenticated"
      ? 401
      : decision.refusal === "authz/write-grant-required"
        ? 403
        : 404;
  return json(status, {
    error: {
      code: "authz_refused",
      reason: decision.refusal,
      identityOffset: decision.identityOffset,
    },
  });
}

function ownKey(payload: unknown, key: "actor" | "writer"): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.prototype.hasOwnProperty.call(payload, key)
  );
}

function namespaceTenant(streamId: string): string {
  const prefix = "ns:org:";
  const tenant = streamId.startsWith(prefix) ? streamId.slice(prefix.length) : "control";
  return isAuthzName(tenant) ? tenant : "control";
}

function parseDispatch(value: unknown): {
  readonly streamId: string;
  readonly event: Event;
  readonly writerSeq?: number;
} {
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
  if (
    record.writerSeq !== undefined &&
    (typeof record.writerSeq !== "number" ||
      !Number.isSafeInteger(record.writerSeq) ||
      record.writerSeq < 1)
  ) {
    throw new TypeError("invalid_writer_sequence");
  }
  return {
    streamId: record.streamId,
    event: record.event,
    ...(record.writerSeq === undefined ? {} : { writerSeq: record.writerSeq as number }),
  };
}

export class PlatformGateway {
  private readonly verifier: AuthorizationVerifier;
  private readonly streams: StreamAdapter;
  private readonly namespaces: NamespaceDispatcher;
  private readonly writers: WriterLaneDispatcher;
  private readonly registry: RegistryProjector | undefined;
  private readonly decideAuthorization: typeof decideStreamAuthorization;
  private readonly rateLimiter: FixedWindowRateLimiter;
  /** Lazily constructed: only repo-target operations replay the namespace view. */
  private views: Pick<NamespaceViewReader, "viewFor"> | undefined;

  constructor(options: PlatformGatewayOptions) {
    this.verifier = options.verifier;
    this.streams = options.streams;
    this.namespaces = options.namespaces ?? new NamespaceDispatcher(options.streams);
    this.writers = new WriterLaneDispatcher(options.streams);
    this.registry = options.registry;
    this.decideAuthorization = options.decideAuthorization ?? decideStreamAuthorization;
    this.rateLimiter =
      options.rateLimiter ?? new FixedWindowRateLimiter(DEFAULT_PLATFORM_RATE_LIMIT);
    this.views = options.namespaceViewReader;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (classifyPlatformRoute(url.pathname)) {
      case "dispatch":
        return this.dispatchRoute(request);
      case "namespaces":
        return this.namespaceRoute(request, url);
      case "repos":
        return this.repoRoute(request, url);
      case "registry":
        return this.registryRoute(request, url);
      default:
        return failure(404, "invalid_request", "not_found");
    }
  }

  /**
   * The web shell has already resolved and validated its signed session
   * cookie against the identity stream. Keep that session credential out of
   * browser JavaScript while reusing the registry door with the exact
   * replayed authorization view.
   */
  async handleSessionRegistry(
    request: Request,
    subject: string,
    authView: AuthorizationView,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/registry/me" || request.headers.has("authorization")) {
      return failure(404, "invalid_request", "not_found");
    }
    return this.registryRoute(request, url, { subject, authView });
  }

  /**
   * Resolve the request's authorization context. Verifiers without a grant
   * view (the plain E2-T03 BearerVerifier) authenticate the JWT and yield a
   * grant-less principal over the empty identity view: such principals can
   * never satisfy a grant-scoped rule, so they fail closed on private and
   * write decisions.
   */
  private async authzContext(header: string | null): Promise<AuthorizationContext> {
    if (this.verifier.authorizationContext !== undefined) {
      return this.verifier.authorizationContext(header);
    }
    if (header === null || header.trim() === "") {
      return { principal: { kind: "anonymous" }, identity: emptyView(), identityOffset: "-1" };
    }
    const identity = await this.verifier.verifyAuthorization(header);
    return {
      principal: { kind: "identified", sub: identity.sub },
      identity: emptyView(),
      identityOffset: "-1",
    };
  }

  private async namespaceViewFor(org: string): Promise<NamespaceView> {
    this.views ??= new NamespaceViewReader(this.streams);
    return this.views.viewFor(org);
  }

  private admitRate(tenant: string, subject: string | null, operation: RateLimitOperation): void {
    const decision = this.rateLimiter.consume({
      tenant,
      subject: subject ?? "anonymous",
      operation,
    });
    if (!decision.allowed) throw new RateLimitExceededError(decision);
  }

  private tenantRefusal(
    context: AuthorizationContext,
    tenant: string,
    operation: "read" | "follow" | "dispatch",
  ): AuthzRefused | undefined {
    const subject = context.principal.kind === "identified" ? context.principal.sub : null;
    if (decideTenantAccess(context.identity, subject, tenant).allowed) return undefined;
    return {
      allowed: false,
      operation,
      identityOffset: context.identityOffset,
      refusal: "authz/not-found",
    };
  }

  /**
   * Authenticated, read-only namespace resolution through the single E2-T06
   * reducer/resolver pair. Authentication completes before any namespace
   * stream is read, so a refused credential cannot touch namespace state.
   */
  private async namespaceRoute(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    let context: AuthorizationContext;
    try {
      context = await this.authzContext(request.headers.get("authorization"));
      if (context.principal.kind !== "identified" || context.principal.sub.length === 0) {
        await this.verifier.verifyAuthorization(request.headers.get("authorization"));
      }
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      return failure(401, "unauthorized", "malformed_token");
    }

    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice("/api/namespaces/".length));
    } catch {
      return failure(404, "invalid_request", "not_found");
    }
    const org = path.split("/")[0] ?? "";
    if (!isAuthzName(org)) return failure(404, "invalid_request", "not_found");

    try {
      const tenantRefusal = this.tenantRefusal(context, org, "read");
      if (tenantRefusal !== undefined) return authzRefusalResponse(tenantRefusal);
      this.admitRate(
        org,
        context.principal.kind === "identified" ? context.principal.sub : null,
        "namespace.lookup",
      );
      const resolution = resolvePath(await this.namespaceViewFor(org), path);
      return json(200, { ok: true, path, resolution });
    } catch (error) {
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      throw error;
    }
  }

  /**
   * Decide a repo-target operation. Refusals are computed entirely from the
   * two replayed views (`__identity__`, `ns:root`/`ns:org:<org>`): the
   * target stream itself is never created, read, followed, or appended for
   * a refused operation, and nothing is appended anywhere.
   */
  private async decideRepo(
    operation: "read" | "follow" | "dispatch",
    target: AuthzTarget,
    header: string | null,
  ): Promise<AuthzDecision> {
    const context = await this.authzContext(header);
    // GrantAwareVerifier deliberately represents an unknown/revoked grant as
    // an identified principal with grantId="" and (for opaque tokens) an
    // empty subject. Credential refusal precedes tenant accounting: an
    // unauthenticated credential must neither consume quota nor become a
    // malformed counter key. The pure decision returns grant-revoked before
    // consulting the namespace view for every well-formed repo target.
    if (
      target.kind === "repo" &&
      context.principal.kind === "identified" &&
      context.principal.grantId === ""
    ) {
      return this.decideAuthorization({
        operation,
        target,
        principal: context.principal,
        ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
        identity: context.identity,
        identityOffset: context.identityOffset,
        namespace: { orgs: {} },
      });
    }
    if (target.kind === "repo") {
      const tenantRefusal = this.tenantRefusal(context, target.org, operation);
      if (tenantRefusal !== undefined) return tenantRefusal;
      this.admitRate(
        target.org,
        context.principal.kind === "identified" ? context.principal.sub : null,
        operation === "read"
          ? "application.read"
          : operation === "follow"
            ? "application.follow"
            : "application.dispatch",
      );
    } else {
      this.admitRate(
        "malformed",
        context.principal.kind === "identified" ? context.principal.sub : null,
        operation === "read"
          ? "application.read"
          : operation === "follow"
            ? "application.follow"
            : "application.dispatch",
      );
    }
    const namespace =
      target.kind === "repo" ? await this.namespaceViewFor(target.org) : { orgs: {} };
    return this.decideAuthorization({
      operation,
      target,
      principal: context.principal,
      ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
      identity: context.identity,
      identityOffset: context.identityOffset,
      namespace,
    });
  }

  private async dispatchRoute(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return failure(405, "invalid_request", "method_not_allowed");
    }

    let preliminaryIdentity;
    let revokedCredential: TokenRevokedError | undefined;
    try {
      preliminaryIdentity = await this.verifier.verifyAuthorization(
        request.headers.get("authorization"),
      );
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        // Authentication stays first (frozen E2-T03/E2-T05 door ordering),
        // but a revoked credential aimed at a repo stream must cite the
        // identity-view offset that refused it — classify the target first.
        revokedCredential = error;
      } else if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      } else {
        return failure(401, "unauthorized", "malformed_token");
      }
    }

    let parsed;
    try {
      parsed = parseDispatch(await request.json());
    } catch (error) {
      if (revokedCredential !== undefined) {
        return json(401, { error: { class: "token-revoked" } });
      }
      const reason = error instanceof TypeError ? error.message : "malformed_json";
      return failure(400, "invalid_request", reason);
    }
    const namespaceEvent = await this.namespaces.isEventType(parsed.event.type);
    const target = classifyDispatchTarget(
      parsed.streamId,
      namespaceEvent ? "namespace" : "application",
    );
    if (revokedCredential !== undefined) {
      if (target.kind === "repo" || target.kind === "malformed") {
        return authzRefusalResponse({
          allowed: false,
          operation: "dispatch",
          identityOffset: revokedCredential.identityOffset ?? "-1",
          refusal: target.kind === "malformed" ? "authz/malformed-target" : "authz/grant-revoked",
        });
      }
      return json(401, { error: { class: "token-revoked" } });
    }
    if (!namespaceEvent && ownKey(parsed.event.payload, "actor")) {
      return failure(400, "invalid_request", "client_actor_forbidden");
    }
    if (!namespaceEvent && ownKey(parsed.event.payload, "writer")) {
      return failure(400, "invalid_request", "client_writer_forbidden");
    }

    try {
      // E2-T07: every dispatch is decided before any official-stream
      // operation. Repo targets replay both views; control and sandbox
      // targets are decided purely (no reads) and keep their frozen door
      // behavior; internal and malformed targets always refuse.
      let repoDecision: AuthzDecision | undefined;
      if (target.kind === "repo") {
        repoDecision = await this.decideRepo(
          "dispatch",
          target,
          request.headers.get("authorization"),
        );
        if (!repoDecision.allowed) return authzRefusalResponse(repoDecision);
      } else {
        const tenant = target.kind === "control" ? namespaceTenant(parsed.streamId) : target.kind;
        if (target.kind === "control" && tenant !== "control") {
          const context = await this.authzContext(request.headers.get("authorization"));
          const tenantRefusal = this.tenantRefusal(context, tenant, "dispatch");
          if (tenantRefusal !== undefined) return authzRefusalResponse(tenantRefusal);
        }
        this.admitRate(tenant, preliminaryIdentity!.sub, "application.dispatch");
        const decision = decideStreamAuthorization({
          operation: "dispatch",
          target,
          principal: { kind: "identified", sub: preliminaryIdentity!.sub },
          eventKind: namespaceEvent ? "namespace" : "application",
          identity: emptyView(),
          identityOffset: "-1",
          namespace: { orgs: {} },
        });
        if (!decision.allowed) return authzRefusalResponse(decision);
      }

      const eventFor = async (
        identity: { readonly sub: string },
        _operationId?: string,
      ): Promise<Event> => {
        if (namespaceEvent) {
          return this.namespaces.stampEvent(parsed.event, identity.sub);
        }
        // Grant-aware planning must remain target-I/O-free: E2-T05 records
        // the durable operation before discovering a missing/closed target.
        // Writer metadata is stamped only at target mutation time, after the
        // operation is durable; recovery derives the same next lane from the
        // target stream and recognizes a prior append by operation id.
        const payload = parsed.event.payload as Record<string, unknown>;
        return { ...parsed.event, payload: { ...payload, actor: identity.sub } };
      };
      const mutate = async (
        identity: { readonly sub: string },
        operationId?: string,
        assertActive?: () => Promise<void>,
        decidedAt?: string,
      ): Promise<Response> => {
        if (namespaceEvent) {
          await this.namespaces.dispatch(
            parsed.streamId,
            parsed.event,
            identity.sub,
            operationId,
            assertActive,
          );
          // E2-T08: nudge the registry projector — the accepted source event
          // becomes a derived frame without waiting for the poll interval.
          this.registry?.poke();
          return json(202, { ok: true, actor: identity.sub });
        }
        try {
          if (operationId === undefined) {
            await this.writers.dispatch(parsed.streamId, parsed.event, identity.sub, {
              ...(parsed.writerSeq === undefined ? {} : { requestedSequence: parsed.writerSeq }),
            });
          } else {
            await this.writers.dispatch(parsed.streamId, parsed.event, identity.sub, {
              operationId,
              ...(parsed.writerSeq === undefined ? {} : { requestedSequence: parsed.writerSeq }),
              ...(assertActive === undefined ? {} : { assertActive }),
            });
          }
        } catch (error) {
          if (error instanceof TokenRevokedError) throw error;
          if (
            error instanceof WriterLaneRefusalError ||
            error instanceof WriterLaneCorruptionError ||
            error instanceof WriterLaneContentionError
          ) {
            throw error;
          }
          if (isDurableNotFound(error)) throw new GrantTargetUnavailableError();
          throw new GrantTargetCommitError(error);
        }
        if (target.kind === "repo") {
          return json(202, {
            ok: true,
            actor: identity.sub,
            identityOffset: decidedAt ?? repoDecision!.identityOffset,
          });
        }
        return json(202, { ok: true, actor: identity.sub });
      };
      if (this.verifier.withAuthorizedMutation !== undefined) {
        return await this.verifier.withAuthorizedMutation(
          request.headers.get("authorization"),
          async (identity, operationId) => ({
            streamId: parsed.streamId,
            event: await eventFor(identity, operationId),
          }),
          mutate,
        );
      }
      return await mutate(preliminaryIdentity!);
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        if (target.kind === "repo") {
          return authzRefusalResponse({
            allowed: false,
            operation: "dispatch",
            identityOffset: error.identityOffset ?? "-1",
            refusal: "authz/grant-revoked",
          });
        }
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      if (error instanceof NamespaceSchemaError || error instanceof TypeError) {
        return json(422, { error: { class: "schema-violation" } });
      }
      if (error instanceof NamespaceRefusalError) {
        return json(409, {
          error: { class: "validator-rejected", reason: error.reason },
        });
      }
      if (error instanceof WriterLaneRefusalError) {
        return json(409, {
          error: {
            class: "validator-rejected",
            reason: error.reason,
            expected: error.expected,
            provided: error.provided,
          },
        });
      }
      if (error instanceof WriterLaneCorruptionError) {
        return failure(503, "dispatch_failed", "writer_lane_corrupt");
      }
      if (error instanceof AuthzViewUnavailableError) {
        // Fail closed: without a replayed namespace view there is no
        // decision, no official-stream operation, and no append.
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof GrantTargetUnavailableError || error instanceof GrantTargetCommitError) {
        return failure(502, "dispatch_failed", "official_stream_append_failed");
      }
      if (error instanceof NamespaceContentionError) {
        // Internal append contention is a retryable coordination failure and
        // must never surface as an authentication error.
        return failure(503, "dispatch_failed", "namespace_contention");
      }
      if (error instanceof WriterLaneContentionError) {
        return failure(503, "dispatch_failed", "writer_lane_contention");
      }
      return failure(401, "unauthorized", "malformed_token");
    }
  }

  /**
   * E2-T08: `GET /registry/public | /registry/org/:org | /registry/me` in
   * snapshot, long-poll, and SSE modes. Every answer is filtered per the
   * requesting identity via the single `filterForIdentity`; `/registry/me`
   * requires a valid token (E2-T03's exact 401 otherwise); `/registry/org/:x`
   * for anonymous or non-member identities FILTERS (public subset) rather
   * than refusing — listing is filtered, not refused.
   */
  private async registryRoute(
    request: Request,
    url: URL,
    trustedSession?: { readonly subject: string; readonly authView: AuthorizationView },
  ): Promise<Response> {
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    const segments = url.pathname.split("/").slice(2);
    let scope: RegistryScope;
    let identityFree = false;
    let requireToken = false;
    if (segments.length === 1 && segments[0] === "public") {
      scope = {};
      identityFree = true;
    } else if (segments.length === 1 && segments[0] === "me") {
      scope = {};
      requireToken = true;
    } else if (segments.length === 2 && segments[0] === "org") {
      let org: string;
      try {
        org = decodeURIComponent(segments[1]!);
      } catch {
        org = " ";
      }
      // Grammar decided from request text alone — never a state consult, so
      // the refusal cannot leak existence.
      if (!isAuthzName(org)) return failure(404, "invalid_request", "not_found");
      scope = { org };
    } else {
      return failure(404, "invalid_request", "not_found");
    }

    let subject: string | null = trustedSession?.subject ?? null;
    let authView: AuthorizationView = trustedSession?.authView ?? emptyView();
    if (!identityFree && trustedSession === undefined) {
      const header = request.headers.get("authorization");
      try {
        if (header !== null && header.trim() !== "") {
          // A PRESENTED credential must verify (the exact E2-T03/E2-T05
          // refusal taxonomy — a revoked or unknown credential is 401, never
          // a silently-anonymous listing): membership visibility flows only
          // from a verified identity.
          const identity = await this.verifier.verifyAuthorization(header);
          subject = identity.sub;
          const context = await this.authzContext(header);
          authView = context.identity;
        } else if (requireToken) {
          // /registry/me with no token: E2-T03's exact 401.
          await this.verifier.verifyAuthorization(header);
        }
      } catch (error) {
        if (error instanceof TokenRevokedError) {
          return json(401, { error: { class: "token-revoked" } });
        }
        if (error instanceof UnauthorizedError) {
          return failure(401, "unauthorized", error.reason);
        }
        return failure(401, "unauthorized", "malformed_token");
      }
      if (requireToken && subject === null) {
        return failure(401, "unauthorized", "missing_bearer_token");
      }
      if (requireToken) scope = { ...scope, restrictOwn: subject! };
    }
    if (requireToken && trustedSession !== undefined) {
      scope = { ...scope, restrictOwn: trustedSession.subject };
    }

    try {
      const tenant = scope.org ?? (subject === null ? "public" : `subject:${subject}`);
      if (scope.org !== undefined && !decideTenantAccess(authView, subject, scope.org).allowed) {
        return failure(404, "invalid_request", "not_found");
      }
      this.admitRate(tenant, subject, "registry.query");
      const projection = url.searchParams.get("projection") === "1";
      if (projection) {
        if (!requireToken || subject === null) {
          return failure(400, "invalid_request", "invalid_projection");
        }
        try {
          requireReducer(url.searchParams.get("reducer") ?? "", "__registry__");
        } catch {
          return failure(400, "invalid_request", "invalid_reducer");
        }
        const liveProjection = url.searchParams.get("live");
        if (liveProjection === null) {
          return registryApplicationProjectionResponse(this.streams, authView, subject, scope);
        }
        if (liveProjection !== "1") {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        const checkpointRaw = url.searchParams.get("checkpoint") ?? "-1";
        if (!isWellFormedOffset(checkpointRaw)) {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_FOLLOW_WAIT_MS) {
          return failure(400, "invalid_request", "invalid_follow_parameters");
        }
        return registryApplicationProjectionResponse(
          this.streams,
          authView,
          subject,
          scope,
          checkpointRaw,
          waitMs,
        );
      }
      const live = url.searchParams.get("live");
      if (live === null) {
        return registrySnapshotResponse(this.streams, authView, subject, scope);
      }
      const afterRaw = url.searchParams.get("after") ?? "-1";
      if (afterRaw !== "-1" && !isWellFormedOffset(afterRaw)) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const after = afterRaw as Offset | "-1";
      if (live === "sse") {
        return registrySseResponse(this.streams, authView, subject, scope, after);
      }
      if (live !== "long-poll") {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_FOLLOW_WAIT_MS) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      return registryLongPollResponse(this.streams, authView, subject, scope, after, waitMs);
    } catch (error) {
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
  }

  /**
   * `GET /api/repos/<org>/<repo>/<branch>/events[?live=1&after=N&waitMs=M]`
   * — the authorized application read (and long-poll live follow) of a
   * repo/branch stream. The same decision function gates it before any
   * official-stream access to the target.
   */
  private async repoRoute(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") {
      return failure(405, "invalid_request", "method_not_allowed");
    }
    const segments = url.pathname.split("/").slice(2);
    if (segments.length !== 5 || segments[4] !== "events" || segments.some((s) => s === "")) {
      return failure(404, "invalid_request", "not_found");
    }
    let decoded: string[];
    try {
      decoded = segments.slice(1, 4).map((segment) => decodeURIComponent(segment));
    } catch {
      decoded = [" ", " ", " "];
    }
    const target = repoTargetFromPath(decoded[0]!, decoded[1]!, decoded[2]!);
    const live = url.searchParams.get("live") === "1";
    const operation = live ? "follow" : "read";

    let decision: AuthzDecision;
    try {
      decision = await this.decideRepo(operation, target, request.headers.get("authorization"));
    } catch (error) {
      if (error instanceof TokenRevokedError) {
        return json(401, { error: { class: "token-revoked" } });
      }
      if (error instanceof UnauthorizedError) {
        return failure(401, "unauthorized", error.reason);
      }
      if (error instanceof AuthzViewUnavailableError) {
        return failure(503, "dispatch_failed", "authz_view_unavailable");
      }
      if (error instanceof RateLimitExceededError) return rateLimitResponse(error.decision);
      throw error;
    }
    if (!decision.allowed) return authzRefusalResponse(decision);

    const projection = url.searchParams.get("projection") === "1";
    const reducerId = url.searchParams.get("reducer") ?? "";
    let reducer: ReturnType<typeof requireReducer> | undefined;
    if (projection) {
      try {
        reducer = requireReducer(reducerId, decision.streamId);
      } catch {
        return failure(400, "invalid_request", "invalid_reducer");
      }
    }

    if (!live) {
      if (projection) {
        try {
          const batch = await this.bootstrapProjection(decision.streamId);
          validateProjectionReducer(reducer!, batch.events);
          return json(200, {
            ok: true,
            events: batch.events,
            checkpoint: batch.checkpoint.offset,
            reducer: { id: reducer!.id, version: reducer!.version },
            identityOffset: decision.identityOffset,
            basis: decision.basis,
          });
        } catch (error) {
          if (error instanceof ApplicationProjectionError) {
            return json(422, {
              error: {
                class: "malformed_application_event",
                offset: error.offset,
                reason: error.message,
              },
            });
          }
          throw error;
        }
      }
      const events = await this.readTarget(decision.streamId);
      return json(200, {
        ok: true,
        events,
        count: events.length,
        identityOffset: decision.identityOffset,
        basis: decision.basis,
      });
    }

    if (projection) {
      const from = url.searchParams.get("checkpoint");
      const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
      if (
        !isWellFormedOffset(from) ||
        !Number.isSafeInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > MAX_FOLLOW_WAIT_MS
      ) {
        return failure(400, "invalid_request", "invalid_follow_parameters");
      }
      try {
        const batch = await this.followProjection(
          decision.streamId,
          applicationCheckpoint(from),
          waitMs,
        );
        return json(200, {
          ok: true,
          events: batch.events,
          checkpoint: batch.checkpoint.offset,
          reducer: { id: reducer!.id, version: reducer!.version },
          identityOffset: decision.identityOffset,
          basis: decision.basis,
        });
      } catch (error) {
        if (error instanceof ApplicationProjectionError) {
          return json(422, {
            error: {
              class: "malformed_application_event",
              offset: error.offset,
              reason: error.message,
            },
          });
        }
        throw error;
      }
    }

    const after = Number(url.searchParams.get("after") ?? "0");
    const waitMs = Number(url.searchParams.get("waitMs") ?? String(DEFAULT_FOLLOW_WAIT_MS));
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > MAX_FOLLOW_WAIT_MS
    ) {
      return failure(400, "invalid_request", "invalid_follow_parameters");
    }
    const events = await this.followTarget(decision.streamId, after, waitMs);
    return json(200, {
      ok: true,
      events,
      after: after + events.length,
      identityOffset: decision.identityOffset,
      basis: decision.basis,
    });
  }

  private async readTarget(streamId: string): Promise<readonly unknown[]> {
    try {
      return await this.streams.read(streamId);
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }

  private async bootstrapProjection(streamId: string): Promise<StreamBatch> {
    try {
      if (this.streams.applicationBootstrap !== undefined) {
        const batch = await this.streams.applicationBootstrap(streamId);
        const events = projectionRecords(batch.events, OFFSET_BEFORE_FIRST);
        const expected = events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
        if (batch.checkpoint.offset !== expected) {
          throw new ApplicationProjectionError(
            batch.checkpoint.offset,
            "bootstrap checkpoint does not match final event",
          );
        }
        return { events, checkpoint: applicationCheckpoint(expected) };
      }
      const events = projectionRecords(await this.readTarget(streamId), OFFSET_BEFORE_FIRST);
      return {
        events,
        checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST),
      };
    } catch (error) {
      if (isDurableNotFound(error)) {
        return { events: [], checkpoint: applicationCheckpoint(OFFSET_BEFORE_FIRST) };
      }
      throw error;
    }
  }

  private async followProjection(
    streamId: string,
    from: StreamCheckpoint,
    waitMs: number,
  ): Promise<StreamBatch> {
    const signal = AbortSignal.timeout(waitMs);
    try {
      if (this.streams.applicationFollow !== undefined) {
        for await (const batch of this.streams.applicationFollow(streamId, from, signal)) {
          const events = projectionRecords(batch.events, from.offset);
          const expected = events.at(-1)?.offset ?? from.offset;
          if (batch.checkpoint.offset !== expected) {
            throw new ApplicationProjectionError(
              batch.checkpoint.offset,
              "follow checkpoint does not match final event",
            );
          }
          return { events, checkpoint: applicationCheckpoint(expected) };
        }
        return { events: [], checkpoint: from };
      }
      const items: unknown[] = [];
      for await (const item of this.streams.follow(streamId, signal)) items.push(item);
      const all = projectionRecords(items, OFFSET_BEFORE_FIRST);
      const events = all.filter((event) => compareOffsets(event.offset, from.offset) > 0);
      return {
        events,
        checkpoint: applicationCheckpoint(events.at(-1)?.offset ?? from.offset),
      };
    } catch (error) {
      if (isDurableNotFound(error)) return { events: [], checkpoint: from };
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return { events: [], checkpoint: from };
      }
      throw error;
    }
  }

  /** Long-poll: the first item past `after`, or empty after `waitMs`. */
  private async followTarget(
    streamId: string,
    after: number,
    waitMs: number,
  ): Promise<readonly unknown[]> {
    const signal = AbortSignal.timeout(waitMs);
    const items: unknown[] = [];
    let index = 0;
    try {
      for await (const item of this.streams.follow(streamId, signal)) {
        index += 1;
        if (index <= after) continue;
        items.push(item);
        break;
      }
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return items;
      }
      throw error;
    }
    return items;
  }
}

export function createPlatformHandler(
  options: PlatformGatewayOptions,
): (request: Request) => Promise<Response> {
  const gateway = new PlatformGateway(options);
  return (request) => gateway.handle(request);
}
