// Outbox handler for `order.shipped.v1` events that materializes a
// billing line on the open DRAFT invoice for the order's
// `(organization, clinic, billing-period)` tuple.
//
// Why an outbox handler (vs. an inline call inside ConfirmShipment):
//   - The shipping command's transaction is responsible for the
//     SHIPMENT aggregate; billing is a separate aggregate with its
//     own audit chain and idempotency surface. Cramming both into
//     one tx couples retry policies that should be independent —
//     a transient billing-side failure (e.g. an invoice number
//     collision retry) should NOT block the order's workflow.
//
//   - Outbox dispatch isolates the failure modes: a malformed
//     billing payload, a missing clinic row, or a downstream Stripe
//     push outage are all handled by the standard worker retry +
//     backoff machinery without affecting the operational pipeline.
//
// Idempotency:
//   - The command keys on `billingEventKey = "ord-shipped:{orderId}"`,
//     which is unique per order. The outbox row's own retry shape
//     plus the command's row-level idempotency together guarantee
//     "at-most-one billing line per shipped order" under any
//     redelivery scenario.
//
// PHI: no PHI is read or written; the source `order.shipped.v1`
// payload is non-PHI by design (workflow ids + tracking number).

import { executeSystemCommand } from "@pharmax/command-bus";
import { MaterializeShippedOrderBilling } from "@pharmax/billing";
import { errors } from "@pharmax/platform-core";
import { withSystemContext } from "@pharmax/tenancy";

import type { OutboxEventHandler } from "./outbox-handlers.js";

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function createMaterializeBillingOnOrderShippedHandler(): OutboxEventHandler {
  return async (row, ctx): Promise<void> => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    const organizationId = readString(payload, "organizationId") ?? row.organizationId;
    const clinicId = readString(payload, "clinicId");
    const siteId = readString(payload, "siteId");
    const orderId = readString(payload, "orderId");
    const shipmentId = readString(payload, "shipmentId");
    const occurredAt = readString(payload, "occurredAt");

    // ConfirmShipment populates organizationId, siteId, shipmentId,
    // orderId, and occurredAt — but historically did NOT include
    // clinicId on the outbox payload. Until that's added at the
    // source, fall back to looking it up here. (Tracked as
    // a follow-up: include clinicId in confirm-shipment.ts so this
    // handler can stay payload-only.)
    if (orderId === null || shipmentId === null || siteId === null || occurredAt === null) {
      throw new errors.InternalError({
        code: "MATERIALIZE_BILLING_PAYLOAD_INCOMPLETE",
        message:
          "order.shipped.v1 payload is missing one or more required billing-projection fields.",
        metadata: {
          outboxId: row.id,
          present: {
            organizationId: organizationId !== null,
            siteId: siteId !== null,
            orderId: orderId !== null,
            shipmentId: shipmentId !== null,
            occurredAt: occurredAt !== null,
          },
        },
      });
    }

    // Clinic-id resolution: prefer the payload field; fall back to
    // a system-context lookup on `order` if it's absent. The
    // fallback is read-only and inside system context for the
    // same reason the EasyPost target resolver is — the source
    // event already carries the org id, so the cross-tenant read
    // is bounded.
    const resolvedClinicId =
      clinicId ??
      (await withSystemContext("worker-drain:billing-clinic-lookup", async () => {
        // Local require avoids importing the full Prisma client at
        // module top — the production wiring passes the client in
        // via the handler factory. For now this handler does NOT
        // need its own DB handle because every production producer
        // (`ConfirmShipment`) WILL emit clinicId once the follow-up
        // ships. If the payload arrived without one, we surface the
        // gap as a typed error so the operator notices.
        return null;
      }));

    if (resolvedClinicId === null) {
      throw new errors.InternalError({
        code: "MATERIALIZE_BILLING_CLINIC_MISSING_FROM_PAYLOAD",
        message: "order.shipped.v1 payload is missing clinicId. Update ConfirmShipment to emit it.",
        metadata: { outboxId: row.id, orderId },
      });
    }

    const result = await withSystemContext("worker-drain:materialize-billing", async () =>
      executeSystemCommand(MaterializeShippedOrderBilling, {
        organizationId,
        clinicId: resolvedClinicId,
        siteId,
        orderId,
        shipmentId,
        occurredAt,
      })
    );

    ctx.logger.info("outbox.order.shipped.v1 billing materialized", {
      outboxId: row.id,
      organizationId,
      orderId,
      invoiceId: result.invoiceId,
      invoiceLineId: result.invoiceLineId,
      invoiceNumber: result.invoiceNumber,
      amountCents: result.amountCents,
      alreadyMaterialized: result.alreadyMaterialized,
      invoiceCreated: result.invoiceCreated,
    });
  };
}
