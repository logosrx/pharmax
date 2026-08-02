// WebAuthn relying-party identity, derived per request (ADR-0036).
//
// Operator sign-in is per-org-subdomain, so the RP id and expected
// origin cannot be static config: they come from the SAME trusted host
// headers that `resolveOrganizationIdFromHost` uses to pick the org.
// The engine verifies ceremonies against these values — the browser's
// own claims are never trusted for them.

import "server-only";

export interface WebAuthnRp {
  /** The hostname (no port) — WebAuthn rpId semantics. */
  readonly rpId: string;
  /** Scheme + host, the expected ceremony origin. */
  readonly origin: string;
}

export function resolveWebAuthnRp(request: Request): WebAuthnRp | null {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? null;
  if (host === null || host.trim().length === 0) return null;

  const trimmedHost = host.trim().toLowerCase();
  const hostname = trimmedHost.split(":")[0] ?? trimmedHost;
  if (hostname.length === 0) return null;

  const proto = (request.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  const scheme =
    proto === "https" || proto === "http"
      ? proto
      : hostname === "localhost" || hostname === "127.0.0.1"
        ? "http"
        : "https";

  return { rpId: hostname, origin: `${scheme}://${trimmedHost}` };
}
