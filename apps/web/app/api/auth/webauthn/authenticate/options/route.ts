// POST /api/auth/webauthn/authenticate/options — mint a WebAuthn
// assertion challenge at sign-in (ADR-0036).
//
// Public route (under the /api/auth allowlist in proxy.ts) — it runs
// BEFORE a session exists. Password-gated inside the engine: the
// options (which name the user's credential ids) are only returned
// after the first factor verifies, and the wrapper applies the same
// rate-limit + lockout + login-ledger protections as sign-in itself.
//
// The client completes `navigator.credentials.get()` with these
// options and re-submits POST /api/auth/sign-in with the assertion.

import { startWebAuthnSignIn } from "@pharmax/auth";
import { errors } from "@pharmax/platform-core";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { resolveOrganizationIdFromHost } from "@/server/auth/resolve-org-from-host";
import { resolveWebAuthnRp } from "@/server/auth/webauthn-rp";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const organizationId = await resolveOrganizationIdFromHost(host);
  const rp = resolveWebAuthnRp(request);
  if (organizationId === null || rp === null) {
    return NextResponse.json(
      { error: "Unknown organization. Use your organization's sign-in URL." },
      { status: 400 }
    );
  }

  try {
    const result = await startWebAuthnSignIn({
      organizationId,
      email: parsed.data.email,
      password: parsed.data.password,
      rpId: rp.rpId,
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json({
      ok: true,
      challengeId: result.challengeId,
      options: result.optionsJSON,
    });
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      return NextResponse.json(
        { error: cause.message, code: cause.code },
        { status: cause.httpStatus }
      );
    }
    throw cause;
  }
}
