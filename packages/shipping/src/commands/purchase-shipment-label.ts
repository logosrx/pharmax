// PurchaseShipmentLabel — buy a carrier label and persist the
// resulting shipment record in one transaction.
//
// Flow:
//   1. Lock the order, assert it's in READY_TO_SHIP, and assert the
//      caller is the assignee (same prerequisites as CreateShipment).
//   2. Reject if a shipment already exists for the order (same
//      idempotency guard as CreateShipment).
//   3. Call the configured ShippingAdapter to purchase the label.
//      This is an OUTBOUND network call — the adapter is the single
//      I/O escape hatch. We hold the row lock during the call so a
//      concurrent operator cannot double-purchase; the call is short
//      (EasyPost typically returns in <2s).
//   4. Persist a Shipment row populated from the adapter's response
//      (tracking number, external IDs, carrier, service level).
//
// Why this is a separate command from CreateShipment:
//   - It needs a separate permission (`ship.purchase_label`) because
//     it spends real money on the org's carrier account.
//   - The adapter call is an external side effect; isolating it
//     keeps the manual `CreateShipment` (BYO tracking number) path
//     synchronous and free of provider failures.
//   - Audit metadata + outbox payloads include adapter-derived
//     fields (postageRateCents, providerName) that don't apply to
//     the manual path.
//
// PHI invariant:
//   - Addresses are required INPUTS to the carrier — they cannot be
//     encrypted at the carrier boundary. The caller MUST pass
//     already-resolved cleartext addresses (typically loaded + decrypted
//     in a thin web-route adapter before calling executeCommand).
//   - Audit metadata + outbox payloads echo ONLY the
//     shipment-identity fields (carrier, service level, tracking
//     number, postage cost, external IDs). Recipient names and
//     addresses MUST NOT appear. The `redactFields` list strips the
//     address fields from `command_log.requestPayload` so the
//     replay record is also PHI-safe.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { ShipmentCarrier, ShipmentStatus, ShippingProvider } from "@pharmax/database";
import { errors, geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { resolveShippingAdapter } from "../resolve-adapter.js";
import {
  assertReadyToShipWithAssignee,
  assertShippingAssignee,
  SHIP_NOT_ASSIGNED_TO_ACTOR,
  SHIP_WRONG_STATUS,
} from "../shipping-guards.js";

import { SHIPMENT_ALREADY_EXISTS } from "./create-shipment.js";

import { assertShipToStateAllowed } from "../ship-to-state-guard.js";

export const PURCHASE_LABEL_ADAPTER_FAILED = "PURCHASE_LABEL_ADAPTER_FAILED";
export const SHIPPING_ADDRESS_UNDELIVERABLE = "SHIPPING_ADDRESS_UNDELIVERABLE";

const addressSchema = z
  .object({
    name: z.string().min(1).max(120),
    street1: z.string().min(1).max(200),
    street2: z.string().min(1).max(200).optional(),
    city: z.string().min(1).max(100),
    state: z.string().min(1).max(80),
    postalCode: z.string().min(1).max(20),
    country: z
      .string()
      .min(2)
      .max(2)
      .regex(/^[A-Z]{2}$/, "expected ISO-3166-1 alpha-2 country code"),
    phone: z.string().min(1).max(40).optional(),
    email: z.email().max(320).optional(),
  })
  .strict();

const parcelSchema = z
  .object({
    lengthInches: z.number().positive().max(108),
    widthInches: z.number().positive().max(108),
    heightInches: z.number().positive().max(108),
    weightOunces: z.number().positive().max(1120),
  })
  .strict();

const providerSchema = z.enum([
  ShippingProvider.EASYPOST,
  ShippingProvider.FEDEX,
  ShippingProvider.UPS,
]);

const inputSchema = z
  .object({
    orderId: z.uuid(),
    /**
     * Which carrier credential to use. Resolved via
     * `carrier_credential` (must be ACTIVE for this org). The
     * adapter's actual carrier may differ from `carrier` below
     * (e.g. EASYPOST + carrier=USPS) — the persisted shipment row
     * is stamped with the adapter-returned carrier so the audit
     * trail reflects what actually shipped.
     */
    provider: providerSchema,
    carrier: z.enum([
      ShipmentCarrier.USPS,
      ShipmentCarrier.UPS,
      ShipmentCarrier.FEDEX,
      ShipmentCarrier.DHL,
      ShipmentCarrier.OTHER,
    ]),
    serviceLevel: z.string().min(1).max(64),
    fromAddress: addressSchema,
    toAddress: addressSchema,
    parcel: parcelSchema,
    // Delivery signature requirement. Omitted → carrier service
    // default. Adapters that cannot honor a requested option throw
    // SIGNATURE_OPTION_UNSUPPORTED (no silent compliance downgrade).
    signatureOption: z.enum(["NO_SIGNATURE_REQUIRED", "INDIRECT", "DIRECT", "ADULT"]).optional(),
  })
  .strict();

export type PurchaseShipmentLabelInput = z.infer<typeof inputSchema>;

export interface PurchaseShipmentLabelOutput {
  readonly orderId: string;
  readonly shipmentId: string;
  readonly provider: ShippingProvider;
  readonly trackingNumber: string;
  readonly externalShipmentId: string;
  readonly externalTrackerId: string | null;
  readonly labelUrl: string | null;
  readonly postageRateCents: number | null;
  readonly version: number;
}

// Addresses are PHI-adjacent (recipient identity). They MUST be
// scrubbed from `command_log.requestPayload`. The bus's
// `redactPayload` uses top-level keys, so we redact the whole
// `fromAddress` and `toAddress` objects rather than nested fields.
const REDACT_FIELDS = Object.freeze(["fromAddress", "toAddress"] as const);

export const PurchaseShipmentLabel = defineCommand<
  PurchaseShipmentLabelInput,
  PurchaseShipmentLabelOutput
>({
  name: "PurchaseShipmentLabel",
  inputSchema,
  permission: PERMISSIONS.SHIP_PURCHASE_LABEL,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  redactFields: REDACT_FIELDS,

  async exec({ tx, ctx, input, target, clock, commandLogId, saga, logger }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "PURCHASE_SHIPMENT_LABEL_NO_TARGET",
        message: "Locked order target was not provided to PurchaseShipmentLabel.",
      });
    }

    assertReadyToShipWithAssignee({ target, ctx });
    await assertShippingAssignee({ tx, target, ctx });

    const existing = await tx.shipment.findFirst({
      where: { organizationId: ctx.organizationId, orderId: target.id },
      select: { id: true },
    });
    if (existing !== null) {
      throw new errors.ConflictError({
        code: SHIPMENT_ALREADY_EXISTS,
        message: "A shipment already exists for this order.",
        metadata: { orderId: target.id, shipmentId: existing.id },
      });
    }

    // Ship-to-state licensure (G-2), BEFORE the adapter call — refusing
    // after buying a label would mean refunding one.
    //
    // Checked against `input.toAddress.state`, the address actually
    // being shipped to, rather than the destination recorded at intake:
    // an operator can correct the address on this form, and validating
    // the stored value while shipping to a typed one would be a bypass
    // of exactly the kind this guard exists to close.
    await assertShipToStateAllowed({
      tx,
      organizationId: ctx.organizationId,
      siteId: target.siteId,
      orderId: target.id,
      destinationState: geo.normalizeJurisdictionCode(input.toAddress.state),
    });

    // Resolve the per-org credential and build the adapter via the
    // configured factory. The resolver decrypts the API key with AAD
    // bound to the credential row, so a ciphertext moved between
    // rows would fail loud here instead of silently authenticating
    // to the wrong carrier account.
    const { adapter, credentialId } = await resolveShippingAdapter({
      tx,
      organizationId: ctx.organizationId,
      provider: input.provider,
    });

    // ---- Pre-flight address validation (providers that support it).
    //
    // Policy, in order of failure-mode severity:
    //   - Carrier says INVALID (address does not resolve at all):
    //     BLOCK before money is spent on a label. The operator fixes
    //     the address on the patient record, or falls back to the
    //     manual CreateShipment path as the deliberate override.
    //   - Carrier says UNCONFIRMED (resolves, delivery point not
    //     confirmed): PROCEED. Blocking here would false-positive on
    //     new construction, rural routes, and suite addresses —
    //     worse for therapy continuity than an occasional carrier
    //     correction.
    //   - Validation API itself unavailable: FAIL OPEN and proceed
    //     unvalidated. Shipping medication cannot depend on the
    //     availability of an auxiliary validation endpoint. The
    //     shipment row records that validation did not run
    //     (NULL columns), so fail-open events are queryable.
    //
    // PHI: the verdict (deliverability + classification) is recorded;
    // the address itself never lands in errors, audit, or outbox.
    let addressValidation: {
      deliverability: string;
      classification: string | null;
      validatedAt: Date;
    } | null = null;
    if (adapter.validateAddress !== undefined) {
      try {
        const verdict = await adapter.validateAddress(normalizeAddress(input.toAddress));
        addressValidation = {
          deliverability: verdict.deliverability,
          classification: verdict.classification,
          validatedAt: clock.now(),
        };
      } catch (cause) {
        logger.warn("address validation unavailable — proceeding unvalidated (fail open)", {
          orderId: target.id,
          provider: input.provider,
          errorMessage: cause instanceof Error ? cause.message : "unknown",
        });
      }
      if (addressValidation !== null && addressValidation.deliverability === "INVALID") {
        throw new errors.ValidationError({
          code: SHIPPING_ADDRESS_UNDELIVERABLE,
          message:
            "The carrier could not resolve the destination address. Correct the ship-to address and retry, or record a manual shipment to override.",
          metadata: {
            orderId: target.id,
            provider: input.provider,
            deliverability: addressValidation.deliverability,
            classification: addressValidation.classification,
          },
        });
      }
    }

    let purchased;
    try {
      purchased = await adapter.purchaseLabel({
        fromAddress: normalizeAddress(input.fromAddress),
        toAddress: normalizeAddress(input.toAddress),
        parcel: input.parcel,
        carrier: input.carrier,
        serviceLevel: input.serviceLevel,
        ...(input.signatureOption !== undefined ? { signatureOption: input.signatureOption } : {}),
      });
    } catch (cause) {
      // Adapter errors are already InternalError instances from the
      // carrier adapter; re-throw as a ConflictError so the HTTP
      // layer surfaces a 409 (the order is still in READY_TO_SHIP and
      // the operator can retry once the underlying issue is fixed).
      //
      // PHI note: carrier error messages can echo request fragments
      // (including address lines). Keep the operator-facing message
      // generic; the full cause is chained for server-side logs.
      throw new errors.ConflictError({
        code: PURCHASE_LABEL_ADAPTER_FAILED,
        message: "Carrier declined the label purchase. Verify the address and parcel, then retry.",
        metadata: {
          orderId: target.id,
          provider: input.provider,
          credentialId,
          requestedCarrier: input.carrier,
          requestedServiceLevel: input.serviceLevel,
        },
        cause,
      });
    }

    // The buy above escaped the transaction — the carrier charged
    // the org's account regardless of whether this tx commits. If
    // ANY later step in this handler throws (shipment insert, CAS
    // bump, order_event write), void the label before the rollback
    // so a retry does not double-charge. Providers without
    // cancelLabel keep the residual risk; the pre-flight command_log
    // RUNNING row (committed before the handler) is the durable
    // reconciliation breadcrumb for a crash mid-purchase.
    const boughtTrackingNumber = purchased.trackingNumber;
    saga.step({
      name: "void-purchased-label",
      undo: async () => {
        if (adapter.cancelLabel === undefined) {
          logger.warn("purchased label could not be auto-voided (provider lacks cancelLabel)", {
            provider: input.provider,
            trackingNumber: boughtTrackingNumber,
            orderId: target.id,
          });
          return;
        }
        await adapter.cancelLabel({ trackingNumber: boughtTrackingNumber });
      },
    });

    const shipment = await tx.shipment.create({
      data: {
        organizationId: ctx.organizationId,
        orderId: target.id,
        siteId: target.siteId,
        status: ShipmentStatus.CREATED,
        carrier: purchased.carrier,
        serviceLevel: purchased.serviceLevel,
        trackingNumber: purchased.trackingNumber,
        externalShipmentId: purchased.externalShipmentId,
        externalTrackerId: purchased.externalTrackerId,
        // Persist the artifact the org just paid for — without these
        // the label was unrecoverable after this response.
        labelUrl: purchased.labelUrl,
        labelPdfBase64: purchased.labelPdfBase64,
        // ... and what it cost. Already in audit/outbox; the column
        // is what makes shipping-spend reporting queryable.
        postageRateCents: purchased.postageRateCents,
        // Address-validation verdict (never the address). NULL when
        // validation didn't run (no provider support / fail-open).
        addressDeliverability: addressValidation?.deliverability ?? null,
        addressClassification: addressValidation?.classification ?? null,
        addressValidatedAt: addressValidation?.validatedAt ?? null,
        // Signature requirement the label was purchased with — the
        // compliance record for "was adult signature requested".
        signatureOption: input.signatureOption ?? null,
        createdByUserId: ctx.actor.userId,
        createCommandLogId: commandLogId,
      },
      select: { id: true },
    });

    const now = clock.now();
    const toVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        shipmentId: shipment.id,
        provider: input.provider,
        trackingNumber: purchased.trackingNumber,
        externalShipmentId: purchased.externalShipmentId,
        externalTrackerId: purchased.externalTrackerId,
        labelUrl: purchased.labelUrl,
        postageRateCents: purchased.postageRateCents,
        version: toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: toVersion },
      audit: {
        action: "order.shipment.label_purchased",
        resourceType: "Shipment",
        resourceId: shipment.id,
        metadata: {
          orderId: target.id,
          shipmentId: shipment.id,
          provider: input.provider,
          providerName: adapter.providerName,
          credentialId,
          carrier: purchased.carrier,
          serviceLevel: purchased.serviceLevel,
          trackingNumber: purchased.trackingNumber,
          externalShipmentId: purchased.externalShipmentId,
          hasExternalTrackerId: purchased.externalTrackerId !== null,
          hasLabelUrl: purchased.labelUrl !== null,
          postageRateCents: purchased.postageRateCents,
          // Verdict only — never the address.
          addressDeliverability: addressValidation?.deliverability ?? null,
          addressClassification: addressValidation?.classification ?? null,
          signatureOption: input.signatureOption ?? null,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.shipment.label_purchased.v1",
          aggregateType: "Shipment",
          aggregateId: shipment.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            shipmentId: shipment.id,
            provider: input.provider,
            providerName: adapter.providerName,
            credentialId,
            carrier: purchased.carrier,
            serviceLevel: purchased.serviceLevel,
            trackingNumber: purchased.trackingNumber,
            externalShipmentId: purchased.externalShipmentId,
            externalTrackerId: purchased.externalTrackerId,
            postageRateCents: purchased.postageRateCents,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
        {
          // Bridge event so anything subscribed to "shipment created"
          // (e.g. queue UI counters) still fires for purchased labels.
          eventType: "order.shipment.created.v1",
          aggregateType: "Shipment",
          aggregateId: shipment.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            shipmentId: shipment.id,
            carrier: purchased.carrier,
            serviceLevel: purchased.serviceLevel,
            trackingNumber: purchased.trackingNumber,
            createdByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

// Zod's `.optional()` parse produces `string | undefined`. The
// adapter input uses `exactOptionalPropertyTypes`, which rejects
// explicit `undefined` assignment on optional keys. This helper
// spreads each optional field conditionally so the resulting object
// has the right shape regardless of which fields were provided.
function normalizeAddress(addr: z.infer<typeof addressSchema>) {
  return {
    name: addr.name,
    street1: addr.street1,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: addr.country,
    ...(addr.street2 !== undefined ? { street2: addr.street2 } : {}),
    ...(addr.phone !== undefined ? { phone: addr.phone } : {}),
    ...(addr.email !== undefined ? { email: addr.email } : {}),
  };
}

export {
  ORDER_VERSION_MISMATCH,
  SHIP_NOT_ASSIGNED_TO_ACTOR,
  SHIP_WRONG_STATUS,
  SHIPMENT_ALREADY_EXISTS,
};
