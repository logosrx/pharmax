// RecordManualPayment — operator-recorded out-of-band payment
// (check / ACH / wire / cash) against an OPEN invoice.
//
// Pipeline:
//
//   1. Operator (BillingManager) receives a clinic's check, deposits
//      it, and records it: "Record $X on invoice Y, check #1234".
//   2. This command validates the invoice is OPEN and the amount
//      does not exceed the remaining balance.
//   3. Increments `amountPaidCents` / decrements `amountDueCents`
//      (CAS on `version` — a concurrent credit or second payment
//      surfaces as a typed conflict, not a lost update).
//   4. Appends the PAYMENT row to the payment ledger (method MANUAL,
//      key `manual:{ulid}`) in the SAME transaction — projection and
//      ledger can never disagree on a partial commit.
//   5. When the payment collects the full remaining balance, flips
//      OPEN → PAID and stamps `paidAt` with the money's receive date.
//   6. Emits `billing.payment.recorded.v1` (always) and
//      `billing.invoice.paid.v1` (only on the PAID flip).
//
// SETTLED-ONLY, like every ledger writer: the operator records the
// payment when the money is in hand (deposited check, landed wire),
// not when it is promised. A bounced check is a correction flow
// (future offsetting row), not a ledger delete.
//
// Partial payments are first-class: a $600 check against a $1000
// invoice leaves it OPEN with amountPaid=600 / amountDue=400, and
// the ledger carries one row per collection. The nightly
// reconciliation verifier checks OPEN invoices' ledger parity with
// exactly this shape in mind.
//
// Overpayments are REJECTED (amount > amountDue). A clinic that
// overpays gets the invoice's remainder recorded here and the excess
// granted as clinic credit (GrantClinicCredit) — never a silently
// negative amountDue.
//
// Deliberately NOT handled here:
//
//   - DRAFT invoices: finalize first (FinalizeInvoice). Money against
//     a mutable line set makes reconciliation ambiguous.
//   - PAID invoices: nothing left to collect; an extra check is an
//     overpayment by definition.
//   - UNCOLLECTIBLE: a late payment on a written-off invoice is a
//     real scenario, but it needs an explicit reopen decision first —
//     silently resurrecting a write-off would corrupt the aging story.
//   - Stripe interplay: if this invoice was also pushed to Stripe,
//     recording a manual settle here does NOT void the Stripe-side
//     invoice. The operator must void it in Stripe (surfaced in the
//     audit metadata via `stripeInvoiceId` so the console can warn).
//
// Idempotency:
//
//   - Bus-level: the command idempotency key short-circuits retries
//     and double-clicks (same key → cached result, handler not
//     re-run).
//   - Ledger-level: `manual:{ulid}` is generated inside the handler
//     and commits atomically with the command log, so a rolled-back
//     attempt leaves no row and a committed one is never re-executed.
//
// PHI invariant: none. Amounts, instrument kind, and a bank-side
// reference number only. `operatorNote` is free-text (NOT PHI by
// convention but redacted from command_log per defense in depth).

import type { Command, HandlerResult, OutboxEventDraft } from "@pharmax/command-bus";
import { InvoiceStatus, PaymentKind, PaymentMethod } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  insertPaymentLedgerRow,
  type PaymentLedgerRowInput,
  paymentRecordedOutboxEvent,
} from "../payments/payment-ledger.js";

export const RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND = "RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND";
export const RECORD_MANUAL_PAYMENT_INVALID_STATUS = "RECORD_MANUAL_PAYMENT_INVALID_STATUS";
export const RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE = "RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE";
export const RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE =
  "RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE";
export const RECORD_MANUAL_PAYMENT_VERSION_MISMATCH = "RECORD_MANUAL_PAYMENT_VERSION_MISMATCH";

/** How the money arrived. Stored in ledger metadata, not a column — the ledger's `method` is MANUAL for all of these. */
export const MANUAL_PAYMENT_INSTRUMENTS = ["CHECK", "ACH", "WIRE", "CASH", "OTHER"] as const;
export type ManualPaymentInstrument = (typeof MANUAL_PAYMENT_INSTRUMENTS)[number];

/** Tolerated clock skew when validating `receivedAt` against now. */
const RECEIVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    /** Positive cents. Capped at $100k — larger amounts deserve a human double-take and a split entry. */
    amountCents: z.number().int().min(1).max(100_000_00),
    instrument: z.enum(MANUAL_PAYMENT_INSTRUMENTS),
    /** Bank-side reference: check number, ACH trace id, wire reference. Not PHI. */
    referenceNumber: z.string().min(1).max(128).optional(),
    /**
     * When the money was actually received (check deposit date, wire
     * landing date). Defaults to now. Backdating is expected — checks
     * are often recorded days after deposit; future dates are not.
     */
    receivedAt: z.iso.datetime({ offset: true }).optional(),
    /** Free-text operator note. Redacted from command_log per defense-in-depth. */
    operatorNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type RecordManualPaymentInput = z.infer<typeof inputSchema>;

export interface RecordManualPaymentOutput {
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly amountCents: number;
  readonly amountPaidCentsAfter: number;
  readonly amountDueCentsAfter: number;
  /** True when this payment collected the full remaining balance. */
  readonly fullyPaid: boolean;
  readonly status: InvoiceStatus;
  readonly version: number;
}

export const RecordManualPayment: Command<RecordManualPaymentInput, RecordManualPaymentOutput> = {
  name: "RecordManualPayment",
  inputSchema,
  permission: PERMISSIONS.BILLING_RECORD_MANUAL_PAYMENT,
  redactFields: ["operatorNote"],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<RecordManualPaymentOutput>> {
    const now = clock.now();

    // ---- receivedAt sanity ----
    const receivedAt = input.receivedAt !== undefined ? new Date(input.receivedAt) : now;
    if (receivedAt.getTime() > now.getTime() + RECEIVED_AT_FUTURE_SKEW_MS) {
      throw new errors.ValidationError({
        code: RECORD_MANUAL_PAYMENT_RECEIVED_AT_IN_FUTURE,
        message: "receivedAt is in the future. The ledger records money that has already moved.",
        metadata: { receivedAt: receivedAt.toISOString(), now: now.toISOString() },
      });
    }

    // ---- Load + validate invoice ----
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        status: true,
        currency: true,
        totalCents: true,
        amountPaidCents: true,
        amountDueCents: true,
        stripeInvoiceId: true,
        stripeChargeId: true,
        invoiceNumber: true,
        version: true,
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: RECORD_MANUAL_PAYMENT_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }

    switch (invoice.status) {
      case InvoiceStatus.OPEN:
        break;
      case InvoiceStatus.DRAFT:
        throw new errors.ConflictError({
          code: RECORD_MANUAL_PAYMENT_INVALID_STATUS,
          message:
            "Invoice is still DRAFT — finalize it first (FinalizeInvoice) so the line set is locked before money is recorded against it.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.PAID:
        throw new errors.ConflictError({
          code: RECORD_MANUAL_PAYMENT_INVALID_STATUS,
          message:
            "Invoice is already PAID — nothing left to collect. An additional payment is an overpayment; handle it as a credit-balance workflow.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.VOID:
        throw new errors.ConflictError({
          code: RECORD_MANUAL_PAYMENT_INVALID_STATUS,
          message: "Invoice is VOID — payments cannot be recorded against a voided invoice.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      case InvoiceStatus.UNCOLLECTIBLE:
        throw new errors.ConflictError({
          code: RECORD_MANUAL_PAYMENT_INVALID_STATUS,
          message:
            "Invoice was written off as UNCOLLECTIBLE. A late payment requires an explicit reopen decision before it can be recorded.",
          metadata: { invoiceId: invoice.id, status: invoice.status },
        });
      default: {
        const _never: never = invoice.status;
        throw new Error(`unhandled InvoiceStatus: ${String(_never)}`);
      }
    }

    // ---- Overpayment guard ----
    if (input.amountCents > invoice.amountDueCents) {
      throw new errors.ConflictError({
        code: RECORD_MANUAL_PAYMENT_AMOUNT_EXCEEDS_DUE,
        message: `Payment amount (${input.amountCents}c) exceeds the remaining balance (${invoice.amountDueCents}c). Record the remaining balance here, then grant the excess as clinic credit (GrantClinicCredit).`,
        metadata: {
          invoiceId: invoice.id,
          attemptedCents: input.amountCents,
          amountDueCents: invoice.amountDueCents,
        },
      });
    }

    const amountPaidCentsAfter = invoice.amountPaidCents + input.amountCents;
    const amountDueCentsAfter = invoice.amountDueCents - input.amountCents;
    const fullyPaid = amountDueCentsAfter === 0;
    const nextVersion = invoice.version + 1;

    // ---- CAS update ----
    // Same pattern as MarkInvoicePaid: updateMany on (id, version)
    // so a concurrent credit / second payment / Stripe settle
    // surfaces as a retryable conflict instead of a lost update.
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        amountPaidCents: { increment: input.amountCents },
        amountDueCents: { decrement: input.amountCents },
        version: nextVersion,
        ...(fullyPaid ? { status: InvoiceStatus.PAID, paidAt: receivedAt } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: RECORD_MANUAL_PAYMENT_VERSION_MISMATCH,
        message:
          "Invoice version was bumped by a concurrent mutation. Re-read the balance and retry.",
        metadata: { invoiceId: invoice.id, attemptedVersion: invoice.version },
      });
    }

    // ---- Append the PAYMENT ledger row ----
    // Fresh ulid key: the row commits atomically with the command
    // log, and the bus's idempotency cache prevents handler re-runs
    // for the same idempotency key, so the key never needs to be
    // deterministic across invocations.
    const hasOperatorNote =
      typeof input.operatorNote === "string" && input.operatorNote.trim().length > 0;
    const ledgerRow: PaymentLedgerRowInput = {
      organizationId: ctx.organizationId,
      clinicId: invoice.clinicId,
      invoiceId: invoice.id,
      kind: PaymentKind.PAYMENT,
      method: PaymentMethod.MANUAL,
      amountCents: input.amountCents,
      currency: invoice.currency,
      paymentEventKey: `manual:${ids.generateUlid()}`,
      occurredAt: receivedAt,
      metadata: {
        sourceEvent: "operator-manual-payment",
        instrument: input.instrument,
        referenceNumber: input.referenceNumber ?? null,
        recordedByUserId: ctx.actor.userId,
        hasOperatorNote,
        commandLogId,
      },
    };
    const ledgerResult = await insertPaymentLedgerRow(tx, ledgerRow);
    const paymentOutboxEvents: OutboxEventDraft[] = ledgerResult.created
      ? [paymentRecordedOutboxEvent({ paymentId: ledgerResult.paymentId, row: ledgerRow })]
      : [];

    return {
      output: {
        invoiceId: invoice.id,
        paymentId: ledgerResult.paymentId,
        amountCents: input.amountCents,
        amountPaidCentsAfter,
        amountDueCentsAfter,
        fullyPaid,
        status: fullyPaid ? InvoiceStatus.PAID : InvoiceStatus.OPEN,
        version: nextVersion,
      },
      audit: {
        action: "billing.invoice.manual_payment_recorded",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          paymentId: ledgerResult.paymentId,
          instrument: input.instrument,
          referenceNumber: input.referenceNumber ?? null,
          amountCents: input.amountCents,
          amountPaidCentsAfter,
          amountDueCentsAfter,
          fullyPaid,
          receivedAt: receivedAt.toISOString(),
          // Non-null means this invoice ALSO lives in Stripe — the
          // operator should void the Stripe-side invoice so the
          // clinic isn't auto-charged for a balance already paid.
          stripeInvoiceId: invoice.stripeInvoiceId,
          hasOperatorNote,
          recordedByUserId: ctx.actor.userId,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        ...paymentOutboxEvents,
        ...(fullyPaid
          ? [
              {
                eventType: "billing.invoice.paid.v1",
                aggregateType: "Invoice",
                aggregateId: invoice.id,
                payload: {
                  organizationId: ctx.organizationId,
                  clinicId: invoice.clinicId,
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  stripeInvoiceId: invoice.stripeInvoiceId,
                  stripeChargeId: invoice.stripeChargeId,
                  amountPaidCents: amountPaidCentsAfter,
                  totalCents: invoice.totalCents,
                  paidAt: receivedAt.toISOString(),
                  occurredAt: now.toISOString(),
                },
              } satisfies OutboxEventDraft,
            ]
          : []),
      ],
    };
  },
};
