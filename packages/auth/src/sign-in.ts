// signIn — orchestration around the SignIn bus command.
//
// Responsibilities that do NOT belong inside the command's transaction
// (because they must survive the tx rollback on failure, or must run
// before the KDF):
//
//   1. Lockout gate — refuse before touching the password hasher, so a
//      locked/attacked account can't burn Argon2id CPU (DoS blunting).
//   2. login_attempt ledger — record success AND every failure in its
//      own committed tx (the command tx rolls back on failure).
//
// The command itself owns the audit_log / command_log / outbox writes on
// success. This wrapper is a domain service, not route logic — the thin
// web route just calls `signIn(...)` and sets the returned cookie.

import { errors } from "@pharmax/platform-core";
import { LoginOutcome } from "@pharmax/database";
import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import { getAuthConfiguration } from "./configure.js";
import {
  INVALID_CREDENTIALS,
  MFA_INVALID,
  MFA_REQUIRED,
  invalidCredentialsError,
} from "./errors.js";
import { isLockedOut, recordLoginAttempt } from "./login-attempt.js";
import { SignIn, type SignInInput, type SignInOutput } from "./commands/sign-in.js";

const SIGN_IN_REASON = "auth:sign-in";

export interface SignInResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  /** Bearer token to set as the session cookie. */
  readonly rawToken: string;
}

export async function signIn(input: SignInInput): Promise<SignInResult> {
  const config = getAuthConfiguration();
  const email = input.email.toLowerCase();
  const attemptBase = {
    emailAttempted: email,
    organizationId: input.organizationId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  } as const;

  // 1. Lockout gate.
  if (await isLockedOut({ emailAttempted: email, config })) {
    await recordLoginAttempt({
      ...attemptBase,
      outcome: LoginOutcome.LOCKED_OUT,
      reasonCode: "locked_out",
    });
    // Same generic surface as a bad password — never disclose lockout
    // state as a distinct signal to an unauthenticated caller.
    throw invalidCredentialsError("locked_out");
  }

  // 2. Dispatch the SignIn command (system context; success writes the
  //    audit/outbox). Failures throw and are recorded below.
  let result: SignInOutput;
  try {
    result = await withSystemContext(SIGN_IN_REASON, () => executeSystemCommand(SignIn, input));
  } catch (err) {
    await recordLoginAttempt({ ...attemptBase, ...classifyFailure(err) });
    throw err;
  }

  await recordLoginAttempt({ ...attemptBase, outcome: LoginOutcome.SUCCESS });

  return {
    userId: result.userId,
    organizationId: result.organizationId,
    sessionId: result.sessionId,
    rawToken: result.rawToken,
  };
}

/** Map a thrown auth error to the ledger outcome + reason code. */
function classifyFailure(err: unknown): {
  readonly outcome: LoginOutcome;
  readonly reasonCode: string;
} {
  if (errors.isPharmaxError(err)) {
    switch (err.code) {
      case MFA_REQUIRED:
        return { outcome: LoginOutcome.MFA_REQUIRED, reasonCode: MFA_REQUIRED };
      case MFA_INVALID:
        return { outcome: LoginOutcome.MFA_FAILED, reasonCode: MFA_INVALID };
      case INVALID_CREDENTIALS: {
        const reason = err.metadata["reasonCode"];
        return {
          outcome: LoginOutcome.INVALID_CREDENTIALS,
          reasonCode: typeof reason === "string" ? reason : "invalid_credentials",
        };
      }
      default:
        return { outcome: LoginOutcome.INVALID_CREDENTIALS, reasonCode: err.code };
    }
  }
  // Non-Pharmax error (bug/infra). Record generically; the bus already
  // logged it. Do not leak internals into the ledger reason.
  return { outcome: LoginOutcome.INVALID_CREDENTIALS, reasonCode: "internal_error" };
}
