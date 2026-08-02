// billing.invoice.approved.v1 — a DRAFT invoice passed human review.
//
// Producer: `ApproveInvoice` (`@pharmax/billing`).
//
// The approval is anchored to a REVISION, not just a moment:
// `approvedVersion` is the invoice `version` as of the approval
// commit. FinalizeInvoice requires `approvedVersion === version`, so
// a line appended after the review (materializer bumps `version`)
// invalidates the approval — a re-approval emits this event again
// with the new version.
//
// Consumers: none yet. Future candidates: clinic-billing console
// activity feed, "invoices awaiting finalization" notification digest.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    invoiceId: z.uuid(),
    invoiceNumber: z.string().min(1).max(64),
    currency: z.string().min(3).max(3),
    subtotalCents: z.number().int().min(0),
    totalCents: z.number().int().min(0),
    amountDueCents: z.number().int(),
    lineCount: z.number().int().min(1),
    approvedByUserId: z.uuid(),
    /** Invoice `version` as of this approval commit. */
    approvedVersion: z.number().int().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingInvoiceApprovedV1 = defineEvent({
  name: "billing.invoice.approved",
  version: 1,
  aggregateType: "Invoice",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.invoiceId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.invoice",
  description:
    "Emitted by ApproveInvoice when a DRAFT invoice passes review. approvedVersion anchors the approval to a specific revision; FinalizeInvoice requires it to still match.",
});

export type BillingInvoiceApprovedV1Payload = z.infer<typeof payloadSchema>;
