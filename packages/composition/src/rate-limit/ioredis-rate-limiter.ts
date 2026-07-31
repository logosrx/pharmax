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
// Availability posture: FAIL OPEN. A Redis outage must not lock every
// operator out — the durable per-email DB lockout (`login_attempt`) is
// the backstop for sustained attacks. A transport error is logged and
// treated as "allowed".

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
  public constructor(
    private readonly redis: IoredisEvalLike,
    private readonly logger?: Logger
  ) {}

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
      // Fail open — the DB lockout is the durable backstop.
      this.logger?.warn("auth.rate_limit.redis_error", {
        errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      });
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}

export interface RateLimiterHandle {
  readonly rateLimiter: RateLimiter;
  close(): Promise<void>;
}

export interface CreateRateLimiterFromEnvInput {
  readonly redisUrl?: string | undefined;
  readonly logger?: Logger;
  readonly redisOptions?: RedisOptions;
}

/**
 * Redis-backed distributed limiter when `REDIS_URL` is set; otherwise an
 * in-process limiter (single-instance-correct, best-effort across
 * instances). `close()` is a no-op for the in-memory branch.
 */
export function createRateLimiterFromEnv(input: CreateRateLimiterFromEnvInput): RateLimiterHandle {
  if (typeof input.redisUrl === "string" && input.redisUrl.length > 0) {
    const redis = new Redis(input.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      ...input.redisOptions,
    });
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
