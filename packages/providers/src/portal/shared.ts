// Shared pieces of the provider-portal auth family (ADR-0033,
// slice 2): error codes, the setup-token TTL, and the mailer port
// through which one-time setup links leave the process.
//
// Portal principals are a SEPARATE model pair from the operator
// `User`/`AuthSession` (ADR-0033 §4). This module reuses the
// `@pharmax/auth` primitives (token minting/hashing, Argon2id
// hasher via `getAuthConfiguration`) but never touches operator
// tables.

// --- Error codes -----------------------------------------------------------

/** Setup token unknown, consumed, expired, or account not PENDING_SETUP. */
export const PORTAL_SETUP_TOKEN_INVALID = "PORTAL_SETUP_TOKEN_INVALID" as const;
/** Portal account not found (by id) for token issuance. */
export const PORTAL_ACCOUNT_NOT_FOUND = "PORTAL_ACCOUNT_NOT_FOUND" as const;
/** Token issuance attempted against a DISABLED account. */
export const PORTAL_ACCOUNT_DISABLED = "PORTAL_ACCOUNT_DISABLED" as const;
/** Password change rejected: current password wrong (or account not
 *  in a password-changeable state — one opaque code, no enumeration). */
export const PORTAL_CURRENT_PASSWORD_INVALID = "PORTAL_CURRENT_PASSWORD_INVALID" as const;

// --- Setup-token TTL -------------------------------------------------------

/**
 * Portal setup links are valid for 7 days — the same window as an
 * operator invitation (`DEFAULT_INVITE_TTL_MS`): the applicant may
 * not be at their desk the moment approval lands.
 */
export const PORTAL_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- Mailer port -------------------------------------------------------------

/**
 * Delivery payload for a portal credential-setup link. The raw token
 * is a bearer secret: it is never persisted in plaintext (only its
 * SHA-256 hash, `portal_setup_token.tokenHash`) and never appears in
 * command_log / event_outbox — it exists only here, in transit to
 * the prescriber's office inbox.
 */
export interface PortalSetupDelivery {
  readonly email: string;
  /** Prescriber display name for the email body ("Dr. Chen"). */
  readonly displayName: string;
  /** The raw token. Build the setup link from this; never store or log it. */
  readonly rawToken: string;
  readonly expiresAt: Date;
  readonly organizationId: string;
  readonly portalAccountId: string;
}

export interface PortalSetupMailer {
  sendPortalSetup(input: PortalSetupDelivery): Promise<void>;
}

/**
 * Default mailer: does nothing, silently (no token logging). Callers
 * (web ops route, worker proofing drain) wire a real adapter; if they
 * don't, setup links simply are not sent — safe (no leak) though
 * non-functional, the same fail-safe posture as
 * `NOOP_PASSWORD_RESET_MAILER`.
 */
export const NOOP_PORTAL_SETUP_MAILER: PortalSetupMailer = Object.freeze({
  async sendPortalSetup(): Promise<void> {
    // Intentionally empty.
  },
});
