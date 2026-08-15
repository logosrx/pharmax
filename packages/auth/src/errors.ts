// @pharmax/auth error codes.
//
// Design rules, all compliance-driven:
//
//   - Credential-facing failures (bad password, unknown email, locked,
//     inactive) surface as ONE generic `AuthenticationError`
//     (`INVALID_CREDENTIALS`) to the CLIENT so the engine never reveals
//     whether an email exists (enumeration defense). The precise reason
//     is recorded in `login_attempt.reasonCode` / the audit log for
//     operators — never returned to the caller.
//   - MFA step-up and session failures are their own codes so the web
//     tier can route the UI (enroll / re-auth) without guessing.
//   - Policy violations on password CHANGE (where the caller is already
//     authenticated) are `ValidationError` (400) and MAY be specific —
//     there is no enumeration risk once authenticated.
//   - Configuration/boot mistakes are `InternalError` so they are loud
//     in tests and paged in production.
//
// PHI rule: nothing in error metadata is patient data. The most
// identifying field is `userId` (a staff id) or `correlationId`.

import { errors } from "@pharmax/platform-core";

// --- Client-facing authentication failures (401) --------------------------

/** Generic sign-in failure. Deliberately hides the specific cause. */
export const INVALID_CREDENTIALS = "INVALID_CREDENTIALS" as const;
/** A second factor is required and not yet satisfied for this session. */
export const MFA_REQUIRED = "MFA_REQUIRED" as const;
/** The supplied TOTP / recovery code did not verify. */
export const MFA_INVALID = "MFA_INVALID" as const;
/** No session, unknown token, revoked, or expired. */
export const SESSION_INVALID = "SESSION_INVALID" as const;
/** A password-reset token was unknown, already used, or expired. */
export const RESET_TOKEN_INVALID = "RESET_TOKEN_INVALID" as const;

// --- Authenticated-caller validation failures (400) -----------------------

/** New password fails the strength / length / breach policy. */
export const PASSWORD_POLICY_VIOLATION = "PASSWORD_POLICY_VIOLATION" as const;
/** New password matches a recent entry in the anti-reuse history. */
export const PASSWORD_REUSED = "PASSWORD_REUSED" as const;
/** MFA enrollment attempted while an active enrollment already exists. */
export const MFA_ALREADY_ENROLLED = "MFA_ALREADY_ENROLLED" as const;
/** The current password supplied to ChangePassword did not verify. */
export const CURRENT_PASSWORD_INVALID = "CURRENT_PASSWORD_INVALID" as const;
/** ConfirmMfa called with no pending (unverified) enrollment to confirm. */
export const MFA_NO_PENDING_ENROLLMENT = "MFA_NO_PENDING_ENROLLMENT" as const;
/** A WebAuthn ceremony referenced an unknown, expired, or consumed challenge. */
export const WEBAUTHN_CHALLENGE_INVALID = "WEBAUTHN_CHALLENGE_INVALID" as const;
/** The attestation from the authenticator failed verification. */
export const WEBAUTHN_REGISTRATION_FAILED = "WEBAUTHN_REGISTRATION_FAILED" as const;
/** WebAuthn authentication requested for an account with no active credentials. */
export const WEBAUTHN_NOT_ENROLLED = "WEBAUTHN_NOT_ENROLLED" as const;

// --- Boot / configuration (500) -------------------------------------------

/** `configureAuth` was never called for this process. */
export const AUTH_NOT_CONFIGURED = "AUTH_NOT_CONFIGURED" as const;
/**
 * A password-setting command ran outside a `withScreenedPassword`
 * frame, so no breach verdict exists for the password it was asked to
 * store. Fails closed: guessing here means a credential path that
 * silently never consults the breach corpus.
 */
export const PASSWORD_BREACH_SCREEN_MISSING = "PASSWORD_BREACH_SCREEN_MISSING" as const;

/**
 * The single client-facing sign-in error. `reasonCode` is for the
 * audit trail / `login_attempt` ledger only and MUST NOT be echoed to
 * the caller in a way that distinguishes "no such user" from "wrong
 * password".
 */
export function invalidCredentialsError(reasonCode: string): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: INVALID_CREDENTIALS,
    message: "Incorrect email or password.",
    metadata: { reasonCode },
  });
}

export function mfaRequiredError(detail: {
  readonly userId: string;
  readonly enrolled: boolean;
  /** Second-factor methods this account can satisfy ("TOTP", "WEBAUTHN"). */
  readonly methods?: ReadonlyArray<string>;
}): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: MFA_REQUIRED,
    message: "Multi-factor authentication is required.",
    metadata: {
      userId: detail.userId,
      enrolled: detail.enrolled,
      methods: [...(detail.methods ?? [])],
    },
  });
}

export function mfaInvalidError(): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: MFA_INVALID,
    message: "The verification code is invalid or has expired.",
  });
}

export function sessionInvalidError(reasonCode: string): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: SESSION_INVALID,
    message: "Your session is no longer valid. Please sign in again.",
    metadata: { reasonCode },
  });
}

export function resetTokenInvalidError(): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: RESET_TOKEN_INVALID,
    message: "This password reset link is invalid or has expired.",
  });
}

export function passwordPolicyViolationError(detail: {
  readonly violations: ReadonlyArray<string>;
}): errors.ValidationError {
  return new errors.ValidationError({
    code: PASSWORD_POLICY_VIOLATION,
    message: "The password does not meet the security policy.",
    issues: [{ path: ["password"], message: detail.violations.join("; ") }],
  });
}

export function passwordReusedError(): errors.ValidationError {
  return new errors.ValidationError({
    code: PASSWORD_REUSED,
    message: "This password was used recently. Choose a different one.",
    issues: [{ path: ["password"], message: "recently used" }],
  });
}

export function mfaAlreadyEnrolledError(detail: { readonly userId: string }): errors.ConflictError {
  return new errors.ConflictError({
    code: MFA_ALREADY_ENROLLED,
    message: "An active authenticator is already enrolled for this account.",
    metadata: { userId: detail.userId },
  });
}

export function currentPasswordInvalidError(): errors.ValidationError {
  return new errors.ValidationError({
    code: CURRENT_PASSWORD_INVALID,
    message: "The current password is incorrect.",
    issues: [{ path: ["currentPassword"], message: "incorrect" }],
  });
}

export function mfaNoPendingEnrollmentError(detail: {
  readonly userId: string;
}): errors.ConflictError {
  return new errors.ConflictError({
    code: MFA_NO_PENDING_ENROLLMENT,
    message: "There is no pending authenticator enrollment to confirm.",
    metadata: { userId: detail.userId },
  });
}

export function webAuthnChallengeInvalidError(): errors.ValidationError {
  return new errors.ValidationError({
    code: WEBAUTHN_CHALLENGE_INVALID,
    message: "This security-key challenge is invalid or has expired. Start over.",
    issues: [{ path: ["challengeId"], message: "unknown, expired, or already used" }],
  });
}

export function webAuthnRegistrationFailedError(): errors.ValidationError {
  return new errors.ValidationError({
    code: WEBAUTHN_REGISTRATION_FAILED,
    message: "The security key could not be verified. Try registering it again.",
    issues: [{ path: ["response"], message: "attestation verification failed" }],
  });
}

export function webAuthnNotEnrolledError(detail: {
  readonly userId: string;
}): errors.AuthenticationError {
  return new errors.AuthenticationError({
    code: WEBAUTHN_NOT_ENROLLED,
    message: "No security key is registered for this account.",
    metadata: { userId: detail.userId },
  });
}

/**
 * `reason` distinguishes "no frame at all" from "the frame screened a
 * different password". It is a developer-facing discriminator only —
 * the plaintext is never included.
 */
export function passwordBreachScreenMissingError(
  reason: "no_active_screen" | "screen_password_mismatch"
): errors.InternalError {
  return new errors.InternalError({
    code: PASSWORD_BREACH_SCREEN_MISSING,
    message:
      "No breach screen is available for this password. Wrap the command dispatch in " +
      "withScreenedPassword(newPassword, () => ...) so the breach check runs before the transaction opens.",
    metadata: { reason },
  });
}

export function authNotConfiguredError(): errors.InternalError {
  return new errors.InternalError({
    code: AUTH_NOT_CONFIGURED,
    message:
      "@pharmax/auth was not configured. Call configureAuth({...}) at process boot before any auth operation.",
  });
}
