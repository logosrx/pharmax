// Additional Authenticated Data (AAD) canonical encoding.
//
// AAD is the security feature that makes envelope encryption resistant
// to "move ciphertext between rows" attacks. AES-256-GCM mixes the AAD
// into its authentication tag — an attacker who copies the ciphertext
// from `patient.row_A.first_name` into `patient.row_B.first_name`
// gets a tag-verification failure on decrypt, because the AAD that
// was committed at encrypt-time included `recordId = row_A`.
//
// Why a separate module and not "just JSON.stringify the binding":
//   - Determinism matters. The exact bytes that go into AAD must be
//     reproducible — encrypt and decrypt must produce the same bytes
//     for the same record. JSON object key order is not guaranteed
//     by `Object.keys` across runtimes for objects built from
//     different sources (literal vs spread vs computed-key). We
//     enforce sort order explicitly here.
//   - Versioning matters. If we ever add a new AAD field, all old
//     ciphertexts must keep decrypting. We embed a schema version
//     so we can dispatch the encoding by version.
//
// Format (v1):
//
//     b"crypto.v1\x00{column}\x00{recordId}\x00{table}\x00{tenantId}"
//
// Sorted ASCII field-name keys, NUL-separated, ASCII-encoded.
// `\x00` is the conventional record separator for canonical encodings
// and is guaranteed not to appear in legitimate ULIDs, table names,
// or column names. We validate that constraint at encode time.

import { cryptoValidationError } from "./errors.js";

/** Stable identifier — change this and EVERY previously-encrypted row needs migration. */
export const AAD_VERSION = "crypto.v1" as const;

/** The set of fields that bind a ciphertext to a record. */
export interface RecordBinding {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly recordId: string;
}

const NUL = "\x00";
const FIELDS_SORTED: ReadonlyArray<keyof RecordBinding> = [
  "column",
  "recordId",
  "table",
  "tenantId",
];

/**
 * Encodes the record binding into the canonical AAD byte string.
 *
 * Throws `ValidationError(CRYPTO_VALIDATION)` if any field is empty
 * or contains the NUL separator. (A NUL in a tenant id is impossible
 * in practice; we fail loudly anyway because a successful encode-then-
 * fail-decode would otherwise be silent corruption.)
 */
export function encodeAad(binding: RecordBinding): Buffer {
  for (const field of FIELDS_SORTED) {
    validateField(field, binding[field]);
  }
  const parts: string[] = [AAD_VERSION];
  for (const field of FIELDS_SORTED) {
    parts.push(binding[field]);
  }
  return Buffer.from(parts.join(NUL), "utf8");
}

/**
 * Returns true iff two bindings encode to the same AAD bytes. Useful
 * for unit tests and for verifying that a "rebind" request would
 * produce a different ciphertext.
 */
export function bindingsEqual(a: RecordBinding, b: RecordBinding): boolean {
  return encodeAad(a).equals(encodeAad(b));
}

function validateField(name: keyof RecordBinding, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw cryptoValidationError({
      field: name,
      reason: "must be a non-empty string",
    });
  }
  if (value.includes(NUL)) {
    throw cryptoValidationError({
      field: name,
      reason: "must not contain the NUL separator",
    });
  }
}
