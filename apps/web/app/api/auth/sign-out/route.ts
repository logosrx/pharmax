// POST /api/auth/sign-out — revoke the current session + clear the cookie.
//
// Public route: an expired/invalid session hitting this is a no-op that
// still clears the cookie. Revocation is immediate (stateful sessions).

import { revokeSessionByToken } from "@pharmax/auth";
import { NextResponse, type NextRequest } from "next/server";

import { clearSessionCookie, readSessionTokenFromRequest } from "@/server/auth/session-cookie";

export async function POST(request: NextRequest): Promise<Response> {
  const token = readSessionTokenFromRequest(request);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  if (token !== null) {
    try {
      await revokeSessionByToken({ rawToken: token, reason: "USER_LOGOUT" });
    } catch {
      // Best-effort: the cookie is already cleared; a revoke failure
      // (e.g. DB blip) must not block the user from signing out locally.
    }
  }
  return response;
}
