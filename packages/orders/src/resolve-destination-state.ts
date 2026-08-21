// Derive an order's destination state from the patient's encrypted
// address.
//
// Called once, at intake, to populate `order.destinationState`. That
// column exists so ship-to-state licensure (G-2) can be enforced by
// every ship-committing command — `CreateShipment` takes a tracking
// number and never sees an address, and its own file documents it as
// the deliberate override for `PurchaseShipmentLabel`'s address
// validation, so enforcing only where the address is available leaves
// the control bypassable.
//
// WHY PLAINTEXT IS ACCEPTABLE HERE. HIPAA Safe Harbor
// §164.514(b)(2)(i)(B) covers geographic subdivisions SMALLER than a
// state — city, county, ZIP. The state itself is excluded. That is why
// this one field may be denormalized and `cityEnc` / `postalCodeEnc`
// may not.
//
// FAILURE IS NULL, NOT AN EXCEPTION. A patient with no recorded state,
// or whose envelope cannot be opened (a crypto-shredded record), yields
// null. Null means "we do not know where this is going", and the ship
// gate refuses on it when the site enforces — so the safe outcome is
// reached by refusing later rather than by failing intake now. Throwing
// here would make a shredded patient's in-flight order un-creatable,
// which is a worse failure than one that surfaces at the point the
// answer actually matters.

import { decryptField } from "@pharmax/crypto";
import { geo } from "@pharmax/platform-core";
import type { Prisma } from "@pharmax/database";

export interface ResolveDestinationStateInput {
  /** The patient's `stateEnc` envelope column, as loaded. */
  readonly stateEnc: Prisma.JsonValue | null;
  readonly organizationId: string;
  readonly patientId: string;
}

export async function resolveDestinationState(
  input: ResolveDestinationStateInput
): Promise<string | null> {
  if (input.stateEnc === null) return null;

  try {
    const plaintext = await decryptField({
      envelope: input.stateEnc,
      binding: {
        tenantId: input.organizationId,
        // The binding column is the UNSUFFIXED name — `state`, not
        // `stateEnc`. Getting this wrong fails AAD verification rather
        // than returning wrong data, but it fails every time.
        table: "patient",
        column: "state",
        recordId: input.patientId,
      },
    });
    // Normalized against the real jurisdiction set, not a 2-letter
    // regex: an unrecognized code would be stored, match no authorized
    // state, and refuse every shipment for reasons nobody could see.
    return plaintext === null ? null : geo.normalizeJurisdictionCode(plaintext);
  } catch {
    // Deliberately swallowed — see the header. The order is created
    // without a destination and the ship gate refuses it if the site
    // enforces.
    return null;
  }
}
