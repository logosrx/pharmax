// Partner request context for /api/v1/* (ADR-0032).
//
// The single entry point for "which partner key is this, which org
// does it act in, and is it allowed to do what it's asking?". Flow:
//
//   1. Read `Authorization: Bearer pxk_...`. Malformed / absent ⇒ 401.
//   2. `resolveApiKey` — system-context hash lookup. Not found /
//      revoked ⇒ 401 (indistinguishable to the caller by design).
//   3. Per-key quota-tier enforcement (Redis-backed when REDIS_URL is
//      set, in-process otherwise; fails open on limiter error). Two
//      windows per the key's tier (`getApiKeyQuota`):
//        - burst (per-minute) ⇒ 429 RATE_LIMITED — transient, back
//          off `Retry-After` seconds and continue;
//        - daily quota ⇒ 429 QUOTA_EXCEEDED — the integration is
//          over its tier; upgrade or wait for the window to reset.
//      The daily counter only counts requests that pass the burst
//      gate, so a spike being shaped doesn't also burn quota.
//   4. Build the org's `TenancyContext` with the key's minter as the
//      acting user; all downstream reads/dispatches run inside it.
//
// Scope semantics: reads are gated by the key's `scopes` array here;
// mutations are ADDITIONALLY gated by the acting user's live RBAC at
// the command bus (revoking the operator revokes the key's mutation
// authority with it).
//
// PHI invariant: no PHI is read. Logs carry key prefix + org id only.

import "server-only";

import { getApiKeyQuota, resolveApiKey, type ResolvedApiKey } from "@pharmax/partner-api";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { prisma } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, type TenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { env } from "../env.js";
import { logger } from "../logger.js";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "partner-api-rate-limit" }),
});

export function partnerJsonError(input: {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly headers?: Record<string, string>;
}): Response {
  return NextResponse.json(
    { error: { code: input.code, message: input.message } },
    { status: input.status, headers: input.headers ?? {} }
  );
}

export interface PartnerContext {
  readonly key: ResolvedApiKey;
  readonly tenancy: TenancyContext;
}

export type ResolvePartnerContextResult =
  | { readonly ok: true; readonly context: PartnerContext }
  | { readonly ok: false; readonly response: Response };

export async function resolvePartnerContext(
  request: Request
): Promise<ResolvePartnerContextResult> {
  const header = request.headers.get("authorization") ?? "";
  const rawToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (rawToken.length === 0) {
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Provide an API key via `Authorization: Bearer pxk_...`.",
      }),
    });
  }

  const resolved = await resolveApiKey({ rawToken, client: prisma });
  if (!resolved.ok) {
    // Malformed, unknown, and revoked all present identically —
    // never confirm to a caller that a revoked key WAS valid.
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Invalid API key.",
      }),
    });
  }

  const quota = getApiKeyQuota(resolved.key.quotaTier);

  const burst = await rateLimiterHandle.rateLimiter.hit(
    `partner-api:burst:${resolved.key.apiKeyId}`,
    quota.burst
  );
  if (!burst.allowed) {
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 429,
        code: "RATE_LIMITED",
        message: `Rate limit exceeded for this API key (${quota.burst.limit} requests/minute on the ${resolved.key.quotaTier} tier).`,
        headers: { "retry-after": String(Math.ceil(burst.retryAfterMs / 1000)) },
      }),
    });
  }

  // Only requests that pass the burst gate consume daily quota — a
  // spike being shaped shouldn't also burn the partner's allowance.
  const daily = await rateLimiterHandle.rateLimiter.hit(
    `partner-api:daily:${resolved.key.apiKeyId}`,
    quota.daily
  );
  if (!daily.allowed) {
    logger.warn("partner_api.quota_exceeded", {
      tokenPrefix: resolved.key.tokenPrefix,
      organizationId: resolved.key.organizationId,
      quotaTier: resolved.key.quotaTier,
    });
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 429,
        code: "QUOTA_EXCEEDED",
        message: `Daily quota exceeded for this API key (${quota.daily.limit} requests/day on the ${resolved.key.quotaTier} tier). Wait for the window to reset or contact the pharmacy to raise the tier.`,
        headers: { "retry-after": String(Math.ceil(daily.retryAfterMs / 1000)) },
      }),
    });
  }

  const tenancy = buildTenancyContext({
    organizationId: resolved.key.organizationId,
    actor: { userId: resolved.key.createdByUserId, correlationId: ids.generateUlid() },
  });

  return Object.freeze({
    ok: true,
    context: Object.freeze({ key: resolved.key, tenancy }),
  });
}

/**
 * Gate a v1 handler on a key scope. Returns `null` when allowed, or
 * the 403 response to send. Mutations get a SECOND gate at the bus
 * (the acting user's RBAC) — this is the key-level one.
 */
export function requirePartnerScope(context: PartnerContext, scope: string): Response | null {
  if (context.key.scopes.includes(scope)) {
    return null;
  }
  logger.warn("partner_api.scope_denied", {
    tokenPrefix: context.key.tokenPrefix,
    organizationId: context.key.organizationId,
    scope,
  });
  return partnerJsonError({
    status: 403,
    code: "SCOPE_DENIED",
    message: `This API key does not carry the "${scope}" scope.`,
  });
}

/**
 * Message substituted for a 5xx. `InternalError` messages name the
 * subsystem that failed and sometimes quote the underlying driver
 * error; the class contract forbids echoing them to a client.
 */
const INTERNAL_ERROR_MESSAGE =
  "Pharmax could not complete this request. This is a fault on our side, not a defect in " +
  "your payload. Retrying with the same Idempotency-Key is safe: it either performs the " +
  "operation or returns the original result.";

/**
 * Map a command rejection onto the v1 error contract. Returns the
 * response to send, or `null` when the throw was not a `PharmaxError`
 * and the caller should rethrow it.
 *
 * The status comes from the error CLASS, never from the code string.
 * Every class in `@pharmax/platform-core` already declares the status
 * it means (`ValidationError` 400, `AuthorizationError` 403,
 * `NotFoundError` 404, `ConflictError` 409, `InvariantViolationError`
 * 422, `InternalError` 500), so honouring `httpStatus` is what keeps
 * one taxonomy instead of a per-route opinion.
 *
 * Flattening everything to 422 — which every v1 mutation route did
 * until this helper existed — got two things wrong that matter:
 *
 *   - It told partners a TRANSIENT failure was a defective request.
 *     `RX_NUMBER_COLLISION` and an optimistic-lock miss are
 *     `ConflictError`s that the caller should retry, and no client
 *     library retries a 422.
 *   - It reported OUR outages as their fault.
 *     `RX_NUMBER_ALLOCATION_FAILED`, `CREATE_ORDER_NO_POLICY` and
 *     `ORDER_INTAKE_BUCKET_NOT_CONFIGURED` are `InternalError`s. As
 *     422s they were invisible to error-rate alerting, so the one
 *     failure class that should page was the one class that could
 *     not.
 *
 * Hence the split here: `category === "unexpected"` is logged at
 * ERROR (which bridges to Sentry) and answered with a generic
 * message; expected rejections pass their own message through, since
 * those are written for the caller and are the whole point of a
 * typed code.
 */
export function partnerCommandError(cause: unknown): Response | null {
  if (!(cause instanceof errors.PharmaxError)) return null;

  if (cause.category === "unexpected") {
    logger.error("partner_api.command_internal_error", { code: cause.code, error: cause });
    return partnerJsonError({
      status: cause.httpStatus,
      code: cause.code,
      message: INTERNAL_ERROR_MESSAGE,
    });
  }

  return partnerJsonError({
    status: cause.httpStatus,
    code: cause.code,
    message: cause.message,
  });
}

/**
 * v1 mutation contract: the caller supplies an `Idempotency-Key`
 * header (ADR-0032). Returns the key or the 400 response to send.
 */
export function requireIdempotencyKeyHeader(
  request: Request
):
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly response: Response } {
  const raw = (request.headers.get("idempotency-key") ?? "").trim();
  if (raw.length < 8 || raw.length > 200) {
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 400,
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Mutations require an `Idempotency-Key` header (8-200 characters).",
      }),
    });
  }
  return Object.freeze({ ok: true, key: raw });
}
