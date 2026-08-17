// Same-origin redirects for operator route handlers.
//
// Why this exists: `NextResponse.redirect()` demands an ABSOLUTE url,
// and every ops route satisfied that by parsing its path against the
// placeholder base `http://internal`. The placeholder then went out on
// the wire — `Location: http://internal/ops/typing` — which no browser
// can resolve, so an operator who completed a command landed on a
// network-error page. The command had already committed, so no work
// was lost, but every workflow action ended in an apparent failure.
//
// The fix is to emit a RELATIVE Location. RFC 7231 §7.1.2 permits a
// relative reference and requires the client to resolve it against the
// request URI, so the operator always lands back on the origin they
// came from. Three reasons to prefer that over rebuilding an absolute
// url from `request.url`:
//
//   1. Pharmax resolves the tenant from the subdomain (ADR-0030). A
//      relative Location stays on whatever tenant origin the operator
//      is on, with nothing to derive and nothing to get wrong.
//   2. An absolute url built from the request means trusting `Host` /
//      `X-Forwarded-Host`. A spoofed header would turn every ops
//      action into an open redirect — a phishing primitive aimed
//      squarely at authenticated pharmacy staff.
//   3. There is no origin to configure per environment, so local, e2e,
//      staging and production behave identically.
//
// Targets are still parsed through `URL` because several callers pass
// a path that already carries a query string and then set one more
// param on top. The placeholder base used for that parse is never
// emitted: only `pathname + search + hash` goes into the header. That
// is also what makes the helper safe by construction — a target like
// `//evil.com/x` parses to pathname `/x`, so an off-site redirect
// cannot be expressed through this function at all.

import "server-only";

import { NextResponse } from "next/server";

/**
 * Base used ONLY to parse relative targets. Never emitted — see the
 * module header. Any absolute target parsed against it loses its
 * origin when `sameOriginPath` keeps just the path.
 */
const PARSE_ONLY_BASE = "http://parse.invalid";

/**
 * Reduce a redirect target to a same-origin path.
 *
 * Exported for tests: the guarantee "no input produces an off-origin
 * Location" is the security property of this module and is asserted
 * directly rather than through a Response object.
 */
export function sameOriginPath(target: string): string {
  const url = new URL(target, PARSE_ONLY_BASE);
  const path = `${url.pathname}${url.search}${url.hash}`;
  // `new URL` already strips CR/LF, so a header-injection attempt
  // cannot survive the parse; the leading-slash guarantee comes from
  // URL normalization too. Both are re-asserted in the unit tests
  // rather than re-implemented here.
  return path;
}

/**
 * 303 See Other to a path on the same origin as the request.
 *
 * 303 (not 302) so the browser re-issues the follow-up as GET: every
 * caller is a form POST that has already applied its command, and a
 * refresh must not re-submit it.
 *
 * @param target Path to return to. May carry its own query string.
 * @param params Extra query params to set on top of it. Empty-string
 *   values are dropped, so callers can pass optional flash fields
 *   without composing the query themselves.
 */
export function seeOther(target: string, params?: Readonly<Record<string, string>>): Response {
  const url = new URL(target, PARSE_ONLY_BASE);
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      if (value.length === 0) continue;
      url.searchParams.set(key, value);
    }
  }
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${url.pathname}${url.search}${url.hash}` },
  });
}
