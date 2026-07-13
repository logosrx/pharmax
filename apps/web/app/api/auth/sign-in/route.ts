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
import { setSessionCookie } from "@/server/auth/session-cookie";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().min(1).max(64).optional(),
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

  try {
    const result = await signIn({
      organizationId,
      email: parsed.data.email,
      password: parsed.data.password,
      ...(parsed.data.mfaCode !== undefined ? { mfaCode: parsed.data.mfaCode } : {}),
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = NextResponse.json({ ok: true, userId: result.userId });
    setSessionCookie(response, result.rawToken);
    return response;
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      // `code` lets the form route the UI (MFA_REQUIRED → prompt for a
      // code; INVALID_CREDENTIALS → generic error).
      return NextResponse.json(
        { error: cause.message, code: cause.code },
        { status: cause.httpStatus }
      );
    }
    throw cause;
  }
}
