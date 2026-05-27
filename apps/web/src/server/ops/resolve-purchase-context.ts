// Auto-purchase context resolver — server-side helper that
// assembles every input PurchaseShipmentLabel needs from an order
// id alone:
//
//   - fromAddress: the order's PharmacySite address (must be
//     populated via /ops/admin/sites).
//   - toAddress: the order's patient address (envelope-encrypted
//     PHI; we decrypt the seven address-bearing columns here, same
//     pattern as get-order-detail.ts).
//   - parcel: a conservative default (3" × 3" × 3" cube, 8 oz)
//     until per-product packaging metadata lands. The operator
//     can override on the form.
//   - availableProviders: the providers for which the org has an
//     ACTIVE carrier credential.
//
// Failure modes are TYPED so the operator gets actionable flash
// errors instead of a generic 5xx:
//   - ORDER_NOT_FOUND
//   - SITE_ADDRESS_INCOMPLETE — fix via /ops/admin/sites
//   - PATIENT_ADDRESS_INCOMPLETE — patient row is missing one or
//     more required address fields; fix via patient admin (future
//     slice) or by escalating to ops.
//   - PATIENT_ADDRESS_DECRYPT_FAILED — KMS / envelope issue;
//     surfaces the operator user id for incident triage.
//   - NO_ACTIVE_CARRIER_CREDENTIAL — fix via /ops/admin/carriers.
//
// PHI handling: the resolved toAddress is plaintext PHI in memory
// for the duration of the dispatch. It is passed to the command
// (which redacts both addresses from command_log.requestPayload)
// and to the carrier adapter (which must transmit them to the
// carrier API in clear bytes — that's the whole point). We do NOT
// log the addresses anywhere on the route surface.

import "server-only";

import { decryptField } from "@pharmax/crypto";
import { prisma, type ShippingProvider, type ShipmentCarrier } from "@pharmax/database";

export const RESOLVE_PURCHASE_ORDER_NOT_FOUND = "ORDER_NOT_FOUND";
export const RESOLVE_PURCHASE_SITE_ADDRESS_INCOMPLETE = "SITE_ADDRESS_INCOMPLETE";
export const RESOLVE_PURCHASE_PATIENT_ADDRESS_INCOMPLETE = "PATIENT_ADDRESS_INCOMPLETE";
export const RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED = "PATIENT_ADDRESS_DECRYPT_FAILED";
export const RESOLVE_PURCHASE_NO_ACTIVE_CARRIER_CREDENTIAL = "NO_ACTIVE_CARRIER_CREDENTIAL";

export interface ResolvedAddress {
  readonly name: string;
  readonly street1: string;
  readonly street2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
  readonly phone?: string;
}

export interface ResolvedParcel {
  readonly lengthInches: number;
  readonly widthInches: number;
  readonly heightInches: number;
  readonly weightOunces: number;
}

export interface ResolvedPurchaseContext {
  readonly orderId: string;
  readonly fromAddress: ResolvedAddress;
  readonly toAddress: ResolvedAddress;
  readonly parcel: ResolvedParcel;
  readonly availableProviders: ReadonlyArray<ShippingProvider>;
}

export type ResolvePurchaseContextResult =
  | { readonly ok: true; readonly context: ResolvedPurchaseContext }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Default parcel dims for a vial pack. Conservative — a 3" cube
 * at 8 oz fits in every USPS / UPS / FedEx domestic rate tier.
 * Override at the form layer once per-product packaging metadata
 * lands (future slice).
 */
const DEFAULT_PARCEL: ResolvedParcel = Object.freeze({
  lengthInches: 3,
  widthInches: 3,
  heightInches: 3,
  weightOunces: 8,
});

async function decryptToString(input: {
  envelope: unknown;
  binding: { tenantId: string; table: string; column: string; recordId: string };
}): Promise<{ value: string | null; ok: boolean }> {
  if (input.envelope === null || input.envelope === undefined) {
    return { value: null, ok: true };
  }
  try {
    const plain = await decryptField({
      envelope: input.envelope as Parameters<typeof decryptField>[0]["envelope"],
      binding: input.binding,
    });
    return { value: plain, ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

export async function resolvePurchaseContext(input: {
  readonly organizationId: string;
  readonly orderId: string;
}): Promise<ResolvePurchaseContextResult> {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, organizationId: input.organizationId },
    select: {
      id: true,
      siteId: true,
      site: {
        select: {
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          country: true,
          phone: true,
        },
      },
      patient: {
        select: {
          id: true,
          firstNameEnc: true,
          lastNameEnc: true,
          addressLine1Enc: true,
          addressLine2Enc: true,
          cityEnc: true,
          stateEnc: true,
          postalCodeEnc: true,
          phoneEnc: true,
        },
      },
    },
  });

  if (order === null) {
    return Object.freeze({
      ok: false,
      code: RESOLVE_PURCHASE_ORDER_NOT_FOUND,
      message: "Order not found in this organization.",
    });
  }

  // --- From-address (site) ---
  const site = order.site;
  if (
    site.addressLine1 === null ||
    site.city === null ||
    site.state === null ||
    site.postalCode === null ||
    site.country.length === 0
  ) {
    return Object.freeze({
      ok: false,
      code: RESOLVE_PURCHASE_SITE_ADDRESS_INCOMPLETE,
      message:
        "Ship-from address is not configured for this pharmacy site. Set it on /ops/admin/sites.",
    });
  }
  const fromAddress: ResolvedAddress = Object.freeze({
    name: site.name,
    street1: site.addressLine1,
    ...(site.addressLine2 !== null ? { street2: site.addressLine2 } : {}),
    city: site.city,
    state: site.state,
    postalCode: site.postalCode,
    country: site.country,
    ...(site.phone !== null ? { phone: site.phone } : {}),
  });

  // --- To-address (patient PHI) ---
  const patient = order.patient;
  const decryptBinding = (column: string) =>
    ({
      tenantId: input.organizationId,
      table: "patient",
      column,
      recordId: patient.id,
    }) as const;
  const [firstName, lastName, addressLine1, addressLine2, city, state, postalCode, phone] =
    await Promise.all([
      decryptToString({ envelope: patient.firstNameEnc, binding: decryptBinding("firstName") }),
      decryptToString({ envelope: patient.lastNameEnc, binding: decryptBinding("lastName") }),
      decryptToString({
        envelope: patient.addressLine1Enc,
        binding: decryptBinding("addressLine1"),
      }),
      decryptToString({
        envelope: patient.addressLine2Enc,
        binding: decryptBinding("addressLine2"),
      }),
      decryptToString({ envelope: patient.cityEnc, binding: decryptBinding("city") }),
      decryptToString({ envelope: patient.stateEnc, binding: decryptBinding("state") }),
      decryptToString({
        envelope: patient.postalCodeEnc,
        binding: decryptBinding("postalCode"),
      }),
      decryptToString({ envelope: patient.phoneEnc, binding: decryptBinding("phone") }),
    ]);

  const decryptFailures = [
    firstName,
    lastName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    phone,
  ].some((d) => !d.ok);
  if (decryptFailures) {
    return Object.freeze({
      ok: false,
      code: RESOLVE_PURCHASE_PATIENT_ADDRESS_DECRYPT_FAILED,
      message:
        "Failed to decrypt the recipient address. Check KMS configuration; this is a security incident if persistent.",
    });
  }

  const recipientName = [firstName.value, lastName.value]
    .filter((s) => s !== null && s.length > 0)
    .join(" ")
    .trim();
  if (
    recipientName.length === 0 ||
    addressLine1.value === null ||
    city.value === null ||
    state.value === null ||
    postalCode.value === null
  ) {
    return Object.freeze({
      ok: false,
      code: RESOLVE_PURCHASE_PATIENT_ADDRESS_INCOMPLETE,
      message:
        "Patient is missing one or more required address fields (name, street, city, state, postal code).",
    });
  }
  const toAddress: ResolvedAddress = Object.freeze({
    name: recipientName,
    street1: addressLine1.value,
    ...(addressLine2.value !== null ? { street2: addressLine2.value } : {}),
    city: city.value,
    state: state.value,
    postalCode: postalCode.value,
    country: "US", // Patient address country is not collected today;
    // domestic US is the only supported destination at the
    // adapter layer.
    ...(phone.value !== null ? { phone: phone.value } : {}),
  });

  // --- Available providers ---
  const providers = await prisma.carrierCredential.findMany({
    where: { organizationId: input.organizationId, status: "ACTIVE" },
    select: { provider: true },
    orderBy: { provider: "asc" },
  });
  if (providers.length === 0) {
    return Object.freeze({
      ok: false,
      code: RESOLVE_PURCHASE_NO_ACTIVE_CARRIER_CREDENTIAL,
      message: "No ACTIVE carrier credential configured. Register one on /ops/admin/carriers.",
    });
  }

  return Object.freeze({
    ok: true,
    context: Object.freeze({
      orderId: order.id,
      fromAddress,
      toAddress,
      parcel: DEFAULT_PARCEL,
      availableProviders: providers.map((p) => p.provider),
    }),
  });
}

/**
 * Provider → allowed carrier values mapping for the form
 * dropdowns. EasyPost is a broker (any carrier); FedEx and UPS
 * are direct carriers.
 */
export const ALLOWED_CARRIERS_BY_PROVIDER: Readonly<
  Record<ShippingProvider, ReadonlyArray<ShipmentCarrier>>
> = Object.freeze({
  EASYPOST: ["USPS", "UPS", "FEDEX", "DHL"] as ReadonlyArray<ShipmentCarrier>,
  FEDEX: ["FEDEX"] as ReadonlyArray<ShipmentCarrier>,
  UPS: ["UPS"] as ReadonlyArray<ShipmentCarrier>,
});
