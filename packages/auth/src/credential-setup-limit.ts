// Burst limit for the PUBLIC credential-setting entry points —
// `acceptInvite` and `resetPassword`.
//
// WHAT THIS PROTECTS. Two different things, with different weights:
//
//   1. Breach-corpus amplification (the reason this exists; R-026).
//      `withScreenedPassword` wraps the command dispatch from OUTSIDE,
//      because the bus opens the Postgres transaction before it calls
//      the handler and a third-party lookup must not run with a
//      connection held open (see password/breach-screen.ts). The
//      consequence is that the corpus lookup happens BEFORE the handler
//      resolves the token, so once a `BreachChecker` is configured every
//      unauthenticated request buys one outbound lookup against a
//      third-party-billed, third-party-rate-limited endpoint — with no
//      valid token needed, and with the fail-open path reachable at
//      will. This gate is the ordering prerequisite for wiring a
//      checker at all: it must land FIRST.
//
//   2. Token brute force, secondarily. Setup and reset links carry 32
//      bytes of CSPRNG entropy and are single-use and TTL-bounded, so
//      guessing is already infeasible on entropy alone — the limit
//      makes a guessing campaign cheap to spot rather than merely
//      cheap to survive. It is NOT the primary control there, and
//      should not be described as one.
//
// Note what is NOT in that list: Argon2id CPU. An invalid token is
// refused before `applyNewPassword` runs, so a garbage-token flood
// never reaches the KDF. That is the opposite of sign-in, where every
// attempt pays for a hash — which is why sign-in's limiter sits in
// front of the KDF and this one sits in front of the corpus lookup.
//
// WHAT IT IS KEYED ON, AND WHY IT CANNOT BE KEYED ON MORE.
//
// The client IP, and nothing else. Sign-in keys on IP *and* email
// because sign-in is handed an identity in the request body. Here the
// only identity is inside the token, and reading it requires the
// database lookup the handler performs — so a per-account key would
// mean resolving the token before deciding, and the decision would then
// differ between a real token and a forged one. That is precisely the
// existence oracle the single opaque `RESET_TOKEN_INVALID` exists to
// deny. IP is what is knowable before the token means anything, so IP
// is what this counts.
//
// Two properties follow, and both are load-bearing:
//
//   - Counted BEFORE the token is inspected, and counted on EVERY
//     request including the ones that go on to succeed. A limiter that
//     only counted failures would leak: an attacker could send a
//     candidate token, then known-bad ones, and read which request
//     tripped the limit to learn whether the candidate consumed budget.
//   - Refused with `resetTokenInvalidError()` — the SAME code and the
//     SAME message the commands use for every other refusal, so the
//     403/429-shaped tell does not exist. `accept-invite.test.ts`
//     asserts every refusal on this path shares one `code|message`;
//     this participates in that property rather than punching a hole
//     in it. The cost is a real one and is accepted deliberately: a
//     rate-limited operator sees "this link is invalid" and no
//     `retry-after`. The window is 60s and nothing durable is written,
//     so a retry a minute later succeeds.
//
// ONE BUCKET FOR BOTH ENTRY POINTS. `acceptInvite` and `resetPassword`
// drive the same corpus through the same wrapper, so giving them
// separate buckets would just mean an attacker who exhausted one moved
// to the other for a fresh budget. Same reason `startWebAuthnSignIn`
// shares sign-in's buckets instead of minting its own.
//
// NO DURABLE LEDGER, DELIBERATELY. Sign-in pairs its burst limiter with
// a per-email `login_attempt` lockout. That is wrong here twice over:
// there is no account to attribute the attempt to before the token
// resolves, and a durable per-account lockout on this path would let
// anyone who merely knows an invite is outstanding keep a new hire from
// ever onboarding. A short rolling window that forgets is the correct
// failure mode for a route whose legitimate caller is someone setting
// their first password.

import { getAuthConfiguration } from "./configure.js";
import { resetTokenInvalidError } from "./errors.js";

/** Shared bucket namespace — see "ONE BUCKET FOR BOTH ENTRY POINTS". */
const KEY_PREFIX = "credential-setup:ip:";

/**
 * Client IP as supplied by the caller-facing edge. Optional because the
 * value is a header and headers go missing; absent collapses to one
 * shared `unknown` bucket, which is the conservative direction (it
 * limits more, never less). Same treatment as `signIn`.
 */
export interface CredentialSetupBurstInput {
  readonly ipAddress?: string | undefined;
}

/**
 * Count one credential-setup request against its IP bucket and throw
 * the opaque refusal if the burst limit is exceeded.
 *
 * Call this BEFORE `withScreenedPassword`, so a refused request costs
 * no corpus lookup — the whole point of the gate.
 */
export async function guardCredentialSetupBurst(input: CredentialSetupBurstInput): Promise<void> {
  const config = getAuthConfiguration();
  const ip = input.ipAddress ?? "unknown";
  const decision = await config.rateLimiter.hit(
    `${KEY_PREFIX}${ip}`,
    config.credentialSetupRateLimit.perIp
  );
  if (!decision.allowed) {
    // Indistinguishable from an unknown / used / expired token by
    // construction: same error factory, so same code, message and 401.
    throw resetTokenInvalidError();
  }
}
