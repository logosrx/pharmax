// TOTP primitives (RFC 6238) over the `otpauth` library.
//
// Pure and stateless: generate a secret, build the provisioning URI for
// the QR code, and verify a submitted code with a configurable drift
// window. Persistence (sealing the secret, the enrollment row lifecycle)
// lives in the MFA commands; this module only does the crypto-time math.

import { Secret, TOTP } from "otpauth";

// RFC 4226 recommends >= 160-bit shared secrets.
const TOTP_SECRET_BYTES = 20;
const TOTP_ALGORITHM = "SHA1"; // Authenticator-app interop standard.
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

/** Generate a fresh base32 TOTP secret (160-bit). */
export function generateTotpSecretBase32(): string {
  return new Secret({ size: TOTP_SECRET_BYTES }).base32;
}

function buildTotp(input: {
  readonly secretBase32: string;
  readonly issuer: string;
  readonly accountName: string;
}): TOTP {
  return new TOTP({
    issuer: input.issuer,
    label: input.accountName,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(input.secretBase32),
  });
}

/**
 * Build the `otpauth://totp/...` provisioning URI to render as a QR
 * code during enrollment. Contains the secret — treat as sensitive;
 * never log it.
 */
export function buildTotpKeyUri(input: {
  readonly secretBase32: string;
  readonly issuer: string;
  readonly accountName: string;
}): string {
  return buildTotp(input).toString();
}

/**
 * Generate the code an authenticator app would show right now.
 *
 * Exists for callers that must PROVE possession of a secret rather than
 * check one — the E2E harness signing in as a seeded operator whose role
 * sits on the MFA floor. It lives beside `verifyTotpCode` so both sides
 * read the algorithm, digit count and period from one place; a harness
 * that rebuilt those constants for itself would keep passing while
 * drifting away from what production actually accepts.
 *
 * Never call this to satisfy a real user's second factor: a code this
 * process can mint is not a factor the operator holds.
 */
export function generateTotpCode(input: {
  readonly secretBase32: string;
  /**
   * Provisioning-URI labels. Optional because RFC 6238 derives the code
   * from the secret and the time only — these reach the HMAC through
   * neither, so a caller holding just a secret does not have to
   * reconstruct the account name enrollment happened to use.
   */
  readonly issuer?: string;
  readonly accountName?: string;
}): string {
  return buildTotp({
    secretBase32: input.secretBase32,
    issuer: input.issuer ?? "Pharmax",
    accountName: input.accountName ?? "totp",
  }).generate();
}

/**
 * Verify a submitted TOTP code. `window` is the ± number of 30s periods
 * tolerated for clock drift (from `MfaPolicy.totpWindow`). Whitespace is
 * stripped so "123 456" and "123456" both work. Returns true iff the
 * code validates within the window.
 */
export function verifyTotpCode(input: {
  readonly secretBase32: string;
  readonly issuer: string;
  readonly accountName: string;
  readonly token: string;
  readonly window: number;
}): boolean {
  const normalized = input.token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const totp = buildTotp(input);
  const delta = totp.validate({ token: normalized, window: input.window });
  return delta !== null;
}
