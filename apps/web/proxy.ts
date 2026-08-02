// Next.js routing middleware (`proxy.ts`). Runs on every request the
// matcher accepts. In-house identity engine (ADR-0030).
//
// Strategy:
//
//   - PUBLIC routes (no auth required):
//       /api/health          — liveness probe.
//       /api/webhooks/(.*)   — signature-verified inbound webhooks.
//       /api/v1/(.*)         — partner API; bearer API keys, not
//                              session cookies. Every handler
//                              authenticates via resolvePartnerContext
//                              (401 without a valid key).
//       /api/auth/(.*)       — sign-in / sign-out (how a session is
//                              obtained; gating these would deadlock).
//       /api/portal/(.*)     — provider portal API (ADR-0033): the
//                              apply/status endpoints are pre-credential
//                              by design; the authed portal routes
//                              validate the PORTAL cookie in-handler
//                              (the operator cookie is meaningless here).
//       /portal(/.*)         — provider portal pages. Sign-in/setup/
//                              status are public; the portal home
//                              redirects server-side without a valid
//                              portal session.
//       /sign-in, /sign-up   — the auth UI surfaces.
//       /preview             — design-system showcase (mock data).
//
//   - EVERYTHING ELSE: requires a session COOKIE to be present. This is
//     a cheap presence check only — the authoritative validation
//     (revoked? idle? absolute-expired?) happens server-side in
//     `resolveOperatorTenancyContext` → `resolveSession` inside the
//     page / route handler (it needs the DB, which the edge middleware
//     must not touch). A missing cookie redirects pages to /sign-in and
//     returns 401 for /api routes.
//
// The MFA floor for privileged writes is enforced at the call site
// (`dispatch-ops-with-mfa.ts`) against the session's `mfaSatisfied`,
// not here.
//
// Edge-runtime constraint: this file must NOT import the node-only
// `@pharmax/auth` (argon2 / prisma). The session cookie name is a local
// constant that MUST match `DEFAULT_SESSION_POLICY.cookieName`.
//
// PHI invariant: logs request shape (method, path, ua prefix) only.

import { NextResponse, type NextRequest } from "next/server";

// MUST match @pharmax/auth DEFAULT_SESSION_POLICY.cookieName.
const SESSION_COOKIE_NAME = "pharmax_session";

function pathIsPublic(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/v1/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/portal/") ||
    pathname === "/portal" ||
    pathname.startsWith("/portal/") ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/") ||
    pathname === "/accept-invite" ||
    pathname.startsWith("/accept-invite/") ||
    pathname === "/reset-password" ||
    pathname.startsWith("/reset-password/") ||
    pathname === "/preview" ||
    pathname.startsWith("/preview/")
  );
}

function pathIsSignUp(pathname: string): boolean {
  return pathname === "/sign-up" || pathname.startsWith("/sign-up/");
}

/**
 * Pure decision: should the middleware deny `/sign-up`? Self-service
 * sign-up is invitation-only; production denies the open form unless an
 * invitation ticket is present or the flag is explicitly on.
 *
 * Exported for unit tests (proxy.test.ts).
 */
export function shouldDenySignUpInMiddleware(input: {
  readonly nodeEnv: string | undefined;
  readonly signupsEnabledRaw: string | undefined;
  readonly invitationTicket: string | null;
}): boolean {
  const nodeEnv = (input.nodeEnv ?? "development").toLowerCase();
  if (nodeEnv !== "production") return false;
  if (typeof input.invitationTicket === "string" && input.invitationTicket.length > 0) {
    return false;
  }
  const flag = (input.signupsEnabledRaw ?? "").trim().toLowerCase();
  if (flag === "true" || flag === "1") return false;
  return true;
}

function isSignUpClosedFromRequest(request: NextRequest): boolean {
  if (!pathIsSignUp(request.nextUrl.pathname)) return false;
  return shouldDenySignUpInMiddleware({
    nodeEnv: process.env["NODE_ENV"],
    signupsEnabledRaw: process.env["SIGNUPS_ENABLED"],
    invitationTicket: request.nextUrl.searchParams.get("__clerk_ticket"),
  });
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Defence-in-depth 404 for a closed `/sign-up` (mirrors the page).
  if (isSignUpClosedFromRequest(request)) {
    console.warn(
      JSON.stringify({
        event: "auth.proxy.signup_closed",
        method: request.method,
        path: pathname,
        hasTicket: request.nextUrl.searchParams.has("__clerk_ticket"),
      })
    );
    return new NextResponse(null, { status: 404 });
  }

  if (pathIsPublic(pathname)) return NextResponse.next();

  const hasSession = (request.cookies.get(SESSION_COOKIE_NAME)?.value ?? "").length > 0;
  if (hasSession) return NextResponse.next();

  // No session cookie. Surface unauthenticated operator-route hits for
  // the security feed (route name only — no PHI).
  const isOperatorRoute =
    pathname.startsWith("/ops/") || pathname.startsWith("/api/ops/") || pathname === "/ops";
  if (isOperatorRoute) {
    const ua = request.headers.get("user-agent") ?? "";
    console.warn(
      JSON.stringify({
        event: "auth.proxy.unauthenticated_operator_route",
        method: request.method,
        path: pathname,
        uaPrefix: ua.slice(0, 64),
      })
    );
  }

  // API routes get a 401; page routes get a redirect to sign-in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const signInUrl = new URL("/sign-in", request.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
