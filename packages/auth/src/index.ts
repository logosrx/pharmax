// Public surface of @pharmax/auth — the in-house identity engine
// (ADR-0030). The engine owns authentication only; @pharmax/rbac and
// @pharmax/tenancy own authorization + tenancy.
//
// Two import styles supported (matching the other packages):
//
//     // Named:
//     import { configureAuth, createArgon2idHasher } from "@pharmax/auth";
//
//     // Namespaced:
//     import { auth } from "@pharmax/auth";
//     auth.configureAuth({ ... });

export {
  configureAuth,
  getAuthConfiguration,
  resetAuthConfigurationForTests,
  buildAuthConfiguration,
  DEFAULT_SESSION_POLICY,
  DEFAULT_MFA_POLICY,
  DEFAULT_LOCKOUT_POLICY,
  DEFAULT_SIGN_IN_RATE_LIMIT,
  DEFAULT_RESET_TOKEN_TTL_MS,
  DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS,
  MFA_REQUIRED_ROLE_CODES,
  type AuthConfiguration,
  type SessionPolicy,
  type MfaPolicy,
  type WebAuthnPolicy,
  type LockoutPolicy,
  type SignInRateLimitPolicy,
} from "./configure.js";
export {
  InMemoryRateLimiter,
  NOOP_RATE_LIMITER,
  type RateLimiter,
  type RateLimitRule,
  type RateLimitResult,
} from "./rate-limit.js";

export type { PasswordHasher } from "./password/hasher.js";
export {
  createArgon2idHasher,
  DEFAULT_ARGON2ID_PARAMS,
  type Argon2idParams,
} from "./password/argon2-hasher.js";
export {
  evaluatePasswordPolicy,
  checkNotBreached,
  DEFAULT_PASSWORD_POLICY,
  type PasswordPolicy,
  type PasswordEvaluation,
  type BreachChecker,
} from "./password/policy.js";

export { mintSessionToken, hashSessionToken, MIN_SESSION_TOKEN_BYTES } from "./session/token.js";
export {
  createSessionInTx,
  resolveSession,
  revokeSessionInTx,
  revokeAllUserSessionsInTx,
  revokeSessionByToken,
  SESSION_NOT_FOUND,
  SESSION_REVOKED,
  SESSION_IDLE_EXPIRED,
  SESSION_ABSOLUTE_EXPIRED,
  type SessionResolution,
  type SessionFailureReason,
  type ResolvedSession,
  type CreateSessionInput,
  type CreatedSession,
  type ResolveSessionInput,
  type RevokeReason,
} from "./session/service.js";

export { generateTotpSecretBase32, buildTotpKeyUri, verifyTotpCode } from "./mfa/totp.js";
export {
  createSimpleWebAuthnAdapter,
  type WebAuthnAdapter,
  type WebAuthnOptionsJSON,
  type WebAuthnRegistrationResult,
  type WebAuthnAuthenticationResult,
  type GenerateWebAuthnRegistrationInput,
  type VerifyWebAuthnRegistrationInput,
  type GenerateWebAuthnAuthenticationInput,
  type VerifyWebAuthnAuthenticationInput,
  type GeneratedWebAuthnOptions,
} from "./mfa/webauthn.js";
export {
  mintWebAuthnChallenge,
  consumeWebAuthnChallenge,
  type WebAuthnChallengeTx,
} from "./mfa/webauthn-challenge.js";
export {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./mfa/recovery-codes.js";
export { sealTotpSecret, openTotpSecret } from "./mfa/secret-seal.js";

export {
  recordLoginAttempt,
  countRecentFailedAttempts,
  isLockedOut,
  type RecordLoginAttemptInput,
} from "./login-attempt.js";
export { SignIn, type SignInInput, type SignInOutput } from "./commands/sign-in.js";
export { signIn, type SignInResult } from "./sign-in.js";
export {
  ChangePassword,
  type ChangePasswordInput,
  type ChangePasswordOutput,
} from "./commands/change-password.js";
export { EnrollMfa, type EnrollMfaInput, type EnrollMfaOutput } from "./commands/enroll-mfa.js";
export { ConfirmMfa, type ConfirmMfaInput, type ConfirmMfaOutput } from "./commands/confirm-mfa.js";
export {
  EnrollWebAuthnCredential,
  type EnrollWebAuthnCredentialInput,
  type EnrollWebAuthnCredentialOutput,
} from "./commands/enroll-webauthn.js";
export {
  ConfirmWebAuthnCredential,
  type ConfirmWebAuthnCredentialInput,
  type ConfirmWebAuthnCredentialOutput,
} from "./commands/confirm-webauthn.js";
export {
  StartWebAuthnAuthentication,
  type StartWebAuthnAuthenticationInput,
  type StartWebAuthnAuthenticationOutput,
} from "./commands/start-webauthn-authentication.js";
export { startWebAuthnSignIn } from "./webauthn-sign-in.js";
export { verifyFirstFactor, type VerifiedFirstFactor } from "./password/verify-first-factor.js";
export {
  RevokeSessions,
  type RevokeSessionsInput,
  type RevokeSessionsOutput,
} from "./commands/revoke-sessions.js";
export {
  IssuePasswordReset,
  type IssuePasswordResetInput,
  type IssuePasswordResetOutput,
} from "./commands/issue-password-reset.js";
export {
  ResetPassword,
  type ResetPasswordInput,
  type ResetPasswordOutput,
} from "./commands/reset-password.js";
export { requestPasswordReset, type RequestPasswordResetInput } from "./request-password-reset.js";
export { resetPassword } from "./reset-password.js";
export {
  IssueInvite,
  DEFAULT_INVITE_TTL_MS,
  ISSUE_INVITE_USER_NOT_FOUND,
  type IssueInviteInput,
  type IssueInviteOutput,
} from "./commands/issue-invite.js";
export {
  AcceptInvite,
  type AcceptInviteInput,
  type AcceptInviteOutput,
} from "./commands/accept-invite.js";
export {
  DeactivateUser,
  type DeactivateUserInput,
  type DeactivateUserOutput,
} from "./commands/deactivate-user.js";
export {
  SetThemePreference,
  type SetThemePreferenceInput,
  type SetThemePreferenceOutput,
} from "./commands/set-theme-preference.js";
export { issueInvite, acceptInvite } from "./invite.js";
export {
  NOOP_PASSWORD_RESET_MAILER,
  type PasswordResetMailer,
  type PasswordResetDelivery,
} from "./reset-mailer.js";
export { applyNewPassword } from "./password/set-password.js";

export {
  INVALID_CREDENTIALS,
  MFA_REQUIRED,
  MFA_INVALID,
  SESSION_INVALID,
  RESET_TOKEN_INVALID,
  PASSWORD_POLICY_VIOLATION,
  PASSWORD_REUSED,
  MFA_ALREADY_ENROLLED,
  WEBAUTHN_CHALLENGE_INVALID,
  WEBAUTHN_REGISTRATION_FAILED,
  WEBAUTHN_NOT_ENROLLED,
  AUTH_NOT_CONFIGURED,
  invalidCredentialsError,
  mfaRequiredError,
  mfaInvalidError,
  sessionInvalidError,
  resetTokenInvalidError,
  passwordPolicyViolationError,
  passwordReusedError,
  mfaAlreadyEnrolledError,
  webAuthnChallengeInvalidError,
  webAuthnRegistrationFailedError,
  webAuthnNotEnrolledError,
  authNotConfiguredError,
} from "./errors.js";

import * as configureModule from "./configure.js";
import * as argon2Module from "./password/argon2-hasher.js";
import * as policyModule from "./password/policy.js";
import * as tokenModule from "./session/token.js";
import * as sessionModule from "./session/service.js";
import * as totpModule from "./mfa/totp.js";
import * as recoveryModule from "./mfa/recovery-codes.js";
import * as secretSealModule from "./mfa/secret-seal.js";
import * as webauthnModule from "./mfa/webauthn.js";
import * as webauthnChallengeModule from "./mfa/webauthn-challenge.js";
import * as enrollWebauthnModule from "./commands/enroll-webauthn.js";
import * as confirmWebauthnModule from "./commands/confirm-webauthn.js";
import * as startWebauthnAuthModule from "./commands/start-webauthn-authentication.js";
import * as webauthnSignInModule from "./webauthn-sign-in.js";
import * as verifyFirstFactorModule from "./password/verify-first-factor.js";
import * as loginAttemptModule from "./login-attempt.js";
import * as signInCommandModule from "./commands/sign-in.js";
import * as signInModule from "./sign-in.js";
import * as changePasswordModule from "./commands/change-password.js";
import * as enrollMfaModule from "./commands/enroll-mfa.js";
import * as confirmMfaModule from "./commands/confirm-mfa.js";
import * as revokeSessionsModule from "./commands/revoke-sessions.js";
import * as issuePasswordResetModule from "./commands/issue-password-reset.js";
import * as resetPasswordCommandModule from "./commands/reset-password.js";
import * as requestPasswordResetModule from "./request-password-reset.js";
import * as resetPasswordModule from "./reset-password.js";
import * as issueInviteModule from "./commands/issue-invite.js";
import * as acceptInviteModule from "./commands/accept-invite.js";
import * as deactivateUserModule from "./commands/deactivate-user.js";
import * as setThemePreferenceModule from "./commands/set-theme-preference.js";
import * as inviteModule from "./invite.js";
import * as resetMailerModule from "./reset-mailer.js";
import * as rateLimitModule from "./rate-limit.js";
import * as errorsModule from "./errors.js";

export const auth = {
  ...configureModule,
  ...argon2Module,
  ...policyModule,
  ...tokenModule,
  ...sessionModule,
  ...totpModule,
  ...recoveryModule,
  ...secretSealModule,
  ...webauthnModule,
  ...webauthnChallengeModule,
  ...enrollWebauthnModule,
  ...confirmWebauthnModule,
  ...startWebauthnAuthModule,
  ...webauthnSignInModule,
  ...verifyFirstFactorModule,
  ...loginAttemptModule,
  ...signInCommandModule,
  ...signInModule,
  ...changePasswordModule,
  ...enrollMfaModule,
  ...confirmMfaModule,
  ...revokeSessionsModule,
  ...issuePasswordResetModule,
  ...resetPasswordCommandModule,
  ...requestPasswordResetModule,
  ...resetPasswordModule,
  ...issueInviteModule,
  ...acceptInviteModule,
  ...deactivateUserModule,
  ...setThemePreferenceModule,
  ...inviteModule,
  ...resetMailerModule,
  ...rateLimitModule,
  ...errorsModule,
} as const;
