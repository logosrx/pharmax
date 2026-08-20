// POST /api/portal/v1/auth/setup — consume a one-time portal setup
// token and set the initial password (ADR-0033, slice 2). The portal
// twin of /api/auth/accept-invite.
//
// Public route by necessity (the caller holds only the emailed
// token). Defense in depth:
//   - per-IP burst limit BEFORE the command, so the token space
//     can't be probed and Argon2id can't be used as a CPU oracle;
//   - the command replies with one opaque PORTAL_SETUP_TOKEN_INVALID
//     for every not-consumable case (missing, expired, used, account
//     no longer PENDING_SETUP) — no enumeration;
//   - password-policy violations DO surface field-level detail
//     (the caller has proven token possession at that point).
//
// It does NOT set a session cookie — the prescriber signs in
// normally afterwards, so the sign-in path stays the single place
// sessions are minted.

import { errors } from "@pharmax/platform-core";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { setupPortalAccount } from "@pharmax/providers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/server/env";
import { resolveClientIp } from "@/server/http/client-ip";
import { logger } from "@/server/logger";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "portal-setup-rate-limit" }),
});

const PER_IP_RULE = { limit: 10, windowMs: 60_000 };

const bodySchema = z
  .object({
    token: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

export async function POST(request: NextRequest): Promise<Response> {
  const ip = resolveClientIp(request) ?? "unknown";
  const hit = await rateLimiterHandle.rateLimiter.hit(`portal-setup:ip:${ip}`, PER_IP_RULE);
  if (!hit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Retry later." },
      { status: 429, headers: { "retry-after": String(Math.ceil(hit.retryAfterMs / 1000)) } }
    );
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const result = await setupPortalAccount({
      rawToken: parsed.data.token,
      newPassword: parsed.data.newPassword,
    });
    return NextResponse.json({ ok: true, portalAccountId: result.portalAccountId });
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      return NextResponse.json(
        { error: cause.message, code: cause.code, ...metadataOf(cause) },
        { status: cause.httpStatus }
      );
    }
    throw cause;
  }
}

/** Surface password-policy violation details (and nothing else). */
function metadataOf(cause: errors.PharmaxError): { violations?: unknown } {
  const violations = cause.metadata["violations"];
  return violations === undefined ? {} : { violations };
}
