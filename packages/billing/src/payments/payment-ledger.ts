// Payment ledger — shared write/read helpers for the append-only
// `payment` table (one row per SETTLED money movement).
//
// Writers (all commands in this package):
//
//   - `MarkInvoicePaid`       → PAYMENT row ("stripe-paid:{eventId}")
//   - `IssueRefund`           → REFUND row when Stripe reports
//                               `succeeded` synchronously
//   - `RecordRefundReceived`  → REFUND row for out-of-band refunds
//                               AND the settle-time row for refunds
//                               that were `pending` at IssueRefund
//                               time
//
// Invariants owned here:
//
//   - `amountCents` is always POSITIVE; direction comes from `kind`.
//     The insert throws on a non-positive amount so a sign bug in a
//     caller cannot corrupt the ledger.
//   - Only SETTLED movements are inserted — callers gate on Stripe's
//     reported status BEFORE calling; this module never decides.
//   - Idempotency: the unique `paymentEventKey` makes concurrent
//     replays converge (P2002 → re-read → `created: false`).
//   - Immutability: this module exposes NO update or delete path,
//     and none may be added. Corrections are new offsetting rows.
//
// PHI invariant: none. Stripe ids, cents, timestamps.

import type { OutboxEventDraft, PrismaTxClient } from "@pharmax/command-bus";
import { InvoiceLineKind, PaymentKind, type PaymentMethod, Prisma } from "@pharmax/database";
import { ids } from "@pharmax/platform-core";

export interface PaymentLedgerRowInput {
  readonly organizationId: string;
  readonly clinicId: string;
  readonly invoiceId: string;
  readonly kind: PaymentKind;
  readonly method: PaymentMethod;
  /** Always positive; direction comes from `kind`. */
  readonly amountCents: number;
  readonly currency: string;
  /** Idempotency anchor, e.g. `"stripe-paid:{eventId}"`. */
  readonly paymentEventKey: string;
  readonly stripeEventId?: string;
  readonly stripeChargeId?: string;
  readonly stripeRefundId?: string;
  /** When the money actually moved (Stripe's timestamp). */
  readonly occurredAt: Date;
  readonly metadata?: Prisma.InputJsonValue;
}

export interface PaymentLedgerRowResult {
  readonly paymentId: string;
  /** False when a concurrent replay already inserted the row. */
  readonly created: boolean;
}

/**
 * Append one settled money movement. Idempotent on
 * `paymentEventKey` — a concurrent replay's P2002 resolves by
 * re-reading the winner's row.
 */
export async function insertPaymentLedgerRow(
  tx: PrismaTxClient,
  input: PaymentLedgerRowInput
): Promise<PaymentLedgerRowResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `payment ledger amounts must be positive integers (got ${input.amountCents}); direction comes from kind`
    );
  }

  const paymentId = ids.generateUlid();
  try {
    await tx.payment.create({
      data: {
        id: paymentId,
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        invoiceId: input.invoiceId,
        kind: input.kind,
        method: input.method,
        amountCents: input.amountCents,
        currency: input.currency,
        paymentEventKey: input.paymentEventKey,
        stripeEventId: input.stripeEventId ?? null,
        stripeChargeId: input.stripeChargeId ?? null,
        stripeRefundId: input.stripeRefundId ?? null,
        occurredAt: input.occurredAt,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
    return { paymentId, created: true };
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
      const winner = await tx.payment.findUnique({
        where: { paymentEventKey: input.paymentEventKey },
        select: { id: true },
      });
      if (winner !== null) {
        return { paymentId: winner.id, created: false };
      }
    }
    throw cause;
  }
}

/**
 * Build the `billing.payment.recorded.v1` outbox draft for a row
 * that `insertPaymentLedgerRow` just CREATED. Callers must not emit
 * this for `created: false` results (the original writer already
 * announced the movement).
 */
export function paymentRecordedOutboxEvent(input: {
  readonly paymentId: string;
  readonly row: PaymentLedgerRowInput;
}): OutboxEventDraft {
  return {
    eventType: "billing.payment.recorded.v1",
    aggregateType: "Invoice",
    aggregateId: input.row.invoiceId,
    payload: {
      organizationId: input.row.organizationId,
      clinicId: input.row.clinicId,
      invoiceId: input.row.invoiceId,
      paymentId: input.paymentId,
      kind: input.row.kind,
      method: input.row.method,
      amountCents: input.row.amountCents,
      currency: input.row.currency,
      paymentEventKey: input.row.paymentEventKey,
      occurredAt: input.row.occurredAt.toISOString(),
    },
  };
}

export interface PriorRefundTotals {
  /** The figure budget checks must use. */
  readonly priorRefundedCents: number;
  /** Component: |sum| of CREDIT lines keyed `stripe-refund:*`. */
  readonly fromInvoiceLinesCents: number;
  /** Component: sum of ledger REFUND rows. */
  readonly fromPaymentLedgerCents: number;
}

/**
 * Total already-refunded cents for an invoice.
 *
 * Computed from BOTH sources — the legacy CREDIT-line scan and the
 * payment ledger — taking the MAX. Rationale: refunds recorded
 * before the ledger existed have lines but no ledger rows (until
 * the backfill lands), while a `pending` IssueRefund has a line but
 * deliberately no ledger row until settlement. MAX means neither
 * gap ever lets an operator refund past what was actually paid.
 * After the backfill the two figures converge; the line scan can
 * then be retired.
 */
export async function computePriorRefundedCents(
  tx: PrismaTxClient,
  invoiceId: string
): Promise<PriorRefundTotals> {
  const refundLines = await tx.invoiceLine.findMany({
    where: {
      invoiceId,
      kind: InvoiceLineKind.CREDIT,
      billingEventKey: { startsWith: "stripe-refund:" },
    },
    select: { amountCents: true },
  });
  const fromInvoiceLinesCents = refundLines.reduce(
    (sum, line) => sum + Math.abs(line.amountCents),
    0
  );

  const refundRows = await tx.payment.findMany({
    where: { invoiceId, kind: PaymentKind.REFUND },
    select: { amountCents: true },
  });
  const fromPaymentLedgerCents = refundRows.reduce((sum, row) => sum + row.amountCents, 0);

  return {
    priorRefundedCents: Math.max(fromInvoiceLinesCents, fromPaymentLedgerCents),
    fromInvoiceLinesCents,
    fromPaymentLedgerCents,
  };
}
