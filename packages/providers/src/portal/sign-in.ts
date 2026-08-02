// portalSignIn — orchestration around the PortalSignIn bus command
// (ADR-0033, slice 2). The portal twin of `@pharmax/auth`'s
// `signIn` wrapper, with the same layering:
//
//   1. Burst rate limit (per-IP + per-email) BEFORE the KDF, so a
//      flood can't use Argon2id as a CPU-exhaustion oracle. Keys
//      are namespaced `portal-signin:*` so portal abuse and
//      operator abuse are throttled independently.
//   2. Durable lockout gate on the SHARED login_attempt ledger —
//      an email under attack is locked out regardless of which
//      sign-in surface the attacker hammers.
//   3. login_attempt ledger writes for success AND every failure
//      (their own committed tx; the command tx rolls back on
//      failure).

import {
  getAuthConfiguration,
  INVALID_CREDENTIALS,
  invalidCredentialsError,
  isLockedOut,
  recordLoginAttempt,
} from "@pharmax/auth";
import { executeSystemCommand } from "@pharmax/command-bus";
import { LoginOutcome } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import {
  PortalSignIn,
  type PortalSignInInput,
  type PortalSignInOutput,
} from "./sign-in-command.js";

const SIGN_IN_REASON = "portal:sign-in";

export interface PortalSignInResult {
  readonly portalAccountId: string;
  readonly providerId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  /** Bearer token to set as the portal session cookie. */
  readonly rawToken: string;
}

export async function portalSignIn(input: PortalSignInInput): Promise<PortalSignInResult> {
  const config = getAuthConfiguration();
  const email = input.email.toLowerCase();
  const attemptBase = {
    emailAttempted: email,
    organizationId: input.organizationId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  } as const;

  // 1. Burst limits (same rules as operator sign-in, separate keys).
  const ip = input.ipAddress ?? "unknown";
  const [ipDecision, emailDecision] = await Promise.all([
    config.rateLimiter.hit(`portal-signin:ip:${ip}`, config.signInRateLimit.perIp),
    config.rateLimiter.hit(`portal-signin:email:${email}`, config.signInRateLimit.perEmail),
  ]);
  if (!ipDecision.allowed || !emailDecision.allowed) {
    await recordLoginAttempt({
      ...attemptBase,
      outcome: LoginOutcome.RATE_LIMITED,
      reasonCode: "portal_rate_limited",
    });
    throw invalidCredentialsError("rate_limited");
  }

  // 2. Durable lockout gate (shared ledger — see module comment).
  if (await isLockedOut({ emailAttempted: email, config })) {
    await recordLoginAttempt({
      ...attemptBase,
      outcome: LoginOutcome.LOCKED_OUT,
      reasonCode: "portal_locked_out",
    });
    throw invalidCredentialsError("locked_out");
  }

  // 3. Dispatch. Failures throw and are recorded below.
  let result: PortalSignInOutput;
  try {
    result = await withSystemContext(SIGN_IN_REASON, () =>
      executeSystemCommand(PortalSignIn, input)
    );
  } catch (err) {
    await recordLoginAttempt({ ...attemptBase, ...classifyFailure(err) });
    throw err;
  }

  await recordLoginAttempt({ ...attemptBase, outcome: LoginOutcome.SUCCESS });

  return {
    portalAccountId: result.portalAccountId,
    providerId: result.providerId,
    organizationId: result.organizationId,
    sessionId: result.sessionId,
    rawToken: result.rawToken,
  };
}

function classifyFailure(err: unknown): {
  readonly outcome: LoginOutcome;
  readonly reasonCode: string;
} {
  if (errors.isPharmaxError(err)) {
    if (err.code === INVALID_CREDENTIALS) {
      const reason = err.metadata["reasonCode"];
      return {
        outcome: LoginOutcome.INVALID_CREDENTIALS,
        reasonCode: typeof reason === "string" ? reason : "invalid_credentials",
      };
    }
    return { outcome: LoginOutcome.INVALID_CREDENTIALS, reasonCode: err.code };
  }
  return { outcome: LoginOutcome.INVALID_CREDENTIALS, reasonCode: "internal_error" };
}
