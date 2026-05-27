// UpsertPricingRule — operator-driven pricing-rule lifecycle.
//
// Semantics:
//
//   Each (organization, clinicId?, productId?, kind) scope holds AT
//   MOST ONE ACTIVE rule at any time. Calling UpsertPricingRule for
//   a scope:
//
//     1. Looks up the prior ACTIVE rule for the same scope.
//     2. If found, transactionally sets its `status = SUPERSEDED`
//        and `effectiveTo = new rule's effectiveFrom`.
//     3. Inserts the new ACTIVE rule.
//
//   The partial-unique index `(org, clinic, product, kind) WHERE
//   status = 'ACTIVE'` is the structural guarantee: a P2002 here
//   means a concurrent operator beat us to the swap and we surface
//   it as a typed conflict so the UI can refresh.
//
// Why supersedure (vs. UPDATE-in-place):
//
//   Audit history. The SUPERSEDED row stays for historical pricing
//   queries (e.g. "what was the dispense fee for clinic X on
//   2026-03-15?"); replaying the materialization chain at any
//   point in the past resolves to the rule that was ACTIVE at
//   that timestamp. Mutating in place destroys that.
//
// Operator UX:
//
//   - `effectiveFrom` defaults to "now"; future-dated rules are
//     possible by passing an explicit timestamp.
//   - `notes` is an optional free-text reason (NOT PHI) — surfaces
//     on the rule list view so the next operator understands the
//     context.

import type { Command, HandlerResult, PrismaTxClient } from "@pharmax/command-bus";
import { InvoiceLineKind, Prisma, PricingRuleStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const UPSERT_PRICING_RULE_AMOUNT_INVALID = "UPSERT_PRICING_RULE_AMOUNT_INVALID";
export const UPSERT_PRICING_RULE_ACTIVE_RACE = "UPSERT_PRICING_RULE_ACTIVE_RACE";
export const UPSERT_PRICING_RULE_CLINIC_NOT_FOUND = "UPSERT_PRICING_RULE_CLINIC_NOT_FOUND";
export const UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND = "UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND";

const SUPPORTED_KINDS = [
  InvoiceLineKind.DISPENSE_FEE,
  InvoiceLineKind.SHIPPING_FEE,
  InvoiceLineKind.RUSH_FEE,
] as const;

const inputSchema = z
  .object({
    /** null ⇒ rule applies to every clinic in the org. */
    clinicId: z.uuid().nullable().default(null),
    /** null ⇒ rule applies to every product. */
    productId: z.uuid().nullable().default(null),
    kind: z.enum(SUPPORTED_KINDS),
    unitAmountCents: z.number().int().min(0).max(10_000_00),
    currency: z.string().length(3).default("usd"),
    /**
     * ISO timestamp marking the rule's start. Defaults to "now" at
     * command time. Future-dated rules are allowed (the resolver
     * skips them until their effectiveFrom is reached).
     */
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type UpsertPricingRuleInput = z.infer<typeof inputSchema>;

export interface UpsertPricingRuleOutput {
  readonly ruleId: string;
  readonly supersededRuleId: string | null;
  readonly clinicId: string | null;
  readonly productId: string | null;
  readonly kind: InvoiceLineKind;
  readonly unitAmountCents: number;
  readonly currency: string;
  readonly effectiveFrom: string;
}

async function validateScope(
  tx: PrismaTxClient,
  input: { organizationId: string; clinicId: string | null; productId: string | null }
): Promise<void> {
  if (input.clinicId !== null) {
    const clinic = await tx.clinic.findUnique({
      where: { id: input.clinicId },
      select: { id: true, organizationId: true },
    });
    if (clinic === null || clinic.organizationId !== input.organizationId) {
      throw new errors.NotFoundError({
        code: UPSERT_PRICING_RULE_CLINIC_NOT_FOUND,
        message: "Clinic not found in this organization.",
        metadata: { clinicId: input.clinicId },
      });
    }
  }
  if (input.productId !== null) {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, organizationId: true },
    });
    if (product === null || product.organizationId !== input.organizationId) {
      throw new errors.NotFoundError({
        code: UPSERT_PRICING_RULE_PRODUCT_NOT_FOUND,
        message: "Product not found in this organization.",
        metadata: { productId: input.productId },
      });
    }
  }
}

export const UpsertPricingRule: Command<UpsertPricingRuleInput, UpsertPricingRuleOutput> = {
  name: "UpsertPricingRule",
  inputSchema,
  permission: PERMISSIONS.BILLING_MANAGE_PRICING,

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<UpsertPricingRuleOutput>> {
    if (input.unitAmountCents < 0) {
      throw new errors.ValidationError({
        code: UPSERT_PRICING_RULE_AMOUNT_INVALID,
        message: "unitAmountCents must be non-negative.",
        metadata: { unitAmountCents: input.unitAmountCents },
      });
    }

    await validateScope(tx, {
      organizationId: ctx.organizationId,
      clinicId: input.clinicId,
      productId: input.productId,
    });

    const effectiveFrom =
      input.effectiveFrom !== undefined ? new Date(input.effectiveFrom) : clock.now();

    // ---- Supersede the prior ACTIVE rule (same scope) ----
    const prior = await tx.pricingRule.findFirst({
      where: {
        organizationId: ctx.organizationId,
        clinicId: input.clinicId,
        productId: input.productId,
        kind: input.kind,
        status: PricingRuleStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (prior !== null) {
      await tx.pricingRule.update({
        where: { id: prior.id },
        data: {
          status: PricingRuleStatus.SUPERSEDED,
          effectiveTo: effectiveFrom,
        },
      });
    }

    // ---- Insert the new rule ----
    const ruleId = randomUUID();
    try {
      await tx.pricingRule.create({
        data: {
          id: ruleId,
          organizationId: ctx.organizationId,
          clinicId: input.clinicId,
          productId: input.productId,
          kind: input.kind,
          unitAmountCents: input.unitAmountCents,
          currency: input.currency,
          effectiveFrom,
          status: PricingRuleStatus.ACTIVE,
          notes: input.notes ?? null,
          createdByUserId: ctx.actor.userId,
          createCommandLogId: commandLogId,
        },
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        // A concurrent UpsertPricingRule for the same scope won
        // the race to flip the prior to SUPERSEDED + create the
        // new ACTIVE row. The partial-unique stopped us.
        throw new errors.ConflictError({
          code: UPSERT_PRICING_RULE_ACTIVE_RACE,
          message:
            "A concurrent UpsertPricingRule already created an ACTIVE rule for this scope. Refresh and retry.",
          metadata: {
            organizationId: ctx.organizationId,
            clinicId: input.clinicId,
            productId: input.productId,
            kind: input.kind,
          },
        });
      }
      throw cause;
    }

    const now = clock.now();
    return {
      output: {
        ruleId,
        supersededRuleId: prior?.id ?? null,
        clinicId: input.clinicId,
        productId: input.productId,
        kind: input.kind,
        unitAmountCents: input.unitAmountCents,
        currency: input.currency,
        effectiveFrom: effectiveFrom.toISOString(),
      },
      audit: {
        action: "billing.pricing_rule.upserted",
        resourceType: "PricingRule",
        resourceId: ruleId,
        metadata: {
          organizationId: ctx.organizationId,
          ruleId,
          supersededRuleId: prior?.id ?? null,
          clinicId: input.clinicId,
          productId: input.productId,
          kind: input.kind,
          unitAmountCents: input.unitAmountCents,
          currency: input.currency,
          effectiveFrom: effectiveFrom.toISOString(),
          hasNotes: input.notes !== undefined && input.notes.length > 0,
          commandLogId,
          occurredAt: now.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "billing.pricing_rule.upserted.v1",
          aggregateType: "PricingRule",
          aggregateId: ruleId,
          payload: {
            organizationId: ctx.organizationId,
            ruleId,
            supersededRuleId: prior?.id ?? null,
            clinicId: input.clinicId,
            productId: input.productId,
            kind: input.kind,
            unitAmountCents: input.unitAmountCents,
            currency: input.currency,
            effectiveFrom: effectiveFrom.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
