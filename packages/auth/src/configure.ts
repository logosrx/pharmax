// Process-level authentication configuration (ADR-0030).
//
// One process, one configuration. Wired at boot (apps/web, apps/worker,
// seed) with the Argon2id hasher (pepper unwrapped from KMS), the
// password policy, session TTLs, and the MFA floor. Reading before
// configuration throws `InternalError(AUTH_NOT_CONFIGURED)` — silence
// would mean an auth path running without the intended KDF/pepper,
// which is the worst possible failure (a password hashed without the
// pepper is a permanent liability). Same singleton pattern as
// `configureCrypto` / `configureRbac`.

import { runtime } from "@pharmax/platform-core";
import type { clock } from "@pharmax/platform-core";
import { ELEVATED_ROLE_CODES } from "@pharmax/rbac";

import { authNotConfiguredError } from "./errors.js";
import { createSimpleWebAuthnAdapter, type WebAuthnAdapter } from "./mfa/webauthn.js";
import type { PasswordHasher } from "./password/hasher.js";
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "./password/policy.js";
import { InMemoryRateLimiter, type RateLimiter, type RateLimitRule } from "./rate-limit.js";
import { NOOP_PASSWORD_RESET_MAILER, type PasswordResetMailer } from "./reset-mailer.js";

export interface SessionPolicy {
  /** Cookie name for the opaque session token. */
  readonly cookieName: string;
  /** Bytes of entropy in the opaque session token (>= 32 = 256 bits). */
  readonly tokenBytes: number;
  /**
   * Sliding idle timeout. A session with no activity for this long is
   * revoked (HIPAA automatic logoff, §164.312(a)(2)(iii)).
   */
  readonly idleTtlMs: number;
  /** Absolute cap regardless of activity. Forces periodic re-auth. */
  readonly absoluteTtlMs: number;
}

export interface LockoutPolicy {
  /** Failed attempts (per email within the window) that trigger lockout. */
  readonly maxFailures: number;
  /** Rolling window for counting failures. */
  readonly windowMs: number;
}

export interface MfaPolicy {
  /** Label shown in authenticator apps (the TOTP `issuer`). */
  readonly issuer: string;
  /** Allowed ± period drift when verifying a TOTP (1 = ±30s). */
  readonly totpWindow: number;
  /** How many single-use recovery codes to mint at enrollment. */
  readonly recoveryCodeCount: number;
  /**
   * Role codes for which MFA is mandatory at the platform layer — the
   * ADR-0025 floor, now enforced in-engine. Customers may require MFA
   * more broadly; they cannot go below this.
   */
  readonly requiredRoleCodes: ReadonlySet<string>;
}

export interface WebAuthnPolicy {
  /** User-visible relying-party name shown in authenticator prompts. */
  readonly rpName: string;
  /** How long a minted ceremony challenge stays redeemable. */
  readonly challengeTtlMs: number;
  /** Ceremony implementation (ADR-0036 port). Fakeable in tests. */
  readonly adapter: WebAuthnAdapter;
}

/**
 * The privileged-role MFA floor (ADR-0025), now derived from the single
 * `ELEVATED_ROLE_CODES` definition in `@pharmax/rbac`.
 *
 * It used to be a hand-written `{OrgAdmin, BillingManager}`, which was
 * narrower than the platform's own definition of "elevated" and
 * narrower in the worst direction. `Pharmacist` and
 * `PharmacistInCharge` hold the broadest PHI access in the product —
 * PV1, final verification, and the full patient record — and could
 * sign in with a password alone. The compliance probes had it right
 * all along: `mfa-elevated-role-enrollment` and
 * `elevated-session-mfa-satisfied` both evaluate against the elevated
 * set, so the codebase was already reporting a gap that the engine was
 * not configured to close.
 *
 * Deriving rather than duplicating means the next role added to the
 * elevated set gets MFA automatically, instead of getting it whenever
 * someone remembers this file exists.
 *
 * Customers may require MFA more broadly; they cannot go below this.
 */
export const MFA_REQUIRED_ROLE_CODES: ReadonlySet<string> = Object.freeze(
  new Set(ELEVATED_ROLE_CODES)
);

/** HIPAA-conscious session defaults: 30-min idle, 12-hour absolute cap. */
export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  cookieName: "pharmax_session",
  tokenBytes: 32,
  idleTtlMs: 30 * 60 * 1000,
  absoluteTtlMs: 12 * 60 * 60 * 1000,
});

export const DEFAULT_MFA_POLICY: MfaPolicy = Object.freeze({
  issuer: "Pharmax",
  totpWindow: 1,
  recoveryCodeCount: 10,
  requiredRoleCodes: MFA_REQUIRED_ROLE_CODES,
});

/** Default lockout: 10 failed attempts per email in 15 minutes. */
export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = Object.freeze({
  maxFailures: 10,
  windowMs: 15 * 60 * 1000,
});

export interface SignInRateLimitPolicy {
  /** Burst cap per client IP. */
  readonly perIp: RateLimitRule;
  /** Burst cap per target email. */
  readonly perEmail: RateLimitRule;
}

/**
 * Default sign-in burst limits (short window, in front of the durable
 * DB lockout): 20 attempts/min per IP, 10 attempts/min per email.
 */
export const DEFAULT_SIGN_IN_RATE_LIMIT: SignInRateLimitPolicy = Object.freeze({
  perIp: Object.freeze({ limit: 20, windowMs: 60 * 1000 }),
  perEmail: Object.freeze({ limit: 10, windowMs: 60 * 1000 }),
});

/**
 * Burst limit for the PUBLIC credential-setting entry points
 * (`acceptInvite`, `resetPassword`) — see `../credential-setup-limit.ts`.
 *
 * `perIp` only, and that is a constraint rather than an omission: a
 * token-consuming route has no identity to key on until the token
 * resolves, and resolving it first is what would turn the limiter into
 * an existence oracle. There is deliberately no per-account dimension
 * and no durable lockout ledger here.
 */
export interface CredentialSetupRateLimitPolicy {
  /** Burst cap per client IP, across all credential-setup entry points. */
  readonly perIp: RateLimitRule;
}

/**
 * Default credential-setup burst limit: 20 requests/min per IP.
 *
 * Matched to `DEFAULT_SIGN_IN_RATE_LIMIT.perIp` rather than to the
 * tighter portal-setup route rule, because these endpoints share the
 * same shared-egress problem sign-in has: a pharmacy behind one NAT
 * gateway onboards a whole shift from a single address, and every
 * refusal here reads to the operator as "your setup link is broken".
 * 20/min still caps a single host at 20 breach-corpus lookups a minute,
 * which is the amplification this limit exists to bound (R-026).
 */
export const DEFAULT_CREDENTIAL_SETUP_RATE_LIMIT: CredentialSetupRateLimitPolicy = Object.freeze({
  perIp: Object.freeze({ limit: 20, windowMs: 60 * 1000 }),
});

/** WebAuthn ceremony defaults: 5-minute challenge TTL. */
export const DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface AuthConfiguration {
  readonly clock: clock.Clock;
  readonly hasher: PasswordHasher;
  readonly password: PasswordPolicy;
  readonly session: SessionPolicy;
  readonly mfa: MfaPolicy;
  readonly webauthn: WebAuthnPolicy;
  readonly lockout: LockoutPolicy;
  /** Sign-in burst limits (in front of the durable DB lockout). */
  readonly signInRateLimit: SignInRateLimitPolicy;
  /** Burst limit for the public credential-setting entry points. */
  readonly credentialSetupRateLimit: CredentialSetupRateLimitPolicy;
  /** Distributed rate limiter. Defaults to an in-process limiter. */
  readonly rateLimiter: RateLimiter;
  /** How long a password-reset token is valid. */
  readonly resetTokenTtlMs: number;
  /** Delivery port for reset links. Defaults to a safe no-op. */
  readonly passwordResetMailer: PasswordResetMailer;
}

/** Password-reset tokens are valid for 1 hour by default. */
export const DEFAULT_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// globalThis-backed so the boot bundle and the route bundles share ONE
// configuration despite webpack giving each its own module copy.
const box = runtime.globalSingletonBox<AuthConfiguration>("pharmax:auth:config");

/** Wire the process-wide auth configuration. Call once at boot. */
export function configureAuth(config: AuthConfiguration): void {
  box.value = Object.freeze({ ...config });
}

/** Returns the auth configuration. Throws if `configureAuth` was never called. */
export function getAuthConfiguration(): AuthConfiguration {
  if (box.value === null) {
    throw authNotConfiguredError();
  }
  return box.value;
}

/** Test-only: reset the configuration. Production code MUST NOT call this. */
export function resetAuthConfigurationForTests(): void {
  box.value = null;
}

/** Convenience builder for the common case (defaults + injected hasher/clock). */
export function buildAuthConfiguration(input: {
  readonly clock: clock.Clock;
  readonly hasher: PasswordHasher;
  readonly password?: Partial<PasswordPolicy>;
  readonly session?: Partial<SessionPolicy>;
  readonly mfa?: Partial<MfaPolicy>;
  readonly webauthn?: Partial<WebAuthnPolicy>;
  readonly lockout?: Partial<LockoutPolicy>;
  readonly resetTokenTtlMs?: number;
  readonly passwordResetMailer?: PasswordResetMailer;
  readonly signInRateLimit?: Partial<SignInRateLimitPolicy>;
  readonly credentialSetupRateLimit?: Partial<CredentialSetupRateLimitPolicy>;
  readonly rateLimiter?: RateLimiter;
}): AuthConfiguration {
  return Object.freeze({
    clock: input.clock,
    hasher: input.hasher,
    password: Object.freeze({ ...DEFAULT_PASSWORD_POLICY, ...input.password }),
    session: Object.freeze({ ...DEFAULT_SESSION_POLICY, ...input.session }),
    mfa: Object.freeze({ ...DEFAULT_MFA_POLICY, ...input.mfa }),
    webauthn: Object.freeze({
      rpName: input.webauthn?.rpName ?? DEFAULT_MFA_POLICY.issuer,
      challengeTtlMs: input.webauthn?.challengeTtlMs ?? DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS,
      adapter: input.webauthn?.adapter ?? createSimpleWebAuthnAdapter(),
    }),
    lockout: Object.freeze({ ...DEFAULT_LOCKOUT_POLICY, ...input.lockout }),
    signInRateLimit: Object.freeze({ ...DEFAULT_SIGN_IN_RATE_LIMIT, ...input.signInRateLimit }),
    credentialSetupRateLimit: Object.freeze({
      ...DEFAULT_CREDENTIAL_SETUP_RATE_LIMIT,
      ...input.credentialSetupRateLimit,
    }),
    rateLimiter: input.rateLimiter ?? new InMemoryRateLimiter(),
    resetTokenTtlMs: input.resetTokenTtlMs ?? DEFAULT_RESET_TOKEN_TTL_MS,
    passwordResetMailer: input.passwordResetMailer ?? NOOP_PASSWORD_RESET_MAILER,
  });
}
