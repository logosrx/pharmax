// Session cookie plumbing for the in-house identity engine (ADR-0030).
//
// The opaque session token lives in an httpOnly / Secure / SameSite=Lax
// cookie named by `SessionPolicy.cookieName`. httpOnly keeps it out of
// client JS (XSS can't read it); Secure pins it to HTTPS in production;
// SameSite=Lax blocks it from cross-site POSTs while allowing top-level
// navigations back into the console.
//
// Two read paths: `readSessionTokenFromCookies()` (RSC / server
// components / route handlers, via next/headers) and
// `readSessionTokenFromRequest()` (middleware / NextRequest). Writes go
// through a NextResponse in the sign-in / sign-out routes.

import "server-only";

import { getAuthConfiguration } from "@pharmax/auth";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

function isProd(): boolean {
  return process.env["NODE_ENV"] === "production";
}

/** Read the raw session token from the RSC/route cookie store. */
export async function readSessionTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  const name = getAuthConfiguration().session.cookieName;
  return store.get(name)?.value ?? null;
}

/** Read the raw session token from a NextRequest (middleware). */
export function readSessionTokenFromRequest(request: NextRequest): string | null {
  const name = getAuthConfiguration().session.cookieName;
  return request.cookies.get(name)?.value ?? null;
}

/** Set the session cookie on a response (sign-in). */
export function setSessionCookie(response: NextResponse, rawToken: string): void {
  const config = getAuthConfiguration();
  response.cookies.set({
    name: config.session.cookieName,
    value: rawToken,
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    // Cap the cookie lifetime at the session's absolute cap; server-side
    // idle/absolute checks are authoritative regardless.
    maxAge: Math.floor(config.session.absoluteTtlMs / 1000),
  });
}

/** Clear the session cookie on a response (sign-out). */
export function clearSessionCookie(response: NextResponse): void {
  const config = getAuthConfiguration();
  response.cookies.set({
    name: config.session.cookieName,
    value: "",
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
