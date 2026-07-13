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
  DEFAULT_RESET_TOKEN_TTL_MS,
  MFA_REQUIRED_ROLE_CODES,
  type AuthConfiguration,
  type SessionPolicy,
  type MfaPolicy,
  type LockoutPolicy,
} from "./configure.js";

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
  AUTH_NOT_CONFIGURED,
  invalidCredentialsError,
  mfaRequiredError,
  mfaInvalidError,
  sessionInvalidError,
  resetTokenInvalidError,
  passwordPolicyViolationError,
  passwordReusedError,
  mfaAlreadyEnrolledError,
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
import * as inviteModule from "./invite.js";
import * as resetMailerModule from "./reset-mailer.js";
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
  ...inviteModule,
  ...resetMailerModule,
  ...errorsModule,
} as const;
