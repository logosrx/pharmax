// POST /api/portal/v1/auth/sign-in — provider portal sign-in
// (ADR-0033, slice 2). The portal twin of /api/auth/sign-in.
//
// Thin transport: resolve the org from the sign-in subdomain, delegate
// to `portalSignIn()` (burst limits → lockout gate → PortalSignIn
// command → login_attempt ledger), and on success set the PORTAL
// session cookie (a distinct cookie from the operator one — the two
// bearer surfaces never mix). Public route (allowlisted in proxy.ts).

import { errors } from "@pharmax/platform-core";
import { portalSignIn } from "@pharmax/providers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { resolveOrganizationIdFromHost } from "@/server/auth/resolve-org-from-host";
import { setPortalSessionCookie } from "@/server/portal/session-cookie";

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
  if (organizationId === null) {
    return NextResponse.json(
      { error: "Unknown organization. Use your organization's portal URL." },
      { status: 400 }
    );
  }

  try {
    const result = await portalSignIn({
      organizationId,
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = NextResponse.json({
      ok: true,
      portalAccountId: result.portalAccountId,
      // Null means the prescriber writes for several client practices
      // and the session is not scoped to one yet. The client id itself
      // is deliberately NOT returned: the browser has no use for it,
      // and the scope that matters lives on the session row.
      requiresClientSelection: result.activeClinicId === null,
    });
    setPortalSessionCookie(response, result.rawToken);
    return response;
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
