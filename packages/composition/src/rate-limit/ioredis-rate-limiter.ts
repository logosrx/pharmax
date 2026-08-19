// Distributed rate limiter over ioredis (ADR-0030).
//
// Implements `@pharmax/auth`'s `RateLimiter` port with a server-side
// atomic fixed-window counter. The composition layer owns the `ioredis`
// dependency + connection lifecycle (same as the cache wiring), so the
// engine stays leaf and provider-agnostic.
//
// Atomicity: a single Lua `EVAL` does `INCR` + (on the first hit)
// `PEXPIRE` + `PTTL`. Because it runs server-side in one round-trip,
// concurrent requests across web instances can't both slip past the
// limit, and the key can never be left without an expiry (the failure
// mode of a two-command INCR-then-EXPIRE where the process dies between
// them).
//
// Availability posture: DEGRADE, NOT DISABLE — see ADR-0030 §"Amendment
// 2026-08-18". A Redis outage must not lock every operator out, so this
// never fails closed; it no longer fails fully open either.
//
// Worth knowing how the previous behaviour survived review: this file
// returned `allowed: true` on transport error and attributed that to
// ADR-0030, but the ADR contained no such decision — its only
// availability reasoning was about the read-through cache degrading to a
// DB read. A citation to a decision that did not exist read like a
// reviewed trade-off for two months. The amendment now states the posture
// so the reference is true and the choice is reviewable.
//
// The original reasoning was half right: a durable per-email lockout in
// `login_attempt` really is the backstop for sustained attacks, and it
// has no Redis dependency.
//
// That reasoning is sound and still holds, but it only covers half the
// surface. `signIn` enforces TWO keys — `signin:ip:<ip>` and
// `signin:email:<email>` — and the DB lockout replaces only the email
// half, because it counts failures per email. With Redis down and a
// blanket allow, per-IP throttling disappeared entirely: one source could
// spray attempts across many accounts unthrottled. Each individual
// account stayed protected, so this was never single-account brute force
// — it was free credential spraying and user enumeration.
//
// So the error path now delegates to a process-local `InMemoryRateLimiter`
// instead of returning `allowed: true`. That is weaker than the
// distributed limiter (each web task counts independently, so the
// effective limit multiplies by instance count) and strictly stronger
// than nothing. It preserves the property ADR-0030 actually cared about:
// no global lockout when Redis is unavailable.
//
// The fallback is bounded — `InMemoryRateLimiter` caps at `maxKeys` and
// sweeps — so a spray across many keys cannot turn a Redis outage into a
// memory exhaustion incident.

import {
  InMemoryRateLimiter,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from "@pharmax/auth";
import type { logger as loggerTypes } from "@pharmax/platform-core";
import { Redis, type RedisOptions } from "ioredis";

type Logger = loggerTypes.Logger;

// KEYS[1] = counter key, ARGV[1] = window in ms.
// Returns { current count, remaining ttl in ms }.
const FIXED_WINDOW_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { c, redis.call('PTTL', KEYS[1]) }
`;

/** Narrow ioredis surface used here — structurally satisfied by `Redis`. */
export interface IoredisEvalLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisRateLimiter implements RateLimiter {
  /**
   * Degraded-path limiter, used only when Redis errors. Constructed
   * eagerly and shared for the process lifetime so its counters survive
   * across a flapping connection — a per-call instance would reset the
   * window on every failure and throttle nothing.
   */
  private readonly fallback: RateLimiter;

  public constructor(
    private readonly redis: IoredisEvalLike,
    private readonly logger?: Logger,
    fallback: RateLimiter = new InMemoryRateLimiter()
  ) {
    this.fallback = fallback;
  }

  public async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    try {
      const raw = (await this.redis.eval(FIXED_WINDOW_SCRIPT, 1, key, rule.windowMs)) as [
        number | string,
        number | string,
      ];
      const count = Number(raw[0]);
      const ttl = Number(raw[1]);
      const allowed = count <= rule.limit;
      return {
        allowed,
        retryAfterMs: allowed ? 0 : ttl > 0 ? ttl : rule.windowMs,
      };
    } catch (error) {
      // Degrade to process-local counting rather than allowing outright.
      // See the availability-posture note at the top of this file.
      this.logger?.warn("auth.rate_limit.redis_error_degraded", {
        errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      });
      return this.fallback.hit(key, rule);
    }
  }
}

/**
 * Connection options minus `replyMapping`.
 *
 * ## Why this type exists — an upstream incompatibility, not a local one
 *
 * ioredis 6 added `replyMapping` and declared it inconsistently with its
 * own constructor. The exported `RedisOptions` has
 * `replyMapping?: ReplyMappingMode | undefined`, while the constructor
 * overload requires `{ replyMapping?: ReplyMappingMode }` — no
 * `| undefined`. Under `exactOptionalPropertyTypes: true` those are not
 * the same type, so **ioredis's own `RedisOptions` is not assignable to
 * ioredis's own constructor**:
 *
 * ```text
 * Argument of type 'RedisOptions' is not assignable to parameter of type
 * 'CommonRedisOptions & … & { replyMapping?: ReplyMappingMode; }'
 *   Type 'ReplyMappingMode | undefined' is not assignable to
 *   type 'ReplyMappingMode'.
 * ```
 *
 * That is why the v6 bump failed `Typecheck` in CI (PR #188). It is not
 * fixable by rearranging the call site: any value typed `RedisOptions`
 * fails, and any spread of one widens the optionals the same way.
 *
 * Omitting the key is the narrowest workaround available. Pharmax never
 * sets `replyMapping` — it selects ioredis's RESP reply shape, and the
 * default is what the codebase already assumes — so an absent property
 * satisfies the optional parameter and nothing is lost. `Omit` rather
 * than a cast, so if a future ioredis declares more properties this way,
 * the compiler says so instead of a blanket assertion hiding it.
 *
 * Remove this indirection once upstream aligns the two declarations.
 */
export type RedisConnectionOptions = Omit<RedisOptions, "replyMapping">;

/**
 * Merge caller overrides onto the shared connection defaults.
 *
 * One helper for both this module and the cache client, so the two
 * cannot drift apart on retry and ready-check behaviour.
 */
export function mergeRedisOptions(
  overrides: RedisConnectionOptions | undefined
): RedisConnectionOptions {
  // Fail commands fast on a wedged connection rather than queueing them
  // unbounded.
  const defaults: RedisConnectionOptions = { maxRetriesPerRequest: 3, enableReadyCheck: true };
  return overrides === undefined ? defaults : { ...defaults, ...overrides };
}

export interface RateLimiterHandle {
  readonly rateLimiter: RateLimiter;
  close(): Promise<void>;
}

export interface CreateRateLimiterFromEnvInput {
  readonly redisUrl?: string | undefined;
  readonly logger?: Logger;
  readonly redisOptions?: RedisConnectionOptions;
}

/**
 * Redis-backed distributed limiter when `REDIS_URL` is set; otherwise an
 * in-process limiter (single-instance-correct, best-effort across
 * instances). `close()` is a no-op for the in-memory branch.
 */
export function createRateLimiterFromEnv(input: CreateRateLimiterFromEnvInput): RateLimiterHandle {
  if (typeof input.redisUrl === "string" && input.redisUrl.length > 0) {
    const redis = new Redis(input.redisUrl, mergeRedisOptions(input.redisOptions));
    if (input.logger !== undefined) {
      redis.on("error", (error: Error) => {
        input.logger?.warn("auth.rate_limit.redis_connection_error", {
          errorMessage: `${error.name}: ${error.message}`,
        });
      });
    }
    return {
      rateLimiter: new RedisRateLimiter(redis as unknown as IoredisEvalLike, input.logger),
      async close(): Promise<void> {
        await redis.quit();
      },
    };
  }
  return {
    rateLimiter: new InMemoryRateLimiter(),
    async close(): Promise<void> {
      // Nothing to close for the in-process limiter.
    },
  };
}
