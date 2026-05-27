// billing.pricing_rule.upserted.v1 — a pricing rule was created or rotated.
//
// Producer: `UpsertPricingRule` (`@pharmax/billing`).
// Consumers: pricing-cache invalidation; SOC 2 pricing-change
//   audit feed; future "rules in flight" admin dashboard.
//
// PHI: none. Clinic + product ids + numeric pricing only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const PRICEABLE_LINE_KINDS = ["DISPENSE_FEE", "SHIPPING_FEE", "RUSH_FEE", "PRODUCT"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    ruleId: z.uuid(),
    /**
     * Id of the prior ACTIVE rule that this command superseded.
     * Null when this is the first rule for the
     * (clinic, productId, kind) tuple.
     */
    supersededRuleId: z.uuid().nullable(),
    clinicId: z.uuid(),
    /** Optional product scope; null when the rule is clinic-wide. */
    productId: z.uuid().nullable(),
    kind: z.enum(PRICEABLE_LINE_KINDS),
    /** Integer cents of the unit price under this rule. */
    unitAmountCents: z.number().int(),
    /** ISO 4217 currency code (3 chars). */
    currency: z.string().min(3).max(3),
    effectiveFrom: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const BillingPricingRuleUpsertedV1 = defineEvent({
  name: "billing.pricing_rule.upserted",
  version: 1,
  aggregateType: "PricingRule",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.ruleId,
  owner: "billing",
  retention: "7y",
  phiSafe: true,
  routingKey: "billing.pricing",
  description:
    "Emitted by UpsertPricingRule when a new pricing rule supersedes a prior ACTIVE one. Drives pricing-cache invalidation + the SOC 2 pricing-change audit feed.",
});

export type BillingPricingRuleUpsertedV1Payload = z.infer<typeof payloadSchema>;
