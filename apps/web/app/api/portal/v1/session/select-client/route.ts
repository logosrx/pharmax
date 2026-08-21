// POST /api/portal/v1/session/select-client — choose or change the
// client practice the current portal session acts for.
//
// Accepts a form POST (the chooser is a plain form, so it works without
// JS) and answers with a redirect. On success the portal session cookie
// is REPLACED: SwitchPortalClinic revokes the old session and mints a
// new one, so the old token is dead by the time this responds.
//
// Thin transport. The security decision — may this prescriber act for
// the submitted client — lives in the command, against the affiliation
// roster. `clinicId` arrives from a form field and is caller-controlled
// until the command proves it.

import { errors } from "@pharmax/platform-core";
import { executeSystemCommand } from "@pharmax/command-bus";
import { SwitchPortalClinic } from "@pharmax/providers";
import { withSystemContext } from "@pharmax/tenancy";
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentPortalIdentity } from "@/server/portal/current-session";
import { setPortalSessionCookie } from "@/server/portal/session-cookie";

const REASON = "portal:switch-client";

export async function POST(request: NextRequest): Promise<Response> {
  const identity = await getCurrentPortalIdentity();
  if (identity === null) {
    return NextResponse.redirect(new URL("/portal/sign-in", request.url), { status: 303 });
  }

  const form = await request.formData().catch(() => null);
  const clinicId = form?.get("clinicId");
  if (typeof clinicId !== "string" || clinicId.length === 0) {
    return NextResponse.redirect(new URL("/portal/select-client?error=invalid", request.url), {
      status: 303,
    });
  }

  try {
    const result = await withSystemContext(REASON, () =>
      executeSystemCommand(SwitchPortalClinic, {
        sessionId: identity.session.sessionId,
        organizationId: identity.session.organizationId,
        portalAccountId: identity.account.id,
        providerId: identity.provider.id,
        clinicId,
        ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
      })
    );

    const response = NextResponse.redirect(new URL("/portal", request.url), { status: 303 });
    setPortalSessionCookie(response, result.rawToken);
    return response;
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      // The chooser renders a generic message for this. Deliberately no
      // detail in the query string: whether a given client exists is
      // not something to confirm through a redirect parameter.
      return NextResponse.redirect(new URL("/portal/select-client?error=denied", request.url), {
        status: 303,
      });
    }
    throw cause;
  }
}
