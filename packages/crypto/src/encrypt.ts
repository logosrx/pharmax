// encryptField / decryptField — the high-level PHI field cipher.
//
// One call per field. Internally:
//
//   1. Ask the configured `KmsAdapter` for a fresh DEK + KEK wrap.
//   2. Compute the canonical AAD bytes from `{tenantId, table, column,
//      recordId}`.
//   3. AES-256-GCM(plaintext, key = DEK, iv = random 12 bytes, AAD).
//   4. Zero the DEK in memory.
//   5. Pack `{v, alg, kek, wDek, iv, ct, tag}` into a `CiphertextEnvelope`.
//
// Decrypt is the mirror:
//
//   1. Parse the envelope (rejects malformed).
//   2. Compute the AAD bytes from the SAME record binding the caller
//      claims this envelope belongs to.
//   3. Unwrap the DEK via KMS.
//   4. AES-256-GCM-decrypt. A tag-verification failure here is the
//      AAD-mismatch signal — we surface as `AuthorizationError(AAD_MISMATCH)`.
//
// The DEK is generated PER ENCRYPT CALL (not per record, not per
// column). This matches AWS KMS's `GenerateDataKey` semantics and
// makes per-record crypto-shred a simple `column = NULL` operation
// (the wrapped DEK is gone, the ciphertext is unrecoverable).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { encodeAad, type RecordBinding } from "./aad.js";
import { getCryptoConfiguration } from "./configure.js";
import { aadMismatchError, decryptFailedError, cryptoValidationError } from "./errors.js";
import { type CiphertextEnvelope, ENVELOPE_VERSION, parseEnvelope } from "./envelope.js";

const FIELD_IV_BYTES = 12;

/**
 * Encrypts `plaintext` and returns the storage-ready envelope. The
 * caller is responsible for persisting the envelope as a `Json`
 * column. The plaintext is read once and never retained.
 */
export async function encryptField(input: {
  readonly plaintext: string;
  readonly binding: RecordBinding;
}): Promise<CiphertextEnvelope> {
  if (typeof input.plaintext !== "string") {
    throw cryptoValidationError({ field: "plaintext", reason: "must be a string" });
  }
  const config = getCryptoConfiguration();
  const aad = encodeAad(input.binding);

  const { kid, plaintextDek, wrappedDek } = await config.kms.generateDataKey({
    tenantId: input.binding.tenantId,
  });
  try {
    const iv = randomBytes(FIELD_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", plaintextDek, iv);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(Buffer.from(input.plaintext, "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: ENVELOPE_VERSION,
      alg: "AES-256-GCM",
      kek: kid,
      wDek: toBase64Url(wrappedDek),
      iv: toBase64Url(iv),
      ct: toBase64Url(ct),
      tag: toBase64Url(tag),
    };
  } finally {
    plaintextDek.fill(0);
  }
}

/**
 * Decrypts an envelope, verifying the record binding. The caller
 * MUST pass the same `binding` that was used to encrypt — passing a
 * different binding (intentionally or accidentally) yields
 * `AuthorizationError(AAD_MISMATCH)`.
 */
export async function decryptField(input: {
  readonly envelope: unknown;
  readonly binding: RecordBinding;
}): Promise<string> {
  const env = parseEnvelope(input.envelope);
  const config = getCryptoConfiguration();
  const aad = encodeAad(input.binding);

  const wrappedDek = fromBase64Url(env.wDek);
  const iv = fromBase64Url(env.iv);
  const ct = fromBase64Url(env.ct);
  const tag = fromBase64Url(env.tag);

  if (iv.length !== FIELD_IV_BYTES) {
    throw decryptFailedError({
      reason: `iv length ${iv.length} != ${FIELD_IV_BYTES}`,
      tenantId: input.binding.tenantId,
      table: input.binding.table,
      column: input.binding.column,
      recordId: input.binding.recordId,
    });
  }

  const plaintextDek = await config.kms.unwrapDataKey({
    tenantId: input.binding.tenantId,
    kid: env.kek,
    wrappedDek,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", plaintextDek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    } catch {
      // GCM authentication failure. The most likely cause by far is
      // an AAD mismatch — a ciphertext from a different (tenant,
      // table, column, recordId) being decrypted into this one. We
      // attribute it to AAD here. The next-most-likely cause is
      // ciphertext corruption, which would also throw here; both
      // surface as the same code because we cannot tell them apart
      // from outside (and the security response is the same: refuse
      // the read, alert).
      throw aadMismatchError({
        tenantId: input.binding.tenantId,
        table: input.binding.table,
        column: input.binding.column,
        recordId: input.binding.recordId,
      });
    }
  } finally {
    plaintextDek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Base64url helpers (no padding) — keeps the envelope JSON compact
// and safe to embed in URLs / Prisma `Json` columns without
// double-encoding.
// ---------------------------------------------------------------------------

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
