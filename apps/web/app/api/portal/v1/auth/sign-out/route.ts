// POST /api/portal/v1/auth/sign-out — revoke the current portal
// session + clear the portal cookie (ADR-0033, slice 2).
//
// Public route: an expired/invalid session hitting this is a no-op
// that still clears the cookie. Revocation is immediate (stateful
// sessions).

import { revokePortalSessionByToken } from "@pharmax/providers";
import { NextResponse, type NextRequest } from "next/server";

import {
  clearPortalSessionCookie,
  readPortalSessionTokenFromRequest,
} from "@/server/portal/session-cookie";

export async function POST(request: NextRequest): Promise<Response> {
  const token = readPortalSessionTokenFromRequest(request);
  const response = NextResponse.json({ ok: true });
  clearPortalSessionCookie(response);
  if (token !== null) {
    try {
      await revokePortalSessionByToken({ rawToken: token, reason: "USER_LOGOUT" });
    } catch {
      // Best-effort: the cookie is already cleared; a revoke failure
      // (e.g. DB blip) must not block local sign-out.
    }
  }
  return response;
}
