// Server-side writer for the `pharmax_theme` render-hint cookie.
//
// NOT httpOnly on purpose: the cookie holds no secret (a theme name),
// and the client ThemeToggle updates it directly so the next
// server-rendered page paints the right theme without waiting for the
// preference POST to land. See src/lib/theme.ts for the full model.

import "server-only";

import type { NextResponse } from "next/server";

import { THEME_COOKIE_MAX_AGE_SECONDS, THEME_COOKIE_NAME, type ThemeChoice } from "../lib/theme.js";

export function setThemeCookie(response: NextResponse, choice: ThemeChoice): void {
  response.cookies.set({
    name: THEME_COOKIE_NAME,
    value: choice,
    httpOnly: false,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE_SECONDS,
  });
}
