// Outbox handler for `billing.invoice.finalized.v1` that pushes
// the finalized Pharmax invoice to Stripe.
//
// Why an outbox handler (vs. inline inside FinalizeInvoice):
//
//   - The Stripe SDK call lives outside any Pharmax transaction
//     (network roundtrip with multi-second tail latency). Coupling
//     it to the operator's `Finalize` click would put Stripe outage
//     surface in front of a 200ms UI action.
//
//   - Stripe push is idempotent on `pharmax-invoice:{id}`, so an
//     outbox retry after a transient Stripe outage converges on
//     the same Stripe invoice rather than creating duplicates.
//
//   - A missing or unconfigured Stripe SDK is a deployment shape,
//     not a workflow error. When `STRIPE_SECRET_KEY` is unset the
//     handler logs + no-ops; the invoice stays in OPEN status with
//     no `stripeInvoiceId` and a future operator can re-push by
//     re-finalizing or running a backfill.
//
// PHI: no PHI is read or written. Invoice line descriptions are
// sanitized at materialization time.

import { executeSystemCommand } from "@pharmax/command-bus";
import {
  RecordStripeInvoicePushed,
  STRIPE_PUSH_CUSTOMER_NOT_LINKED,
  type StripeInvoicePort,
  type StripePushLine,
  type StripePushResult,
} from "@pharmax/billing";
import type { PrismaClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

import type { OutboxEventHandler } from "./outbox-handlers.js";

const meter = getMeter("@pharmax/worker.billing");

const billingStripePushCounter = meter.createCounter("pharmax_billing_stripe_push_total", {
  description: "Stripe invoice push attempts. Outcome is one of success | fail | skipped.",
});

export interface CreatePushInvoiceToStripeHandlerOptions {
  readonly client: PrismaClient;
  /**
   * Stripe port. When `null`, the handler logs that Stripe is not
   * configured and short-circuits (no error, no retry storm).
   */
  readonly stripePort: StripeInvoicePort | null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface ResolvedPushContext {
  readonly stripeCustomerId: string;
  readonly daysUntilDue: number;
  readonly lines: ReadonlyArray<StripePushLine>;
}

async function resolveStripePushContext(input: {
  client: PrismaClient;
  organizationId: string;
  clinicId: string;
  invoiceId: string;
}): Promise<ResolvedPushContext | "no-customer-link"> {
  return withSystemContext("worker-drain:billing-stripe-push-resolve", async () => {
    const customer = await input.client.stripeCustomer.findUnique({
      where: { clinicId: input.clinicId },
      select: { stripeCustomerId: true, organizationId: true },
    });
    if (customer === null || customer.organizationId !== input.organizationId) {
      return "no-customer-link";
    }

    const invoice = await input.client.invoice.findUnique({
      where: { id: input.invoiceId },
      select: {
        issuedAt: true,
        dueAt: true,
        lines: {
          select: {
            id: true,
            description: true,
            quantity: true,
            unitAmountCents: true,
            amountCents: true,
          },
        },
      },
    });
    if (invoice === null) {
      return "no-customer-link";
    }

    // daysUntilDue derivable from (dueAt - issuedAt); default 30
    // if either is missing (shouldn't happen post-FinalizeInvoice).
    const daysUntilDue =
      invoice.issuedAt !== null && invoice.dueAt !== null
        ? Math.max(
            0,
            Math.round((invoice.dueAt.getTime() - invoice.issuedAt.getTime()) / (24 * 60 * 60_000))
          )
        : 30;

    const lines: StripePushLine[] = invoice.lines.map((l) =>
      Object.freeze({
        pharmaxLineId: l.id,
        description: l.description,
        quantity: Number(l.quantity),
        unitAmountCents: l.unitAmountCents,
        amountCents: l.amountCents,
      })
    );

    return Object.freeze({
      stripeCustomerId: customer.stripeCustomerId,
      daysUntilDue,
      lines,
    });
  });
}

export function createPushInvoiceToStripeHandler(
  options: CreatePushInvoiceToStripeHandlerOptions
): OutboxEventHandler {
  const { client, stripePort } = options;

  return async (row, ctx): Promise<void> => {
    if (stripePort === null) {
      billingStripePushCounter.add(1, { outcome: "skipped" });
      ctx.logger.info("outbox.billing.invoice.finalized.v1 skipped (stripe not configured)", {
        outboxId: row.id,
      });
      return;
    }

    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const organizationId = readString(payload, "organizationId") ?? row.organizationId;
    const clinicId = readString(payload, "clinicId");
    const invoiceId = readString(payload, "invoiceId");
    const invoiceNumber = readString(payload, "invoiceNumber");
    const currency = readString(payload, "currency") ?? "usd";
    const totalCents = readInt(payload, "totalCents");

    if (clinicId === null || invoiceId === null || invoiceNumber === null || totalCents === null) {
      throw new errors.InternalError({
        code: "STRIPE_PUSH_HANDLER_PAYLOAD_INCOMPLETE",
        message:
          "billing.invoice.finalized.v1 payload is missing one or more required Stripe-push fields.",
        metadata: {
          outboxId: row.id,
          present: {
            clinicId: clinicId !== null,
            invoiceId: invoiceId !== null,
            invoiceNumber: invoiceNumber !== null,
            totalCents: totalCents !== null,
          },
        },
      });
    }

    // Resolve customer + lines in system context (the outbox row
    // is tenant-less from this drain's perspective; the payload
    // is the only auth signal).
    const resolved = await resolveStripePushContext({
      client,
      organizationId,
      clinicId,
      invoiceId,
    });
    if (resolved === "no-customer-link") {
      throw new errors.InternalError({
        code: STRIPE_PUSH_CUSTOMER_NOT_LINKED,
        message:
          "No StripeCustomer row for this clinic. Provision the Stripe-customer linkage before finalizing invoices.",
        metadata: { organizationId, clinicId, invoiceId },
      });
    }

    // Push to Stripe (HTTP call; lives outside the Pharmax tx).
    // Any throw bubbles unchanged — the worker's retry policy
    // determines whether to back off or send to DLQ.
    let result: StripePushResult;
    try {
      result = await stripePort.pushInvoice({
        organizationId,
        clinicId,
        pharmaxInvoiceId: invoiceId,
        invoiceNumber,
        stripeCustomerId: resolved.stripeCustomerId,
        currency,
        daysUntilDue: resolved.daysUntilDue,
        lines: resolved.lines,
      });
    } catch (cause) {
      billingStripePushCounter.add(1, { outcome: "fail" });
      throw cause;
    }
    billingStripePushCounter.add(1, { outcome: "success" });

    // Write the linkage back through the standard command bus so
    // it lands with an audit row + downstream outbox event.
    await withSystemContext("worker-drain:billing-stripe-push-record", async () =>
      executeSystemCommand(RecordStripeInvoicePushed, {
        organizationId,
        invoiceId,
        stripeInvoiceId: result.stripeInvoiceId,
        stripeCustomerId: resolved.stripeCustomerId,
        stripeStatus: result.stripeStatus,
        ...(result.hostedInvoiceUrl !== null ? { hostedInvoiceUrl: result.hostedInvoiceUrl } : {}),
      })
    );

    ctx.logger.info("outbox.billing.invoice.finalized.v1 pushed to stripe", {
      outboxId: row.id,
      organizationId,
      invoiceId,
      invoiceNumber,
      stripeInvoiceId: result.stripeInvoiceId,
      stripeStatus: result.stripeStatus,
      lineCount: resolved.lines.length,
      totalCents,
    });
  };
}
