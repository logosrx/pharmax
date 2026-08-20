// Trusted-proxy client-IP resolution for rate-limit keying.
//
// WHY THIS EXISTS. Every unauthenticated auth/portal entry point keys its
// per-IP limiter on a value pulled from `X-Forwarded-For`. Until this
// helper landed, each call site took the LEFT-MOST XFF entry — the one a
// client fully controls. Rotating the header therefore bought a fresh
// limiter bucket on every request, defeating the per-IP limit entirely:
// unbounded credential stuffing, user-enumeration, and — because sign-in
// runs Argon2id (≈19 MiB) per attempt — a single-host memory/CPU-
// exhaustion DoS. (Pentest H4.)
//
// THE FIX. `X-Forwarded-For` is only trustworthy from the RIGHT. Each
// reverse proxy in the path appends the address it received the
// connection from, so with N trusted proxies the real client address is
// the Nth-from-the-right entry. Anything a client injects itself can only
// land further LEFT than the address the outermost trusted proxy appended,
// so it can never reach position N. We therefore read exactly one entry —
// `entries[length - N]` — and never scan the client-controlled prefix.
//
// N is `TRUSTED_PROXY_HOP_COUNT`, a per-environment value (CloudFront->ALB
// is 2, ALB-only is 1, direct is 0). See server/env.ts for the topology
// mapping and the fail-closed rationale.
//
// FAIL CLOSED, NEVER OPEN. Three cases return `undefined` — meaning "IP
// unknown", which every caller maps to a single shared limiter bucket
// (the conservative direction: it limits more, never less, and can never
// mint a per-caller bucket from an untrusted value):
//   1. N === 0            — no trusted proxy, so no XFF entry is trustworthy.
//   2. chain shorter than N — the request did not traverse the expected
//                            proxies (spoof or misroute); the position we
//                            would read is client-influenced.
//   3. the resolved entry is not IP-shaped — a proxy misconfiguration; we
//      refuse to key on a non-address rather than trust it.

import "server-only";

import { env } from "@/server/env";

/**
 * IPv4, optionally with a `:port` suffix (some proxies append one), and a
 * permissive IPv6 shape (hex groups + `:`, optionally bracketed). This is
 * a sanity gate against proxy misconfiguration, not a full RFC validator —
 * the value at position N-from-right is written by our own trusted proxy,
 * so the check exists to fail closed on the unexpected, not to parse every
 * legal address form.
 */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/;
const IPV6 = /^\[?[0-9a-fA-F:]+\]?$/;

function looksLikeIp(value: string): boolean {
  if (IPV4.test(value)) return true;
  // Require at least two colons to avoid treating a bare token as IPv6.
  return value.includes(":") && IPV6.test(value);
}

/**
 * Resolve the client IP to use as a rate-limit key, trusting only the
 * configured number of reverse-proxy hops. Returns `undefined` when the
 * address cannot be established from a trusted position — callers MUST
 * treat `undefined` as "unknown" and fall back to a single shared bucket,
 * never to a per-request value.
 *
 * Accepts any object exposing `headers.get` (`NextRequest` and the Web
 * `Request` both satisfy this), so onboarding/portal routes that receive a
 * plain `Request` can share the same resolution.
 */
export function resolveClientIp(request: Request): string | undefined {
  const hops = env.TRUSTED_PROXY_HOP_COUNT;
  if (hops <= 0) return undefined;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded === null) return undefined;

  const entries = forwarded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Fewer entries than trusted hops means the request skipped one or more
  // proxies we expected — the position we would read is not the one our
  // outermost trusted proxy wrote. Refuse it.
  if (entries.length < hops) return undefined;

  const candidate = entries[entries.length - hops];
  if (candidate === undefined || !looksLikeIp(candidate)) return undefined;

  return candidate;
}
