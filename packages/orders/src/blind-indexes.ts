// Prescription blind-index helpers.
//
// Mirrors `@pharmax/patients::PATIENT_BLIND_INDEX`. The binding comes
// from the typed registry in `@pharmax/database/phi` rather than a
// literal, because a mistyped purpose computes a different HMAC key
// and the failure mode is silent: writes succeed, lookups return
// nothing, and nobody notices until a pharmacist cannot find an Rx by
// number.
//
// `rxNumber` is not PHI on its own — it is an internal identifier —
// but it is blind-indexed anyway. It appears on labels and in call
// logs, and joined to a patient row it identifies a person's
// medication, so the search path should not require a plaintext
// column to exist.

import { blindIndex, type BlindIndexInput } from "@pharmax/crypto";
import { phi } from "@pharmax/database";

const PRESCRIPTION_BLIND_INDEX_BINDINGS = phi.PRESCRIPTION_BLIND_INDEX_BINDINGS;

export const PRESCRIPTION_BLIND_INDEX = {
  /**
   * Blind index for an Rx number. Returns `null` when the value
   * normalizes to empty, so a search caller can drop the filter
   * rather than match every NULL row.
   */
  async rxNumber(args: { tenantId: string; value: string }): Promise<string | null> {
    return blindIndex(toBindingInput(PRESCRIPTION_BLIND_INDEX_BINDINGS.rxNumber.purpose, args));
  },
} as const;

function toBindingInput(
  purpose: string,
  args: { tenantId: string; value: string }
): BlindIndexInput {
  const dot = purpose.indexOf(".");
  if (dot === -1) {
    throw new Error(
      `@pharmax/orders: invalid blind-index purpose ${JSON.stringify(purpose)} (expected "table.column")`
    );
  }
  return {
    value: args.value,
    binding: {
      tenantId: args.tenantId,
      table: purpose.slice(0, dot),
      column: purpose.slice(dot + 1),
    },
  };
}
