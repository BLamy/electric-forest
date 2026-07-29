export type RateLimitOperation =
  | "namespace.lookup"
  | "application.read"
  | "application.follow"
  | "application.dispatch"
  | "registry.query"
  | "cli-token.issue";

export interface RateLimitKey {
  /** Canonical organization name, or one of the documented non-org scopes. */
  readonly tenant: string;
  /** Verified Auth0 subject, or the literal `anonymous`. */
  readonly subject: string;
  readonly operation: RateLimitOperation;
}

export interface FixedWindowRateLimitOptions {
  readonly max: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export interface RateLimitAllowance {
  readonly allowed: true;
  readonly key: RateLimitKey;
  readonly limit: number;
  readonly remaining: number;
  readonly windowStartedAt: number;
  readonly windowResetAt: number;
}

export interface RateLimitRefusal {
  readonly allowed: false;
  readonly key: RateLimitKey;
  readonly limit: number;
  readonly remaining: 0;
  readonly retryAfterMs: number;
  readonly windowStartedAt: number;
  readonly windowResetAt: number;
}

export type RateLimitDecision = RateLimitAllowance | RateLimitRefusal;

interface WindowCounter {
  readonly startedAt: number;
  count: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function segment(value: string, name: string): string {
  if (value.length === 0 || value.includes("\u0000")) {
    throw new TypeError(`${name} must be a non-empty counter segment`);
  }
  return value;
}

export function rateLimitKey(input: RateLimitKey): string {
  return JSON.stringify([
    segment(input.tenant, "tenant"),
    segment(input.subject, "subject"),
    input.operation,
  ]);
}

/**
 * Pure-process fixed-window accounting. `consume` contains no await point, so
 * concurrent request continuations cannot observe or update a counter between
 * its read and write. The injected clock is sampled exactly once per decision.
 */
export class FixedWindowRateLimiter {
  readonly max: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly counters = new Map<string, WindowCounter>();

  constructor(options: FixedWindowRateLimitOptions) {
    this.max = positiveSafeInteger(options.max, "max");
    this.windowMs = positiveSafeInteger(options.windowMs, "windowMs");
    this.now = options.now ?? Date.now;
  }

  consume(key: RateLimitKey): RateLimitDecision {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("rate-limit clock must return a non-negative safe integer");
    }
    const encoded = rateLimitKey(key);
    let counter = this.counters.get(encoded);
    if (counter === undefined || now >= counter.startedAt + this.windowMs) {
      counter = { startedAt: now, count: 0 };
      this.counters.set(encoded, counter);
    }
    const windowResetAt = counter.startedAt + this.windowMs;
    if (counter.count >= this.max) {
      return {
        allowed: false,
        key,
        limit: this.max,
        remaining: 0,
        retryAfterMs: Math.max(0, windowResetAt - now),
        windowStartedAt: counter.startedAt,
        windowResetAt,
      };
    }
    counter.count += 1;
    return {
      allowed: true,
      key,
      limit: this.max,
      remaining: this.max - counter.count,
      windowStartedAt: counter.startedAt,
      windowResetAt,
    };
  }

  count(key: RateLimitKey): number {
    const counter = this.counters.get(rateLimitKey(key));
    if (counter === undefined) return 0;
    const now = this.now();
    return now >= counter.startedAt + this.windowMs ? 0 : counter.count;
  }
}

export class RateLimitExceededError extends Error {
  readonly decision: RateLimitRefusal;

  constructor(decision: RateLimitRefusal) {
    super("fixed-window rate limit exhausted");
    this.name = "RateLimitExceededError";
    this.decision = decision;
  }
}

export const DEFAULT_PLATFORM_RATE_LIMIT = {
  max: 1_000,
  windowMs: 60_000,
} as const;

export function rateLimitResponse(decision: RateLimitRefusal): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        reason: "fixed_window_exhausted",
        operation: decision.key.operation,
        limit: decision.limit,
        retryAfterMs: decision.retryAfterMs,
        windowResetAt: decision.windowResetAt,
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.ceil(decision.retryAfterMs / 1_000)),
      },
    },
  );
}
