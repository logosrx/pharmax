// Completing the second factor during an E2E sign-in.
//
// Operators whose role sits on the platform MFA floor
// (`ELEVATED_ROLE_CODES`) cannot sign in with a password alone, and the
// golden path needs a Pharmacist — a floor role — for PV1 and final
// verification. So the suite has to answer a real TOTP challenge.
//
// It answers it honestly: scripts/e2e-seed.ts enrolls a genuine
// authenticator (secret sealed with the production envelope cipher) and
// hands the secret over through the gitignored state file. Nothing here
// weakens the policy — `SignIn` opens the sealed secret and verifies the
// code through its own unmodified path, exactly as it would for a
// pharmacist holding a phone.
//
// The code is minted by the SAME module that verifies it, so the harness
// cannot drift onto a different algorithm, digit count or period and
// then disagree with the server about what a valid code looks like.

import { readFileSync } from "node:fs";
import process from "node:process";

import { generateTotpCode } from "../packages/auth/src/mfa/totp.js";

import { E2E_STATE_FILE, type E2ESeedState } from "./env";

/**
 * How long to wait for the challenge to render. It appears only after
 * `POST /api/auth/sign-in` answers MFA_REQUIRED, so this waits out a
 * request — and on CI a cold `next dev` compile of that route — rather
 * than a paint. Same shape as the sign-in budgets in the specs.
 *
 * Deliberately ONE ATTEMPT's worth, not a whole budget: the callers wrap
 * sign-in in `toPass`, because a click landing before React hydrates
 * submits the form natively and no challenge ever comes. Waiting the
 * caller's full budget here would starve that retry — which is exactly
 * how the first version of this helper failed — so it gives up early and
 * lets the retry re-drive the form, by which time the route is compiled.
 */
const MFA_FIELD_TIMEOUT_MS = process.env["CI"] !== undefined ? 60_000 : 20_000;

/** Minimal surface needed from a Playwright `Page` — keeps this importable by any spec. */
interface MfaPage {
  getByLabel(name: string): {
    waitFor(options: { state: "visible"; timeout: number }): Promise<void>;
    fill(value: string): Promise<void>;
  };
  getByRole(role: "button", options: { name: string }): { click(): Promise<void> };
}

function seedState(): E2ESeedState {
  return JSON.parse(readFileSync(E2E_STATE_FILE, "utf8")) as E2ESeedState;
}

/**
 * True when the seed enrolled a second factor for this operator, i.e.
 * their role is on the MFA floor. Read from the seed's own output rather
 * than from a role list in the suite, so the specs follow a change to
 * `ELEVATED_ROLE_CODES` without being edited.
 */
export function requiresSecondFactor(email: string): boolean {
  return seedState().totpSecrets[email] !== undefined;
}

/**
 * Answer the TOTP challenge for `email`, if that operator has one.
 *
 * Call it after submitting email + password and before waiting for the
 * dashboard. A no-op for below-floor operators, so both sign-in shapes
 * go through one code path.
 *
 * The code is generated at submit time, inside the caller's retry loop:
 * a TOTP is only valid for its 30-second step, so minting it once
 * outside the retry would hand later attempts an expired code and turn
 * a slow runner into an authentication failure.
 */
export async function completeSecondFactor(page: MfaPage, email: string): Promise<void> {
  const secretBase32 = seedState().totpSecrets[email];
  if (secretBase32 === undefined) return;

  const field = page.getByLabel("Authentication code");
  await field.waitFor({ state: "visible", timeout: MFA_FIELD_TIMEOUT_MS });
  await field.fill(generateTotpCode({ secretBase32 }));
  // The submit button relabels itself once the challenge is showing.
  await page.getByRole("button", { name: "Verify" }).click();
}
