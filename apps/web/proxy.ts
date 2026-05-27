// Next.js 16 routing middleware (`proxy.ts`, the Next 15 `middleware.ts`
// successor). Runs on every request the matcher accepts.
//
// Strategy:
//
//   - PUBLIC routes (no auth required):
//       /api/health                 — liveness probe (deployment health-checks)
//       /api/webhooks/(.*)          — signature-verified inbound webhooks
//                                     (Stripe / EasyPost / Clerk).
//                                     Adding auth here would break the
//                                     webhook contract — signatures are
//                                     the auth.
//       /sign-in/*, /sign-up/*      — Clerk's hosted auth UI surfaces.
//                                     Sign-up gating happens INSIDE the
//                                     route component (production
//                                     renders a static "closed" page
//                                     unless a Clerk invitation ticket
//                                     is present). The middleware
//                                     ALSO returns 404 on a closed
//                                     `/sign-up` request as defence
//                                     in depth (see `isSignUpClosed`).
//
//   - EVERYTHING ELSE: requires a Clerk session. `auth.protect()` does
//     the redirect to `/sign-in` if no session is present. We log the
//     denial first so unauthenticated probes against operator routes
//     (billing, admin) surface in the security feed without PHI.
//
// We never require auth on `/_next/*` or `/favicon.ico` — the matcher
// at the bottom of the file excludes static asset paths.
//
// Operator → tenancy resolution happens INSIDE individual route /
// page handlers via `resolveOperatorTenancyContext` (see
// `src/server/auth/resolve-tenancy.ts`). The proxy is purely the
// "is there a Clerk session at all?" gate. The MFA floor for
// privileged writes is enforced at the call site (see
// `src/server/auth/require-mfa.ts`) — putting it here would burn a
// Clerk Backend API call on every request, including innocuous reads.
//
// PHI invariant: this file logs request shape (method, path, user
// agent prefix) only — NEVER request bodies, query strings (which
// could carry external order ids), or cookies.

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/api/health",
  "/api/webhooks/(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

const isSignUpRoute = createRouteMatcher(["/sign-up(.*)"]);

const isOperatorRoute = createRouteMatcher(["/ops/(.*)", "/api/ops/(.*)"]);

/**
 * Pure decision: should the middleware deny `/sign-up` for the
 * given (nodeEnv, signupsEnabled, ticket) tuple?
 *
 * Mirror of `resolveSignUpSurface(..) === "closed"` at the
 * middleware layer. We re-implement the rule here (instead of
 * importing the page-tier helper) for two reasons:
 *
 *   1. The middleware runtime is more restricted than the React
 *      Server Component runtime; importing the `"server-only"`-
 *      tagged env loader from here would taint the bundle.
 *   2. Defence-in-depth is most useful when the second layer is
 *      independent of the first — a bug in the page helper that
 *      flips the surface back to "open" should not also flip the
 *      middleware open.
 *
 * Exported for unit-testing. The runtime call site
 * (`isSignUpClosedFromRequest`) reads `process.env` for `nodeEnv`
 * + `signupsEnabledRaw` and the URL for the ticket; tests pass
 * those values directly.
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
  if (!isSignUpRoute(request)) return false;
  return shouldDenySignUpInMiddleware({
    nodeEnv: process.env["NODE_ENV"],
    signupsEnabledRaw: process.env["CLERK_SIGNUPS_ENABLED"],
    invitationTicket: request.nextUrl.searchParams.get("__clerk_ticket"),
  });
}

export default clerkMiddleware(async (auth, request) => {
  // Defence-in-depth gate for `/sign-up`. The page handler already
  // renders a closed-surface for the same conditions; this returns
  // a hard 404 BEFORE the page handler runs so a probe against the
  // route surfaces as "no such resource" rather than "rendered an
  // error page" in access logs. We also strip `Allow` so the route
  // does not advertise that it accepts any method.
  if (isSignUpClosedFromRequest(request)) {
    console.warn(
      JSON.stringify({
        event: "auth.proxy.signup_closed",
        method: request.method,
        path: request.nextUrl.pathname,
        // Whether a ticket was present at all — never the value.
        hasTicket: request.nextUrl.searchParams.has("__clerk_ticket"),
      })
    );
    return new NextResponse(null, { status: 404 });
  }

  if (isPublicRoute(request)) return;

  const session = await auth();
  if (session.userId === null) {
    // Surface unauthenticated hits on operator routes for the
    // security feed. This is structurally observable, not a PHI
    // leak: the path is a route name, not an order id, and we
    // do not include cookies / bodies / decrypted query params.
    if (isOperatorRoute(request)) {
      // We use console.warn here intentionally — middleware runs in
      // the Next runtime, where the structured app logger is not
      // available without pulling in the full server module graph
      // (`server-only` would error at middleware build time). The
      // platform's stdout collector picks this up; format keeps
      // the same `event:` discriminator the rest of the auth lane
      // uses so log-pipeline filters match.
      const ua = request.headers.get("user-agent") ?? "";
      console.warn(
        JSON.stringify({
          event: "auth.proxy.unauthenticated_operator_route",
          method: request.method,
          path: request.nextUrl.pathname,
          // First 64 chars only — enough to distinguish a real
          // browser from a probe, not enough to fingerprint.
          uaPrefix: ua.slice(0, 64),
        })
      );
    }
    await auth.protect();
    return;
  }

  // Authenticated session present. `auth.protect()` is still called
  // to honour Clerk's session-revocation semantics (the SDK may
  // re-validate the session token here; without the call, a token
  // revoked mid-flight wouldn't redirect until the next page load).
  await auth.protect();
  return;
});

export const config = {
  // Run on everything EXCEPT static files + Next internals. The
  // Clerk-recommended matcher; we keep it verbatim so future Clerk
  // upgrades don't break matcher expectations.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
