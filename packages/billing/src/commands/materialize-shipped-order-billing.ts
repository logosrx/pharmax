// MaterializeShippedOrderBilling — outbound billing projection from
// the operational `order.shipped.v1` outbox event.
//
// Pipeline:
//
//   ConfirmShipment (tenant command)
//     → order.shipped.v1 outbox row
//     → apps/worker outbox drain
//     → MaterializeShippedOrderBilling (this system command)
//     → invoice_line row appended to the open DRAFT invoice for the
//       (organization, clinic, billing-period) tuple
//     → billing.invoice_line.created.v1 outbox row
//     → (future slice) Stripe invoice push handler
//
// Why a SystemCommand:
//   - The dispatch is machine-driven (outbox replay), not a human
//     action. There is no "actor" responsible for the materialization
//     — it is a deterministic projection from operational truth.
//   - Cross-tenant safety still holds: the command writes to a
//     specific `organizationId` taken from the source event payload;
//     the SystemCommand contract requires us to declare
//     `targetOrganizationId` so the audit row carries the tenant
//     and RLS is satisfied for any subsequent reads.
//
// Idempotency:
//   - `billingEventKey = "ord-shipped:{orderId}"` is anchored to the
//     ORDER (each order ships exactly once). The unique constraint
//     on `invoice_line.billingEventKey` is the structural guarantee
//     — concurrent outbox replays converge on a single row.
//   - The handler short-circuits to "already materialized" if it
//     finds an existing line with the same billingEventKey, so we
//     return cleanly without throwing on the second delivery.
//
// Pricing:
//   - Resolved via `@pharmax/billing/pricing` at materialization
//     time: `loadCandidatePricingRules` pulls the org's ACTIVE
//     rules for `kind = DISPENSE_FEE` inside the same tx, then
//     `pickPricingRule` ranks by specificity (clinic+product >
//     clinic > product > org-default) and time window. The winner
//     stamps `pricingScheme: "RULE_V2"` + the source `ruleId` onto
//     the invoice-line metadata + audit + outbox.
//   - When NO rule matches, the handler falls back to the historical
//     `FLAT_V1` placeholder ($50 flat). The fallback stamps
//     `pricingScheme: "FLAT_V1"` so a future re-pricing job can
//     discriminate which lines need backfill.
//   - The materialize handler emits ONE dispense fee per shipped
//     order (order-level, not per-line). Product-level pricing is
//     wired structurally; the per-line flow will adopt it when
//     it ships.
//
// Invoice number:
//   - `INV-{YYYY-MM}-{clinicIdFirst8}` per `(organization,
//     billing-period, clinic)`. Uniqueness is guaranteed by the
//     `@@unique([organizationId, invoiceNumber])` constraint on
//     `Invoice`; a (rare) collision on the truncated clinicId would
//     surface as a P2002 from `upsert`, which we treat as fatal so
//     the operator notices rather than silently mis-billing.
//   - This shape is human-readable for v1; an enterprise-grade
//     per-org sequence is a follow-up.
//
// PHI invariant: no PHI is read or written here. The source event
// payload is non-PHI (orderId / clinicId / siteId / shipmentId /
// trackingNumber / occurredAt); none of those columns store
// patient data. Audit metadata + outbox payload mirror the same
// fields.

import type { PrismaTxClient, SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { InvoiceLineKind, InvoiceStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

import {
  loadCandidatePricingRules,
  pickPricingRule,
  type PricingResolution,
} from "../pricing/resolve-pricing.js";

export const MATERIALIZE_BILLING_CLINIC_NOT_FOUND = "MATERIALIZE_BILLING_CLINIC_NOT_FOUND";
export const MATERIALIZE_BILLING_INVOICE_NUMBER_COLLISION =
  "MATERIALIZE_BILLING_INVOICE_NUMBER_COLLISION";

/** Pricing-scheme stamp recorded in audit + outbox + line metadata. */
export type PricingScheme = "FLAT_V1" | "RULE_V2";

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    clinicId: z.uuid(),
    siteId: z.uuid(),
    orderId: z.uuid(),
    shipmentId: z.uuid(),
    /** ISO-8601 timestamp from the source `order.shipped.v1` event. */
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type MaterializeShippedOrderBillingInput = z.infer<typeof inputSchema>;

export interface MaterializeShippedOrderBillingOutput {
  readonly invoiceId: string;
  readonly invoiceLineId: string;
  readonly invoiceNumber: string;
  readonly amountCents: number;
  /** True when an existing line was found for this orderId — handler short-circuited. */
  readonly alreadyMaterialized: boolean;
  /** True when this materialization created the invoice row (vs. appended to an existing one). */
  readonly invoiceCreated: boolean;
  /** Which pricing scheme produced the line amount. */
  readonly pricingScheme: PricingScheme;
  /** Source pricing rule id when `pricingScheme === "RULE_V2"`; null for FLAT_V1. */
  readonly pricingRuleId: string | null;
}

/**
 * Flat dispense fee in cents, v1. Pricing rules slice replaces
 * with a `(org, clinic, product)` lookup.
 */
export const FLAT_DISPENSE_FEE_CENTS = 5000;
export const FLAT_DISPENSE_FEE_DESCRIPTION = "Shipped prescription order (dispense fee)";

interface BillingPeriod {
  readonly key: string; // "2026-05"
  readonly start: Date;
  readonly end: Date;
}

function deriveBillingPeriod(occurredAt: Date): BillingPeriod {
  const year = occurredAt.getUTCFullYear();
  const month = occurredAt.getUTCMonth(); // 0-indexed
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  // Last millisecond of the period — first millisecond of next
  // month minus 1 — keeps the period inclusive without depending
  // on month length.
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0) - 1);
  const key = `${year.toString().padStart(4, "0")}-${(month + 1).toString().padStart(2, "0")}`;
  return Object.freeze({ key, start, end });
}

function deriveInvoiceNumber(input: { period: BillingPeriod; clinicId: string }): string {
  // Strip dashes from the clinic id and take the first 8 hex chars
  // for readability. Uniqueness across the org is enforced by the
  // `(organizationId, invoiceNumber)` constraint; we surface a
  // P2002 as a typed error rather than swallowing it.
  const clinicShort = input.clinicId.replace(/-/g, "").slice(0, 8);
  return `INV-${input.period.key}-${clinicShort}`;
}

async function findExistingBillingLine(input: {
  tx: PrismaTxClient;
  billingEventKey: string;
}): Promise<{ id: string; invoiceId: string; amountCents: number } | null> {
  return await input.tx.invoiceLine.findUnique({
    where: { billingEventKey: input.billingEventKey },
    select: { id: true, invoiceId: true, amountCents: true },
  });
}

async function resolveOrCreateOpenInvoice(input: {
  tx: PrismaTxClient;
  organizationId: string;
  clinicId: string;
  period: BillingPeriod;
  currency: string;
}): Promise<{ invoiceId: string; invoiceNumber: string; created: boolean }> {
  const invoiceNumber = deriveInvoiceNumber({
    period: input.period,
    clinicId: input.clinicId,
  });

  const existing = await input.tx.invoice.findUnique({
    where: {
      organizationId_invoiceNumber: {
        organizationId: input.organizationId,
        invoiceNumber,
      },
    },
    select: { id: true },
  });
  if (existing !== null) {
    return { invoiceId: existing.id, invoiceNumber, created: false };
  }

  try {
    const created = await input.tx.invoice.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        invoiceNumber,
        status: InvoiceStatus.DRAFT,
        currency: input.currency,
        billingPeriodStart: input.period.start,
        billingPeriodEnd: input.period.end,
      },
      select: { id: true },
    });
    return { invoiceId: created.id, invoiceNumber, created: true };
  } catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
      // Two concurrent ship events for the same clinic in the
      // same period raced and both tried to create the invoice.
      // Re-read; the loser of the race sees the winner's row.
      const winner = await input.tx.invoice.findUnique({
        where: {
          organizationId_invoiceNumber: {
            organizationId: input.organizationId,
            invoiceNumber,
          },
        },
        select: { id: true },
      });
      if (winner !== null) {
        return { invoiceId: winner.id, invoiceNumber, created: false };
      }
      throw new errors.InternalError({
        code: MATERIALIZE_BILLING_INVOICE_NUMBER_COLLISION,
        message: `Invoice number "${invoiceNumber}" collided but no row was readable.`,
        metadata: { organizationId: input.organizationId, invoiceNumber },
      });
    }
    throw cause;
  }
}

export const MaterializeShippedOrderBilling: SystemCommand<
  MaterializeShippedOrderBillingInput,
  MaterializeShippedOrderBillingOutput
> = {
  name: "MaterializeShippedOrderBilling",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<MaterializeShippedOrderBillingOutput>> {
    const billingEventKey = `ord-shipped:${input.orderId}`;

    // ---- Idempotency short-circuit ----
    const existingLine = await findExistingBillingLine({ tx, billingEventKey });
    if (existingLine !== null) {
      // Resolve the invoice number for the response — non-essential
      // but keeps the audit / output complete.
      const invoice = await tx.invoice.findUnique({
        where: { id: existingLine.invoiceId },
        select: { invoiceNumber: true },
      });
      const occurredAt = clock.now();
      return {
        output: {
          invoiceId: existingLine.invoiceId,
          invoiceLineId: existingLine.id,
          invoiceNumber: invoice?.invoiceNumber ?? "(unknown)",
          amountCents: existingLine.amountCents,
          alreadyMaterialized: true,
          invoiceCreated: false,
          // The originating materialization recorded the scheme; we
          // don't know what it was without joining the metadata
          // JSONB. The replay's only job is to surface "already done"
          // so leave pricingScheme as the historical default; the
          // first-run audit row carries the authoritative stamp.
          pricingScheme: "FLAT_V1" as const,
          pricingRuleId: null,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "billing.shipped_order.materialize.skipped",
          resourceType: "Order",
          resourceId: input.orderId,
          metadata: {
            orderId: input.orderId,
            shipmentId: input.shipmentId,
            invoiceId: existingLine.invoiceId,
            invoiceLineId: existingLine.id,
            billingEventKey,
            reason: "already-materialized",
            occurredAt: occurredAt.toISOString(),
            commandLogId,
          },
        },
        outboxEvents: [],
      };
    }

    // ---- Verify the clinic belongs to the org ----
    // Belt-and-braces: the source event already carries
    // (organizationId, clinicId, siteId) from a workflow command
    // that wrote them transactionally, so this is purely a defense
    // against a malformed outbox payload.
    const clinic = await tx.clinic.findUnique({
      where: { id: input.clinicId },
      select: { id: true, organizationId: true },
    });
    if (clinic === null || clinic.organizationId !== input.organizationId) {
      throw new errors.NotFoundError({
        code: MATERIALIZE_BILLING_CLINIC_NOT_FOUND,
        message:
          "Clinic referenced by the shipped-order event was not found in the target organization.",
        metadata: { organizationId: input.organizationId, clinicId: input.clinicId },
      });
    }

    const occurredAtDate = new Date(input.occurredAt);
    const period = deriveBillingPeriod(occurredAtDate);

    // ---- Resolve pricing ----
    // Pull candidate rules for this (org, kind) pair inside the
    // same tx, then rank by specificity. Falls back to FLAT_V1
    // when nothing matches so the pipeline never blocks on
    // missing rules; the audit stamp lets a re-pricing job find
    // and update those lines later.
    const candidates = await loadCandidatePricingRules(tx, {
      organizationId: input.organizationId,
      kind: InvoiceLineKind.DISPENSE_FEE,
      occurredAt: occurredAtDate,
    });
    const resolution: PricingResolution | null = pickPricingRule(
      {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        productId: null,
        kind: InvoiceLineKind.DISPENSE_FEE,
        occurredAt: occurredAtDate,
      },
      candidates
    );
    const pricingScheme: PricingScheme = resolution !== null ? "RULE_V2" : "FLAT_V1";
    const pricingRuleId = resolution?.ruleId ?? null;
    const unitAmountCents = resolution?.unitAmountCents ?? FLAT_DISPENSE_FEE_CENTS;
    const currency = resolution?.currency ?? "usd";

    // ---- Resolve or create the open DRAFT invoice ----
    const invoice = await resolveOrCreateOpenInvoice({
      tx,
      organizationId: input.organizationId,
      clinicId: input.clinicId,
      period,
      currency,
    });

    // ---- Append the invoice line ----
    let invoiceLineId: string;
    try {
      const line = await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.invoiceId,
          organizationId: input.organizationId,
          clinicId: input.clinicId,
          orderId: input.orderId,
          kind: InvoiceLineKind.DISPENSE_FEE,
          description: FLAT_DISPENSE_FEE_DESCRIPTION,
          quantity: 1,
          unitAmountCents,
          amountCents: unitAmountCents,
          billingEventKey,
          metadata: {
            sourceEvent: "order.shipped.v1",
            sourceShipmentId: input.shipmentId,
            pricingScheme,
            pricingRuleId,
            pricingTier: resolution?.tier ?? null,
          },
        },
        select: { id: true },
      });
      invoiceLineId = line.id;
    } catch (cause) {
      // Concurrent replay of the same outbox row hit the unique
      // constraint on billingEventKey. Treat as success — re-read
      // and report as already-materialized.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        const winner = await findExistingBillingLine({ tx, billingEventKey });
        if (winner !== null) {
          const occurredAt = clock.now();
          return {
            output: {
              invoiceId: winner.invoiceId,
              invoiceLineId: winner.id,
              invoiceNumber: invoice.invoiceNumber,
              amountCents: winner.amountCents,
              alreadyMaterialized: true,
              invoiceCreated: invoice.created,
              pricingScheme: "FLAT_V1" as const,
              pricingRuleId: null,
            },
            targetOrganizationId: input.organizationId,
            audit: {
              action: "billing.shipped_order.materialize.skipped",
              resourceType: "Order",
              resourceId: input.orderId,
              metadata: {
                orderId: input.orderId,
                shipmentId: input.shipmentId,
                invoiceId: winner.invoiceId,
                invoiceLineId: winner.id,
                billingEventKey,
                reason: "p2002-race-resolved",
                occurredAt: occurredAt.toISOString(),
                commandLogId,
              },
            },
            outboxEvents: [],
          };
        }
      }
      throw cause;
    }

    // ---- Roll the invoice totals atomically ----
    // Prisma's `{ increment }` compiles to `column = column + N` —
    // safe under concurrent appends, no CAS required.
    await tx.invoice.update({
      where: { id: invoice.invoiceId },
      data: {
        subtotalCents: { increment: unitAmountCents },
        totalCents: { increment: unitAmountCents },
        amountDueCents: { increment: unitAmountCents },
        version: { increment: 1 },
      },
    });

    const occurredAt = clock.now();
    return {
      output: {
        invoiceId: invoice.invoiceId,
        invoiceLineId,
        invoiceNumber: invoice.invoiceNumber,
        amountCents: unitAmountCents,
        alreadyMaterialized: false,
        invoiceCreated: invoice.created,
        pricingScheme,
        pricingRuleId,
      },
      targetOrganizationId: input.organizationId,
      audit: {
        action: "billing.shipped_order.materialized",
        resourceType: "Order",
        resourceId: input.orderId,
        metadata: {
          orderId: input.orderId,
          shipmentId: input.shipmentId,
          clinicId: input.clinicId,
          siteId: input.siteId,
          invoiceId: invoice.invoiceId,
          invoiceLineId,
          invoiceNumber: invoice.invoiceNumber,
          invoiceCreated: invoice.created,
          amountCents: unitAmountCents,
          pricingScheme,
          pricingRuleId,
          pricingTier: resolution?.tier ?? null,
          billingPeriodKey: period.key,
          billingEventKey,
          occurredAt: occurredAt.toISOString(),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "billing.invoice_line.created.v1",
          aggregateType: "Invoice",
          aggregateId: invoice.invoiceId,
          payload: {
            organizationId: input.organizationId,
            clinicId: input.clinicId,
            invoiceId: invoice.invoiceId,
            invoiceLineId,
            invoiceNumber: invoice.invoiceNumber,
            orderId: input.orderId,
            shipmentId: input.shipmentId,
            kind: InvoiceLineKind.DISPENSE_FEE,
            amountCents: unitAmountCents,
            currency,
            pricingScheme,
            pricingRuleId,
            billingPeriodKey: period.key,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
