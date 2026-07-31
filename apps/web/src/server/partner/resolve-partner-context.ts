// Partner request context for /api/v1/* (ADR-0032).
//
// The single entry point for "which partner key is this, which org
// does it act in, and is it allowed to do what it's asking?". Flow:
//
//   1. Read `Authorization: Bearer pxk_...`. Malformed / absent ⇒ 401.
//   2. Per-key rate limit (Redis-backed when REDIS_URL is set,
//      in-process otherwise; fails open on limiter error).
//   3. `resolveApiKey` — system-context hash lookup. Not found /
//      revoked ⇒ 401 (indistinguishable to the caller by design).
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

import { resolveApiKey, type ResolvedApiKey } from "@pharmax/partner-api";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { prisma } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import { buildTenancyContext, type TenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { env } from "../env.js";
import { logger } from "../logger.js";

/** Rolling per-key limit for the whole v1 surface (ADR-0032 P0). */
const PARTNER_RATE_LIMIT = Object.freeze({ limit: 120, windowMs: 60_000 });

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

  const limit = await rateLimiterHandle.rateLimiter.hit(
    `partner-api:${resolved.key.apiKeyId}`,
    PARTNER_RATE_LIMIT
  );
  if (!limit.allowed) {
    return Object.freeze({
      ok: false,
      response: partnerJsonError({
        status: 429,
        code: "RATE_LIMITED",
        message: "Rate limit exceeded for this API key.",
        headers: { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) },
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
