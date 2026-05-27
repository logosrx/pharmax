// RecordRefundReceived — system command for refunds that arrive
// via the Stripe `charge.refunded` webhook (operator issued the
// refund directly from the Stripe dashboard, or some other
// out-of-band source).
//
// The IssueRefund flow already writes the ledger line BEFORE the
// webhook arrives. When Stripe redelivers the refund event, this
// command runs and:
//
//   - If a line already exists for `billingEventKey =
//     "stripe-refund:{stripeRefundId}"`, returns cleanly with
//     `alreadyRecorded: true` (idempotency layer 2 — bus key is
//     layer 1).
//
//   - Otherwise, this is an out-of-band refund. Resolve the
//     Pharmax invoice via the Stripe charge id, write the negative
//     line, decrement totals, emit `billing.invoice.refunded.v1`.
//
//   - If we can't resolve the invoice (orphan charge), log + return
//     `recognized: false`. Operator can manually reconcile.
//
// This command is THE bridge for refund reconciliation:
// Pharmax-initiated → "alreadyRecorded" path keeps the ledger
// authoritative; Stripe-initiated → fills in the ledger entry.
//
// Two-write pattern: the negative line + the invoice total update
// happen in the same tx so a partial-fail is impossible.
//
// PHI invariant: none.

import type { PrismaTxClient, SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceLineKind, type Prisma } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import { z } from "zod";

const inputSchema = z
  .object({
    /** Stripe charge that was refunded. We use this to resolve the Pharmax invoice. */
    stripeChargeId: z.string().min(1).max(128),
    stripeRefundId: z.string().min(1).max(128),
    amountCents: z.number().int().min(1).max(10_000_00),
    /** Stripe-reported refund status. */
    stripeStatus: z.enum(["succeeded", "pending", "failed", "canceled"]),
    stripeReason: z
      .enum(["duplicate", "fraudulent", "requested_by_customer", "expired_uncaptured_charge"])
      .optional(),
    /** Originating Stripe event id (for audit traceability). */
    stripeEventId: z.string().min(1).max(128),
    refundedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type RecordRefundReceivedInput = z.infer<typeof inputSchema>;

export interface RecordRefundReceivedOutput {
  /** True when a Pharmax invoice was resolved from the charge id. */
  readonly recognized: boolean;
  /** True when this call wrote a NEW ledger entry (vs. found an existing one). */
  readonly alreadyRecorded: boolean;
  readonly invoiceId: string | null;
  readonly invoiceLineId: string | null;
}

async function loadInvoiceByCharge(
  tx: PrismaTxClient,
  stripeChargeId: string
): Promise<{
  id: string;
  organizationId: string;
  clinicId: string;
  invoiceNumber: string;
  amountDueCents: number;
} | null> {
  return await tx.invoice.findFirst({
    where: { stripeChargeId },
    select: {
      id: true,
      organizationId: true,
      clinicId: true,
      invoiceNumber: true,
      amountDueCents: true,
    },
  });
}

export const RecordRefundReceived: SystemCommand<
  RecordRefundReceivedInput,
  RecordRefundReceivedOutput
> = {
  name: "RecordRefundReceived",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<RecordRefundReceivedOutput>> {
    const billingEventKey = `stripe-refund:${input.stripeRefundId}`;
    const now = clock.now();

    // ---- Existing line short-circuit (Pharmax-initiated refund) ----
    const existingLine = await tx.invoiceLine.findUnique({
      where: { billingEventKey },
      select: { id: true, invoiceId: true, organizationId: true },
    });
    if (existingLine !== null) {
      return {
        output: {
          recognized: true,
          alreadyRecorded: true,
          invoiceId: existingLine.invoiceId,
          invoiceLineId: existingLine.id,
        },
        targetOrganizationId: existingLine.organizationId,
        audit: {
          action: "billing.invoice.refund_received.skipped",
          resourceType: "Invoice",
          resourceId: existingLine.invoiceId,
          metadata: {
            invoiceId: existingLine.invoiceId,
            invoiceLineId: existingLine.id,
            stripeRefundId: input.stripeRefundId,
            stripeEventId: input.stripeEventId,
            reason: "already-recorded",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Resolve invoice by charge id ----
    const invoice = await loadInvoiceByCharge(tx, input.stripeChargeId);
    if (invoice === null) {
      // Orphan — Stripe charge not linked to any Pharmax invoice.
      // Most likely cause: refund issued in Stripe dashboard against
      // a charge we never tracked. Return cleanly so the drain
      // marks the row SUCCEEDED; operator can manually reconcile.
      return {
        output: {
          recognized: false,
          alreadyRecorded: false,
          invoiceId: null,
          invoiceLineId: null,
        },
        targetOrganizationId: "00000000-0000-0000-0000-000000000000",
        audit: {
          action: "billing.invoice.refund_received.unrecognized",
          resourceType: "Invoice",
          resourceId: input.stripeChargeId,
          metadata: {
            stripeChargeId: input.stripeChargeId,
            stripeRefundId: input.stripeRefundId,
            stripeEventId: input.stripeEventId,
            reason: "charge-not-linked",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Write the negative line + decrement totals ----
    const invoiceLineId = ids.generateUlid();
    const negativeAmount = -input.amountCents;

    await tx.invoiceLine.create({
      data: {
        id: invoiceLineId,
        invoiceId: invoice.id,
        organizationId: invoice.organizationId,
        clinicId: invoice.clinicId,
        kind: InvoiceLineKind.CREDIT,
        description: `Out-of-band refund (${input.stripeRefundId})`,
        quantity: 1,
        unitAmountCents: negativeAmount,
        amountCents: negativeAmount,
        billingEventKey,
        metadata: {
          sourceEvent: "stripe-webhook-charge-refunded",
          stripeRefundId: input.stripeRefundId,
          stripeChargeId: input.stripeChargeId,
          stripeStatus: input.stripeStatus,
          stripeReason: input.stripeReason ?? null,
          stripeEventId: input.stripeEventId,
          refundedAt: input.refundedAt,
        } satisfies Prisma.InputJsonValue,
      },
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountDueCents: { decrement: input.amountCents },
        version: { increment: 1 },
      },
    });

    const amountDueCentsAfter = invoice.amountDueCents - input.amountCents;

    return {
      output: {
        recognized: true,
        alreadyRecorded: false,
        invoiceId: invoice.id,
        invoiceLineId,
      },
      targetOrganizationId: invoice.organizationId,
      audit: {
        action: "billing.invoice.refund_received",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          invoiceLineId,
          stripeChargeId: input.stripeChargeId,
          stripeRefundId: input.stripeRefundId,
          stripeStatus: input.stripeStatus,
          stripeReason: input.stripeReason ?? null,
          stripeEventId: input.stripeEventId,
          amountCents: input.amountCents,
          creditAmountCents: negativeAmount,
          amountDueCentsAfter,
          refundedAt: input.refundedAt,
          source: "stripe-webhook",
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.refunded.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: invoice.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceLineId,
            stripeRefundId: input.stripeRefundId,
            stripeStatus: input.stripeStatus,
            stripeChargeId: input.stripeChargeId,
            reason: input.stripeReason ?? "requested_by_customer",
            amountCents: input.amountCents,
            amountDueCentsAfter,
            source: "stripe-webhook",
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
