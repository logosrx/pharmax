// POST /api/auth/sign-in — in-house identity engine sign-in (ADR-0030).
//
// Thin transport: resolve the org from the sign-in subdomain, delegate
// to `signIn()` (lockout gate → SignIn command → login_attempt ledger),
// and on success set the opaque session cookie. All auth logic lives in
// @pharmax/auth; this route only maps HTTP ⇄ the engine.
//
// Public route (allowlisted in proxy.ts) — it is how a session is
// obtained in the first place.

import { signIn } from "@pharmax/auth";
import { errors } from "@pharmax/platform-core";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { resolveOrganizationIdFromHost } from "@/server/auth/resolve-org-from-host";
import { resolveWebAuthnRp } from "@/server/auth/webauthn-rp";
import { setSessionCookie } from "@/server/auth/session-cookie";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().min(1).max(64).optional(),
  /**
   * WebAuthn assertion (ADR-0036): the challenge minted by
   * /api/auth/webauthn/authenticate/options plus the browser's
   * `startAuthentication()` response. rpId/origin are derived
   * server-side from the trusted host — never from this body.
   */
  webauthn: z
    .object({
      challengeId: z.string().uuid(),
      response: z.unknown(),
    })
    .optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const organizationId = await resolveOrganizationIdFromHost(host);
  if (organizationId === null) {
    return NextResponse.json(
      { error: "Unknown organization. Use your organization's sign-in URL." },
      { status: 400 }
    );
  }

  const rp = resolveWebAuthnRp(request);
  if (parsed.data.webauthn !== undefined && rp === null) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const result = await signIn({
      organizationId,
      email: parsed.data.email,
      password: parsed.data.password,
      ...(parsed.data.mfaCode !== undefined ? { mfaCode: parsed.data.mfaCode } : {}),
      ...(parsed.data.webauthn !== undefined && rp !== null
        ? {
            webauthn: {
              challengeId: parsed.data.webauthn.challengeId,
              rpId: rp.rpId,
              origin: rp.origin,
              response: parsed.data.webauthn.response,
            },
          }
        : {}),
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = NextResponse.json({ ok: true, userId: result.userId });
    setSessionCookie(response, result.rawToken);
    return response;
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      // `code` lets the form route the UI (MFA_REQUIRED → prompt for a
      // code or security key; INVALID_CREDENTIALS → generic error).
      // `methods` is only present AFTER the password verified, so it
      // discloses nothing to an unauthenticated caller.
      const methods = cause.code === "MFA_REQUIRED" ? cause.metadata["methods"] : undefined;
      return NextResponse.json(
        {
          error: cause.message,
          code: cause.code,
          ...(Array.isArray(methods) ? { methods } : {}),
        },
        { status: cause.httpStatus }
      );
    }
    throw cause;
  }
}
