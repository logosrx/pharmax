// Portal session cookie plumbing (ADR-0033, slice 2) — the portal
// twin of ../auth/session-cookie.ts.
//
// A DISTINCT cookie name (`pharmax_portal_session`) from the operator
// cookie: the two principal models never share a bearer surface, so a
// portal token can never be presented as an operator session even by
// accident. Same hardening: httpOnly / Secure / SameSite=Lax, lifetime
// capped at the session's absolute TTL (server-side checks remain
// authoritative).

import "server-only";

import { getAuthConfiguration } from "@pharmax/auth";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

export const PORTAL_SESSION_COOKIE_NAME = "pharmax_portal_session";

function isProd(): boolean {
  return process.env["NODE_ENV"] === "production";
}

/** Read the raw portal session token from the RSC/route cookie store. */
export async function readPortalSessionTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  return store.get(PORTAL_SESSION_COOKIE_NAME)?.value ?? null;
}

/** Read the raw portal session token from a NextRequest. */
export function readPortalSessionTokenFromRequest(request: NextRequest): string | null {
  return request.cookies.get(PORTAL_SESSION_COOKIE_NAME)?.value ?? null;
}

/** Set the portal session cookie on a response (portal sign-in). */
export function setPortalSessionCookie(response: NextResponse, rawToken: string): void {
  const config = getAuthConfiguration();
  response.cookies.set({
    name: PORTAL_SESSION_COOKIE_NAME,
    value: rawToken,
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(config.session.absoluteTtlMs / 1000),
  });
}

/** Clear the portal session cookie on a response (portal sign-out). */
export function clearPortalSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: PORTAL_SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
