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
//     layer 1). ONE side effect still runs on this path: when the
//     webhook reports `succeeded` and the payment ledger has no row
//     for this refund yet (IssueRefund wrote the line while Stripe
//     reported `pending`), THIS is the settle moment — the REFUND
//     ledger row is appended here.
//
//   - Otherwise, this is an out-of-band refund. Resolve the
//     Pharmax invoice via the Stripe charge id, write the negative
//     line + the REFUND payment-ledger row, decrement totals, emit
//     `billing.invoice.refunded.v1` + `billing.payment.recorded.v1`.
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

import type {
  OutboxEventDraft,
  PrismaTxClient,
  SystemCommand,
  SystemHandlerResult,
} from "@pharmax/command-bus";
import { InvoiceLineKind, PaymentKind, PaymentMethod, type Prisma } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";
import { z } from "zod";

import {
  computePriorRefundedCents,
  insertPaymentLedgerRow,
  type PaymentLedgerRowInput,
  paymentRecordedOutboxEvent,
} from "../payments/payment-ledger.js";

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
  amountPaidCents: number;
  currency: string;
} | null> {
  return await tx.invoice.findFirst({
    where: { stripeChargeId },
    select: {
      id: true,
      organizationId: true,
      clinicId: true,
      invoiceNumber: true,
      amountDueCents: true,
      amountPaidCents: true,
      currency: true,
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
      select: { id: true, invoiceId: true, organizationId: true, clinicId: true },
    });
    if (existingLine !== null) {
      // The invoice line exists, but the PAYMENT LEDGER row may not:
      // IssueRefund writes the line for `pending` refunds and defers
      // the ledger row to settlement. If THIS delivery reports
      // `succeeded`, this is the settle moment — append the ledger
      // row now. (Idempotent: an IssueRefund that settled
      // synchronously already owns the `stripe-refund:{id}` key, so
      // `created` comes back false and nothing is re-announced.)
      let paymentId: string | null = null;
      const paymentOutboxEvents: OutboxEventDraft[] = [];
      let ledgerRowCreated = false;
      if (input.stripeStatus === "succeeded") {
        const invoiceForLedger = await tx.invoice.findUnique({
          where: { id: existingLine.invoiceId },
          select: { currency: true },
        });
        if (invoiceForLedger !== null) {
          const ledgerRow: PaymentLedgerRowInput = {
            organizationId: existingLine.organizationId,
            clinicId: existingLine.clinicId,
            invoiceId: existingLine.invoiceId,
            kind: PaymentKind.REFUND,
            method: PaymentMethod.STRIPE,
            amountCents: input.amountCents,
            currency: invoiceForLedger.currency,
            paymentEventKey: billingEventKey,
            stripeEventId: input.stripeEventId,
            stripeChargeId: input.stripeChargeId,
            stripeRefundId: input.stripeRefundId,
            occurredAt: new Date(input.refundedAt),
            metadata: {
              sourceEvent: "stripe-webhook-charge-refunded",
              settledPendingRefund: true,
              stripeReason: input.stripeReason ?? null,
            },
          };
          const ledgerResult = await insertPaymentLedgerRow(tx, ledgerRow);
          paymentId = ledgerResult.paymentId;
          ledgerRowCreated = ledgerResult.created;
          if (ledgerResult.created) {
            paymentOutboxEvents.push(
              paymentRecordedOutboxEvent({ paymentId: ledgerResult.paymentId, row: ledgerRow })
            );
          }
        }
      }

      return {
        output: {
          recognized: true,
          alreadyRecorded: true,
          invoiceId: existingLine.invoiceId,
          invoiceLineId: existingLine.id,
        },
        targetOrganizationId: existingLine.organizationId,
        audit: {
          action: ledgerRowCreated
            ? "billing.invoice.refund_received.settled"
            : "billing.invoice.refund_received.skipped",
          resourceType: "Invoice",
          resourceId: existingLine.invoiceId,
          metadata: {
            invoiceId: existingLine.invoiceId,
            invoiceLineId: existingLine.id,
            stripeRefundId: input.stripeRefundId,
            stripeEventId: input.stripeEventId,
            reason: ledgerRowCreated ? "pending-refund-settled" : "already-recorded",
            paymentId,
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: paymentOutboxEvents,
      };
    }

    // ---- Gate on Stripe's actual refund outcome ----
    // Stripe delivers refund webhooks for `failed` / `canceled`
    // attempts too. Only `succeeded` refunds may write ledger
    // credits — recording a failed attempt would show money as
    // returned when nothing moved. (`pending` refunds are also
    // skipped here: Stripe redelivers a follow-up event when the
    // refund settles, and THAT event writes the ledger entry; the
    // billingEventKey unique keeps the settle event idempotent.)
    if (input.stripeStatus !== "succeeded") {
      return {
        output: {
          recognized: true,
          alreadyRecorded: false,
          invoiceId: null,
          invoiceLineId: null,
        },
        targetOrganizationId:
          (await loadInvoiceByCharge(tx, input.stripeChargeId))?.organizationId ??
          "00000000-0000-0000-0000-000000000000",
        audit: {
          action: "billing.invoice.refund_received.not_succeeded",
          resourceType: "Invoice",
          resourceId: input.stripeChargeId,
          metadata: {
            stripeChargeId: input.stripeChargeId,
            stripeRefundId: input.stripeRefundId,
            stripeEventId: input.stripeEventId,
            stripeStatus: input.stripeStatus,
            reason: "refund-not-succeeded",
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
    //
    // Stripe is the source of truth for out-of-band refunds — the
    // money moved whether or not our ledger expected it — so the
    // entry is always recorded. But a refund total exceeding what
    // we tracked as PAID means either a dashboard mistake or a
    // reconciliation gap, so compute prior refunds and flag the
    // over-refund LOUDLY in the audit row + outbox payload for the
    // billing team instead of letting the balance drift negative
    // silently.
    const priorRefundTotals = await computePriorRefundedCents(tx, invoice.id);
    const priorRefundedCents = priorRefundTotals.priorRefundedCents;
    const overRefund = priorRefundedCents + input.amountCents > invoice.amountPaidCents;

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

    // ---- Append the REFUND ledger row ----
    // Status was gated to `succeeded` above, so the money moved.
    // Same tx as the line + totals: projection and ledger cannot
    // disagree on a partial commit.
    const ledgerRow: PaymentLedgerRowInput = {
      organizationId: invoice.organizationId,
      clinicId: invoice.clinicId,
      invoiceId: invoice.id,
      kind: PaymentKind.REFUND,
      method: PaymentMethod.STRIPE,
      amountCents: input.amountCents,
      currency: invoice.currency,
      paymentEventKey: billingEventKey,
      stripeEventId: input.stripeEventId,
      stripeChargeId: input.stripeChargeId,
      stripeRefundId: input.stripeRefundId,
      occurredAt: new Date(input.refundedAt),
      metadata: {
        sourceEvent: "stripe-webhook-charge-refunded",
        stripeReason: input.stripeReason ?? null,
      },
    };
    const ledgerResult = await insertPaymentLedgerRow(tx, ledgerRow);
    const paymentOutboxEvents: OutboxEventDraft[] = ledgerResult.created
      ? [paymentRecordedOutboxEvent({ paymentId: ledgerResult.paymentId, row: ledgerRow })]
      : [];

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
          priorRefundedCents,
          priorRefundedFromLinesCents: priorRefundTotals.fromInvoiceLinesCents,
          priorRefundedFromLedgerCents: priorRefundTotals.fromPaymentLedgerCents,
          paymentId: ledgerResult.paymentId,
          amountPaidCents: invoice.amountPaidCents,
          // True when this refund pushes total refunds past what we
          // tracked as paid — a reconciliation flag for billing.
          overRefund,
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
        ...paymentOutboxEvents,
      ],
    };
  },
};
