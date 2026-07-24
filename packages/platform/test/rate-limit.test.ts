import { describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  activeTenants,
  decideTenantAccess,
  rateLimitKey,
  rateLimitResponse,
  type RateLimitKey,
} from "../src/index.js";
import { emptyView, identityReducer, type AuthorizationView } from "@eforest/identity";

const KEY: RateLimitKey = {
  tenant: "acme",
  subject: "auth0|alice",
  operation: "application.read",
};

function tenantView(): AuthorizationView {
  let view = emptyView();
  view = identityReducer(view, {
    type: "identity.user.created",
    payload: { v: 1, sub: "auth0|alice", email: "alice@example.test" },
    ts: 1,
  });
  view = identityReducer(view, {
    type: "identity.user.created",
    payload: { v: 1, sub: "auth0|bob", email: "bob@example.test" },
    ts: 2,
  });
  view = identityReducer(view, {
    type: "identity.org.created",
    payload: { v: 1, orgId: "acme", name: "acme", ownerSub: "auth0|alice" },
    ts: 3,
  });
  view = identityReducer(view, {
    type: "identity.org.created",
    payload: { v: 1, orgId: "beta", name: "beta", ownerSub: "auth0|bob" },
    ts: 4,
  });
  return view;
}

describe("E2-T11 fixed-window rate limits and tenant isolation", () => {
  it("admits MAX, refuses MAX + 1 with exact metadata, and opens only at the next window", async () => {
    let now = 10_000;
    const limiter = new FixedWindowRateLimiter({ max: 3, windowMs: 1_000, now: () => now });
    const first = limiter.consume(KEY);
    const second = limiter.consume(KEY);
    const third = limiter.consume(KEY);
    const refused = limiter.consume(KEY);
    expect([first, second, third].every((decision) => decision.allowed)).toBe(true);
    expect(refused).toEqual({
      allowed: false,
      key: KEY,
      limit: 3,
      remaining: 0,
      retryAfterMs: 1_000,
      windowStartedAt: 10_000,
      windowResetAt: 11_000,
    });
    if (refused.allowed) throw new Error("expected refusal");
    expect(await rateLimitResponse(refused).json()).toEqual({
      error: {
        code: "rate_limited",
        reason: "fixed_window_exhausted",
        operation: "application.read",
        limit: 3,
        retryAfterMs: 1_000,
        windowResetAt: 11_000,
      },
    });
    now = 10_999;
    expect(limiter.consume(KEY).allowed).toBe(false);
    now = 11_000;
    expect(limiter.consume(KEY)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("serializes a concurrent boundary burst without exceeding MAX", async () => {
    const limiter = new FixedWindowRateLimiter({ max: 7, windowMs: 1_000, now: () => 20_000 });
    const decisions = await Promise.all(
      Array.from({ length: 40 }, async () => {
        await Promise.resolve();
        return limiter.consume(KEY);
      }),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(7);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(33);
    expect(limiter.count(KEY)).toBe(7);
  });

  it("keeps tenant, subject, anonymous, and operation counters disjoint", () => {
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1_000, now: () => 30_000 });
    const variants: RateLimitKey[] = [
      KEY,
      { ...KEY, tenant: "beta" },
      { ...KEY, subject: "auth0|bob" },
      { ...KEY, subject: "anonymous" },
      { ...KEY, operation: "application.follow" },
    ];
    expect(new Set(variants.map(rateLimitKey)).size).toBe(variants.length);
    expect(variants.map((key) => limiter.consume(key).allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(variants.map((key) => limiter.consume(key).allowed)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("refuses an identity bound to another tenant without binding anonymous or tenantless users", () => {
    const view = tenantView();
    expect(activeTenants(view, "auth0|alice")).toEqual(["acme"]);
    expect(decideTenantAccess(view, "auth0|alice", "acme").allowed).toBe(true);
    expect(decideTenantAccess(view, "auth0|alice", "beta").allowed).toBe(false);
    expect(decideTenantAccess(view, null, "beta").allowed).toBe(true);
    expect(decideTenantAccess(view, "auth0|unbound", "beta").allowed).toBe(true);
  });

  it("rejects invalid clocks and ambiguous key segments", () => {
    expect(() => new FixedWindowRateLimiter({ max: 0, windowMs: 1 })).toThrow(
      "max must be a positive safe integer",
    );
    expect(() =>
      new FixedWindowRateLimiter({ max: 1, windowMs: 1, now: () => -1 }).consume(KEY),
    ).toThrow("rate-limit clock must return a non-negative safe integer");
    expect(() => rateLimitKey({ ...KEY, subject: "bad\u0000subject" })).toThrow(
      "subject must be a non-empty counter segment",
    );
  });
});
