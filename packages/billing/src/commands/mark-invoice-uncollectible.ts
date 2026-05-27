// MarkInvoiceUncollectible — Stripe fired `invoice.marked_uncollectible`
// (collection retries exhausted; Stripe is giving up). Terminal status,
// flagged so the aging report excludes it and so manual write-off /
// collections workflows can pick it up.
//
// Same shape as MarkInvoiceVoided — status flip + cleared amountDue +
// idempotency + orphan-tolerance.

import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

export const MARK_UNCOLLECTIBLE_VERSION_MISMATCH = "MARK_UNCOLLECTIBLE_VERSION_MISMATCH";
export const MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION =
  "MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION";

const inputSchema = z
  .object({
    invoiceId: z.uuid(),
    organizationId: z.uuid(),
    stripeInvoiceId: z.string().min(1).max(128),
    recordedAt: z.iso.datetime({ offset: true }),
    stripeEventId: z.string().min(1).max(128),
  })
  .strict();

export type MarkInvoiceUncollectibleInput = z.infer<typeof inputSchema>;

export interface MarkInvoiceUncollectibleOutput {
  readonly invoiceId: string;
  readonly recognized: boolean;
  readonly transitioned: boolean;
  readonly status: InvoiceStatus;
  readonly version: number;
}

export const MarkInvoiceUncollectible: SystemCommand<
  MarkInvoiceUncollectibleInput,
  MarkInvoiceUncollectibleOutput
> = {
  name: "MarkInvoiceUncollectible",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<MarkInvoiceUncollectibleOutput>> {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        version: true,
        stripeInvoiceId: true,
        invoiceNumber: true,
        clinicId: true,
        amountDueCents: true,
      },
    });

    const now = clock.now();

    if (invoice === null) {
      return {
        output: {
          invoiceId: input.invoiceId,
          recognized: false,
          transitioned: false,
          status: InvoiceStatus.OPEN,
          version: 0,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.invoice.stripe_uncollectible.unrecognized",
          resourceType: "Invoice",
          resourceId: input.invoiceId,
          metadata: {
            invoiceId: input.invoiceId,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeEventId: input.stripeEventId,
            reason: "invoice-not-found",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    if (invoice.stripeInvoiceId !== null && invoice.stripeInvoiceId !== input.stripeInvoiceId) {
      throw new errors.ConflictError({
        code: "MARK_UNCOLLECTIBLE_STRIPE_INVOICE_MISMATCH",
        message:
          "Pharmax invoice is linked to a DIFFERENT Stripe invoice than the inbound webhook. Investigate before retrying.",
        metadata: {
          invoiceId: invoice.id,
          existingStripeInvoiceId: invoice.stripeInvoiceId,
          inboundStripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
        },
      });
    }

    if (invoice.status === InvoiceStatus.UNCOLLECTIBLE) {
      return {
        output: {
          invoiceId: invoice.id,
          recognized: true,
          transitioned: false,
          status: invoice.status,
          version: invoice.version,
        },
        targetOrganizationId: invoice.organizationId,
        audit: {
          action: "billing.invoice.stripe_uncollectible.skipped",
          resourceType: "Invoice",
          resourceId: invoice.id,
          metadata: {
            invoiceId: invoice.id,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeEventId: input.stripeEventId,
            reason: "already-uncollectible",
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
        outboxEvents: [],
      };
    }

    if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.VOID) {
      throw new errors.ConflictError({
        code: MARK_UNCOLLECTIBLE_INVALID_STATUS_TRANSITION,
        message: `Cannot mark uncollectible from terminal status ${invoice.status}.`,
        metadata: {
          invoiceId: invoice.id,
          currentStatus: invoice.status,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
        },
      });
    }

    const recordedAtDate = new Date(input.recordedAt);
    const nextVersion = invoice.version + 1;
    const updated = await tx.invoice.updateMany({
      where: { id: invoice.id, version: invoice.version },
      data: {
        status: InvoiceStatus.UNCOLLECTIBLE,
        amountDueCents: 0,
        version: nextVersion,
        ...(invoice.stripeInvoiceId === null ? { stripeInvoiceId: input.stripeInvoiceId } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new errors.ConflictError({
        code: MARK_UNCOLLECTIBLE_VERSION_MISMATCH,
        message:
          "Invoice version was bumped by a concurrent mutation. Drain will retry once the racer commits.",
        metadata: { invoiceId: invoice.id, attemptedVersion: invoice.version },
      });
    }

    return {
      output: {
        invoiceId: invoice.id,
        recognized: true,
        transitioned: true,
        status: InvoiceStatus.UNCOLLECTIBLE,
        version: nextVersion,
      },
      targetOrganizationId: invoice.organizationId,
      audit: {
        action: "billing.invoice.stripe_uncollectible",
        resourceType: "Invoice",
        resourceId: invoice.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clinicId: invoice.clinicId,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeEventId: input.stripeEventId,
          previousStatus: invoice.status,
          newStatus: InvoiceStatus.UNCOLLECTIBLE,
          residualWriteOffCents: invoice.amountDueCents,
          recordedAt: recordedAtDate.toISOString(),
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice.uncollectible.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.id,
          payload: {
            organizationId: invoice.organizationId,
            clinicId: invoice.clinicId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            stripeInvoiceId: input.stripeInvoiceId,
            residualWriteOffCents: invoice.amountDueCents,
            recordedAt: recordedAtDate.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
