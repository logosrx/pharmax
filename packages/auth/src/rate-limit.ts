// Rate limiting for authentication (ADR-0030).
//
// This is the SHORT-WINDOW burst limiter that sits IN FRONT of the
// durable, per-email DB lockout (`login_attempt` + countRecentFailures).
// The two are complementary:
//
//   - Rate limiter: fast, per-IP + per-email, ~1-minute window. Blunts
//     credential-stuffing bursts and protects the Argon2id KDF from
//     being used as a CPU-exhaustion oracle. Best backed by Redis so it
//     is DISTRIBUTED across web instances (the eonpro anti-pattern was
//     an in-memory counter that each instance evaluated independently).
//   - DB lockout: durable, per-email, ~15-minute window. Survives Redis
//     loss; the authoritative "this account is under attack" signal.
//
// The engine depends only on the `RateLimiter` PORT. The composition
// layer wires a Redis-backed adapter in production; the default is an
// in-process limiter (correct for a single instance, best-effort across
// instances) so a dev/single-node deployment still gets real protection.

export interface RateLimitRule {
  /** Max hits permitted within the window. */
  readonly limit: number;
  /** Rolling window length in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Milliseconds until the window resets (0 when allowed). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  /**
   * Record one hit against `key` and report whether it is within
   * `rule`. Adapters MUST make the increment atomic (a distributed
   * adapter uses a server-side INCR+PEXPIRE) so concurrent requests
   * cannot both slip past the limit.
   */
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
}

/** Disabled limiter — always allows. For tests / explicit opt-out. */
export const NOOP_RATE_LIMITER: RateLimiter = Object.freeze({
  async hit(): Promise<RateLimitResult> {
    return { allowed: true, retryAfterMs: 0 };
  },
});

/**
 * In-process fixed-window limiter. Correct for a single instance;
 * best-effort across instances (each process keeps its own counters).
 * Production should wire the Redis-backed adapter for a shared view.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;

  public constructor(
    private readonly now: () => number = () => Date.now(),
    options: { readonly maxKeys?: number } = {}
  ) {
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  public async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const t = this.now();
    const existing = this.buckets.get(key);

    if (existing === undefined || existing.resetAt <= t) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      this.buckets.set(key, { count: 1, resetAt: t + rule.windowMs });
      return { allowed: 1 <= rule.limit, retryAfterMs: 1 <= rule.limit ? 0 : rule.windowMs };
    }

    existing.count += 1;
    const allowed = existing.count <= rule.limit;
    return { allowed, retryAfterMs: allowed ? 0 : existing.resetAt - t };
  }

  /** Drop expired buckets to bound memory when the keyspace grows. */
  private sweep(t: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key);
    }
  }
}
