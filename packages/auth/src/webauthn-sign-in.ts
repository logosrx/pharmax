// startWebAuthnSignIn — orchestration around StartWebAuthnAuthentication.
//
// The assertion-options endpoint verifies the password (first factor),
// so it gets the SAME pre-KDF protections as `signIn`:
//
//   1. Burst rate limit (per-IP + per-email) — shares the sign-in
//      buckets, so an attacker cannot use this endpoint to sidestep
//      the sign-in limiter.
//   2. Durable lockout gate — refuse before touching the hasher.
//   3. login_attempt ledger on credential failure (its own committed
//      tx; the command tx rolls back) — a bad password here counts
//      toward lockout exactly like a bad password on sign-in.
//
// A successful start is NOT a ledger success — no session was minted.
// The completed SignIn writes the SUCCESS row.

import { errors } from "@pharmax/platform-core";
import { LoginOutcome } from "@pharmax/database";
import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import { getAuthConfiguration } from "./configure.js";
import { INVALID_CREDENTIALS, WEBAUTHN_NOT_ENROLLED, invalidCredentialsError } from "./errors.js";
import { isLockedOut, recordLoginAttempt } from "./login-attempt.js";
import {
  StartWebAuthnAuthentication,
  type StartWebAuthnAuthenticationInput,
  type StartWebAuthnAuthenticationOutput,
} from "./commands/start-webauthn-authentication.js";

const START_REASON = "auth:webauthn-start";

export async function startWebAuthnSignIn(
  input: StartWebAuthnAuthenticationInput
): Promise<StartWebAuthnAuthenticationOutput> {
  const config = getAuthConfiguration();
  const email = input.email.toLowerCase();
  const attemptBase = {
    emailAttempted: email,
    organizationId: input.organizationId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  } as const;

  const ip = input.ipAddress ?? "unknown";
  const [ipDecision, emailDecision] = await Promise.all([
    config.rateLimiter.hit(`signin:ip:${ip}`, config.signInRateLimit.perIp),
    config.rateLimiter.hit(`signin:email:${email}`, config.signInRateLimit.perEmail),
  ]);
  if (!ipDecision.allowed || !emailDecision.allowed) {
    await recordLoginAttempt({
      ...attemptBase,
      outcome: LoginOutcome.RATE_LIMITED,
      reasonCode: "rate_limited",
    });
    throw invalidCredentialsError("rate_limited");
  }

  if (await isLockedOut({ emailAttempted: email, config })) {
    await recordLoginAttempt({
      ...attemptBase,
      outcome: LoginOutcome.LOCKED_OUT,
      reasonCode: "locked_out",
    });
    throw invalidCredentialsError("locked_out");
  }

  try {
    return await withSystemContext(START_REASON, () =>
      executeSystemCommand(StartWebAuthnAuthentication, input)
    );
  } catch (err) {
    // Credential failures feed the ledger/lockout. WEBAUTHN_NOT_ENROLLED
    // is a routing signal (the account passed the password check but
    // has no security key), not a credential failure — don't ledger it.
    if (errors.isPharmaxError(err) && err.code === INVALID_CREDENTIALS) {
      const reason = err.metadata["reasonCode"];
      await recordLoginAttempt({
        ...attemptBase,
        outcome: LoginOutcome.INVALID_CREDENTIALS,
        reasonCode: typeof reason === "string" ? reason : "invalid_credentials",
      });
    } else if (!errors.isPharmaxError(err) || err.code !== WEBAUTHN_NOT_ENROLLED) {
      await recordLoginAttempt({
        ...attemptBase,
        outcome: LoginOutcome.INVALID_CREDENTIALS,
        reasonCode: "internal_error",
      });
    }
    throw err;
  }
}
