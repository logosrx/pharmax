// Sealing / opening of TOTP shared secrets.
//
// The TOTP secret is PHI-adjacent credential material — a stolen secret
// defeats the second factor. It is stored sealed with the platform
// envelope cipher (`@pharmax/crypto`, AES-256-GCM under a KMS-wrapped
// DEK), never in plaintext. The AAD binds the ciphertext to
// (organization, table, column, user), so a sealed secret cannot be
// lifted from one user's row and replayed under another's.
//
// The `mfa_enrollment.secretCiphertext` column is TEXT, so the envelope
// object is JSON-stringified for storage and parsed back on open.

import { decryptField, encryptField, serializeEnvelope, type RecordBinding } from "@pharmax/crypto";

const TABLE = "mfa_enrollment";
const COLUMN = "secretCiphertext";

function bindingFor(input: {
  readonly organizationId: string;
  readonly userId: string;
}): RecordBinding {
  return {
    tenantId: input.organizationId,
    table: TABLE,
    column: COLUMN,
    recordId: input.userId,
  };
}

/** Seal a base32 TOTP secret into the storable ciphertext string. */
export async function sealTotpSecret(input: {
  readonly secretBase32: string;
  readonly organizationId: string;
  readonly userId: string;
}): Promise<string> {
  const envelope = await encryptField({
    plaintext: input.secretBase32,
    binding: bindingFor(input),
  });
  return JSON.stringify(serializeEnvelope(envelope));
}

/** Open a sealed TOTP secret back to base32. Throws on AAD mismatch. */
export async function openTotpSecret(input: {
  readonly ciphertext: string;
  readonly organizationId: string;
  readonly userId: string;
}): Promise<string> {
  const parsed: unknown = JSON.parse(input.ciphertext);
  return decryptField({ envelope: parsed, binding: bindingFor(input) });
}
