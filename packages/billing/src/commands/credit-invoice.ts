// CreditInvoice — apply a manual credit, discount, or adjustment to
// an invoice.
//
// Pattern:
//
//   The credit is recorded as an `InvoiceLine` with a NEGATIVE
//   `amountCents`. We do NOT mutate or delete the original line(s) —
//   the audit trail must show "we billed for X, then credited Y back".
//   The invoice totals are atomically decremented via Prisma's
//   `{ decrement }` (which compiles to `column = column - N`).
//
// Why negative-amount lines instead of a separate `credit_note` table:
//
//   - `InvoiceLineKind` already includes `CREDIT`, `DISCOUNT`, and
//     `ADJUSTMENT` — the schema was designed for this exact pattern.
//   - One read path for "what's on this invoice" instead of joining
//     two tables and unioning amounts.
//   - Stripe's own model is the same shape: invoice items can be
//     negative (credit notes attach to an invoice via items).
//
// Lifecycle guards:
//
//   - VOID invoices: refuse. A void invoice has zero collectability;
//     a credit against it is a UX bug — surface `CREDIT_INVOICE_VOIDED`.
//   - PAID invoices: allowed (operator is issuing a post-payment
//     credit that turns into a refund obligation, tracked via the
//     `amountDueCents` going negative).
//   - DRAFT / OPEN invoices: the common case. Credits adjust the
//     current bill before sending or during the collection window.
//
//   - Amount may NOT exceed the invoice's current `totalCents`.
//     Allowing a credit to drive `amountDueCents` past the original
//     amount creates accounting ambiguity (is it a refund? a future
//     credit? both?). Surface as `CREDIT_INVOICE_EXCEEDS_TOTAL` and
//     force the operator to issue a refund instead.
//
// Idempotency:
//
//   - The bus's idempotency cache covers re-dispatch of the same
//     operator action (double-clicks, retries).
//   - The negative line's `billingEventKey = "manual-credit:{ulid}"`
//     uses a fresh ulid per command invocation so distinct operator
//     actions for the same invoice produce distinct rows; deliberate
//     repeats (the operator wants to issue a second credit) get a
//     fresh ulid by being a fresh command call.
//
// PHI: no PHI. `reasonText` is free-text operator note and MAY
// contain PHI by accident; redacted from `command_log.requestPayload`,
// surfaced as a boolean `hasReasonText` flag in audit + outbox —
// same pattern as PlaceHold / CancelOrder / ResolveOrderEscalation.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { InvoiceLineKind, InvoiceStatus, type Prisma } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const CREDIT_INVOICE_NOT_FOUND = "CREDIT_INVOICE_NOT_FOUND";
export const CREDIT_INVOICE_VOIDED = "CREDIT_INVOICE_VOIDED";
export const CREDIT_INVOICE_EXCEEDS_TOTAL = "CREDIT_INVOICE_EXCEEDS_TOTAL";
export const CREDIT_INVOICE_AMOUNT_INVALID = "CREDIT_INVOICE_AMOUNT_INVALID";

export const CREDIT_INVOICE_KINDS = [
  InvoiceLineKind.CREDIT,
  InvoiceLineKind.DISCOUNT,
  InvoiceLineKind.ADJUSTMENT,
] as const;

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    /**
     * POSITIVE cents (the handler negates internally). Required so
     * the operator UI doesn't accidentally pass a negative value
     * twice and double-flip the sign.
     */
    amountCents: z.number().int().min(1).max(10_000_00),
    kind: z.enum(CREDIT_INVOICE_KINDS),
    /** Operator-facing line description ("Goodwill credit for late delivery"). */
    description: z.string().min(1).max(500),
    /**
     * Optional free-text note. MAY contain PHI; redacted from
     * `command_log.requestPayload`. Surfaced as `hasReasonText`
     * boolean on audit + outbox.
     */
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type CreditInvoiceInput = z.infer<typeof inputSchema>;

export interface CreditInvoiceOutput {
  readonly invoiceId: string;
  readonly invoiceLineId: string;
  /** Negative — the amount applied as a credit. */
  readonly creditAmountCents: number;
  /** Post-credit invoice subtotal. */
  readonly subtotalCentsAfter: number;
  readonly totalCentsAfter: number;
  readonly amountDueCentsAfter: number;
}

export const CreditInvoice: Command<CreditInvoiceInput, CreditInvoiceOutput> = {
  name: "CreditInvoice",
  inputSchema,
  permission: PERMISSIONS.BILLING_CREDIT_INVOICE,
  redactFields: ["reasonText"],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<CreditInvoiceOutput>> {
    if (input.amountCents <= 0) {
      throw new errors.ValidationError({
        code: CREDIT_INVOICE_AMOUNT_INVALID,
        message: "Credit amount must be a positive integer (cents).",
        metadata: { amountCents: input.amountCents },
      });
    }

    // Load tenant-scoped — RLS would block a cross-org id from
    // resolving even without this filter, but the explicit predicate
    // keeps the failure mode predictable.
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: ctx.organizationId },
      select: {
        id: true,
        clinicId: true,
        status: true,
        currency: true,
        subtotalCents: true,
        totalCents: true,
        amountDueCents: true,
        invoiceNumber: true,
      },
    });
    if (invoice === null) {
      throw new errors.NotFoundError({
        code: CREDIT_INVOICE_NOT_FOUND,
        message: "Invoice not found in this organization.",
        metadata: { invoiceId: input.invoiceId },
      });
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new errors.ConflictError({
        code: CREDIT_INVOICE_VOIDED,
        message: "Cannot apply a credit to a voided invoice.",
        metadata: { invoiceId: invoice.id, status: invoice.status },
      });
    }
    if (input.amountCents > invoice.totalCents) {
      throw new errors.ConflictError({
        code: CREDIT_INVOICE_EXCEEDS_TOTAL,
        message:
          "Credit amount exceeds the invoice total. Issue a refund through the refund flow instead of crediting past zero.",
        metadata: {
          invoiceId: invoice.id,
          amountCents: input.amountCents,
          totalCents: invoice.totalCents,
        },
      });
    }

    const negativeAmount = -input.amountCents;
    const reasonText =
      typeof input.reasonText === "string" && input.reasonText.trim().length > 0
        ? input.reasonText
        : null;
    const hasReasonText = reasonText !== null;
    const billingEventKey = `manual-credit:${ids.generateUlid()}`;
    const invoiceLineId = ids.generateUlid();

    // Insert the negative line. The billingEventKey is anchored on
    // a fresh ulid per command invocation, so the unique constraint
    // never collides under normal operation; if it did, we surface
    // the cause unchanged via the bus's standard error path.
    await tx.invoiceLine.create({
      data: {
        id: invoiceLineId,
        invoiceId: invoice.id,
        organizationId: ctx.organizationId,
        clinicId: invoice.clinicId,
        kind: input.kind,
        description: input.description,
        quantity: 1,
        unitAmountCents: negativeAmount,
        amountCents: negativeAmount,
        billingEventKey,
        metadata: {
          sourceEvent: "manual-credit",
          issuedByUserId: ctx.actor.userId,
          hasReasonText,
        } satisfies Prisma.InputJsonValue,
      },
    });

    // Roll the invoice totals atomically. `{ decrement }` compiles
    // to `column = column - N` — safe under concurrent appends and
    // does not require a CAS bump on `version`.
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        subtotalCents: { decrement: input.amountCents },
        totalCents: { decrement: input.amountCents },
        amountDueCents: { decrement: input.amountCents },
        version: { increment: 1 },
      },
    });

    const subtotalCentsAfter = invoice.subtotalCents - input.amountCents;
    const totalCentsAfter = invoice.totalCents - input.amountCents;
    const amountDueCentsAfter = invoice.amountDueCents - input.amountCents;
    const now = clock.now();

    return {
      output: {
        invoiceId: invoice.id,
        invoiceLineId,
        creditAmountCents: negativeAmount,
        subtotalCentsAfter,
        totalCentsAfter,
        amountDueCentsAfter,
      },
      audit: {
        action: "billing.invoice.credited",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          invoiceLineId,
          kind: input.kind,
          creditAmountCents: negativeAmount,
          amountCents: input.amountCents,
          subtotalCentsBefore: invoice.subtotalCents,
          subtotalCentsAfter,
          totalCentsBefore: invoice.totalCents,
          totalCentsAfter,
          amountDueCentsAfter,
          billingEventKey,
          hasReasonText,
          issuedByUserId: ctx.actor.userId,
          recordedAt: now.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.credited.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceLineId,
            kind: input.kind,
            creditAmountCents: negativeAmount,
            subtotalCentsAfter,
            totalCentsAfter,
            amountDueCentsAfter,
            hasReasonText,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
