// PasswordResetMailer — the delivery port for password-reset links.
//
// The reset token is a bearer secret: whoever holds it can set a new
// password. We therefore NEVER persist it in plaintext — not in
// `event_outbox`, not in `command_log`. It is stored only as a SHA-256
// hash (`password_reset_token.tokenHash`) and handed, once, to this
// port for transit to the user's inbox.
//
// The concrete adapter (wired at boot in apps/web / apps/worker) maps
// this to `@pharmax/notifications` `getNotificationChannel().send(...)`
// with a `USER_PASSWORD_RESET_V1` template — so auth stays decoupled
// from the transport SDK, exactly like `@pharmax/crypto`'s KmsAdapter.
// The default is a no-op so a misconfigured boot fails safe (no email)
// rather than throwing into the enumeration-safe request path.

export interface PasswordResetDelivery {
  /**
   * Which credential-setup flow this delivery is for. Both carry a
   * one-time link to set a password; the adapter picks subject/body/
   * template accordingly. `reset` for forgot-password, `invite` for a
   * new operator's initial setup.
   */
  readonly kind: "reset" | "invite";
  readonly email: string;
  readonly displayName: string;
  /** The raw token. Build the link from this; do not store or log it. */
  readonly rawToken: string;
  readonly expiresAt: Date;
  readonly organizationId: string;
  readonly userId: string;
}

export interface PasswordResetMailer {
  sendPasswordReset(input: PasswordResetDelivery): Promise<void>;
}

/**
 * Default mailer: does nothing. Deliberately silent (no token logging).
 * Boot wires the real adapter; if it doesn't, reset emails simply are
 * not sent — which is safe (no leak) though non-functional.
 */
export const NOOP_PASSWORD_RESET_MAILER: PasswordResetMailer = Object.freeze({
  async sendPasswordReset(): Promise<void> {
    // Intentionally empty.
  },
});
