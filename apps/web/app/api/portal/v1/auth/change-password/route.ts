// POST /api/portal/v1/auth/change-password — authenticated portal
// password rotation (ADR-0033, slice 3).
//
// Auth: the portal session cookie (resolved in-handler — the operator
// middleware gate is meaningless for portal principals). The account
// id comes from the RESOLVED SESSION, never from the request body.
//
// Defense in depth:
//   - per-account burst limit BEFORE the command, so a hijacked
//     session can't grind current-password guesses against Argon2id;
//   - the command itself re-verifies the CURRENT password — a stolen
//     cookie alone cannot rotate the credential;
//   - on success every OTHER portal session is revoked
//     (PASSWORD_CHANGED); the calling session survives.

import { errors } from "@pharmax/platform-core";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { changePortalPassword, resolvePortalSession } from "@pharmax/providers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { readPortalSessionTokenFromRequest } from "@/server/portal/session-cookie";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "portal-change-password-rate-limit" }),
});

// Tighter than sign-in: a legitimate user changes a password once,
// not five times a minute.
const PER_ACCOUNT_RULE = { limit: 5, windowMs: 60_000 };

const bodySchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

export async function POST(request: NextRequest): Promise<Response> {
  const rawToken = readPortalSessionTokenFromRequest(request);
  if (rawToken === null) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const resolution = await resolvePortalSession({ rawToken });
  if (!resolution.ok) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const session = resolution.session;

  const hit = await rateLimiterHandle.rateLimiter.hit(
    `portal-change-password:account:${session.portalAccountId}`,
    PER_ACCOUNT_RULE
  );
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
    const result = await changePortalPassword({
      portalAccountId: session.portalAccountId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      exceptSessionId: session.sessionId,
    });
    return NextResponse.json({ ok: true, sessionsRevoked: result.sessionsRevoked });
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
