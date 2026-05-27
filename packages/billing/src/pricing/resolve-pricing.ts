// resolvePricing — pick the most-specific active pricing rule for a
// `(org, clinic, product?, kind, occurredAt)` query.
//
// Specificity ranking (highest first):
//
//   1. (clinicId set + productId set)
//   2. (clinicId set + no product)
//   3. (no clinic + productId set)
//   4. (no clinic + no product)  — org-wide default
//
// Within the same specificity tier, the rule with the latest
// `effectiveFrom` that still covers `occurredAt` wins. (The
// `UpsertPricingRule` command enforces at-most-one-ACTIVE per
// scope, so ties are rare — but the deterministic tiebreaker
// matters for historical lookups that might span superseded rules
// when `status = 'SUPERSEDED'` is included in the candidate set.)
//
// Implementation split:
//
//   - `loadCandidatePricingRules` runs the SQL that pulls matching
//     rules within a tx. Kept narrow so callers reuse the same
//     `tx` they're already in for atomicity.
//
//   - `pickPricingRule` is a pure ranking function over a candidate
//     list. Unit-tested without a database.
//
// PHI: pricing rules carry no PHI by design.

import type { PrismaTxClient } from "@pharmax/command-bus";
import { PricingRuleStatus, type InvoiceLineKind, type Prisma } from "@pharmax/database";

export interface PricingRuleCandidate {
  readonly id: string;
  readonly clinicId: string | null;
  readonly productId: string | null;
  readonly kind: InvoiceLineKind;
  readonly unitAmountCents: number;
  readonly currency: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly status: PricingRuleStatus;
}

export interface PricingResolutionQuery {
  readonly organizationId: string;
  readonly clinicId: string;
  readonly productId?: string | null;
  readonly kind: InvoiceLineKind;
  /** When the billable event happened (used for time-window matching). */
  readonly occurredAt: Date;
}

export interface PricingResolution {
  readonly ruleId: string;
  readonly unitAmountCents: number;
  readonly currency: string;
  /** Which specificity tier the winner came from. */
  readonly tier: "CLINIC_PRODUCT" | "CLINIC" | "PRODUCT" | "ORG_DEFAULT";
}

/**
 * Tier weight — higher is more specific.
 */
function tierOf(rule: PricingRuleCandidate): PricingResolution["tier"] {
  if (rule.clinicId !== null && rule.productId !== null) return "CLINIC_PRODUCT";
  if (rule.clinicId !== null) return "CLINIC";
  if (rule.productId !== null) return "PRODUCT";
  return "ORG_DEFAULT";
}

const TIER_WEIGHT: Record<PricingResolution["tier"], number> = Object.freeze({
  CLINIC_PRODUCT: 4,
  CLINIC: 3,
  PRODUCT: 2,
  ORG_DEFAULT: 1,
});

/**
 * Pure ranking: pick the most-specific rule whose time window
 * covers `occurredAt` AND whose (clinicId, productId) scope is
 * compatible with the query.
 *
 * "Compatible" means:
 *   - rule.clinicId is null OR equals query.clinicId
 *   - rule.productId is null OR equals query.productId
 *   - query.productId is null only matches rules with rule.productId = null
 *     (we don't apply a product-specific rule to an unknown product)
 */
export function pickPricingRule(
  query: PricingResolutionQuery,
  candidates: ReadonlyArray<PricingRuleCandidate>
): PricingResolution | null {
  const occurredAtMs = query.occurredAt.getTime();
  const productId = query.productId ?? null;

  let best: PricingRuleCandidate | null = null;
  let bestTier = 0;
  let bestEffectiveFromMs = -Infinity;

  for (const rule of candidates) {
    if (rule.kind !== query.kind) continue;
    if (rule.effectiveFrom.getTime() > occurredAtMs) continue;
    if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= occurredAtMs) continue;

    if (rule.clinicId !== null && rule.clinicId !== query.clinicId) continue;
    if (rule.productId !== null && rule.productId !== productId) continue;

    const tier = tierOf(rule);
    const tierWeight = TIER_WEIGHT[tier];

    if (tierWeight > bestTier) {
      best = rule;
      bestTier = tierWeight;
      bestEffectiveFromMs = rule.effectiveFrom.getTime();
      continue;
    }
    if (tierWeight === bestTier && rule.effectiveFrom.getTime() > bestEffectiveFromMs) {
      best = rule;
      bestEffectiveFromMs = rule.effectiveFrom.getTime();
    }
  }

  if (best === null) return null;
  return Object.freeze({
    ruleId: best.id,
    unitAmountCents: best.unitAmountCents,
    currency: best.currency,
    tier: tierOf(best),
  });
}

/**
 * Load the candidate ACTIVE rules for a `(org, kind)` pair. Returns
 * a narrow projection — `pickPricingRule` handles the rest.
 *
 * We DO NOT pre-filter on clinicId / productId at the SQL layer
 * because the ranking depends on org-default and product-only rules
 * being in the candidate set. The cost is small (an org typically
 * has a handful of pricing rules per kind).
 */
export async function loadCandidatePricingRules(
  tx: PrismaTxClient,
  query: { organizationId: string; kind: InvoiceLineKind; occurredAt: Date }
): Promise<PricingRuleCandidate[]> {
  const rows = await tx.pricingRule.findMany({
    where: {
      organizationId: query.organizationId,
      kind: query.kind,
      status: PricingRuleStatus.ACTIVE,
      effectiveFrom: { lte: query.occurredAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.occurredAt } }],
    },
    select: {
      id: true,
      clinicId: true,
      productId: true,
      kind: true,
      unitAmountCents: true,
      currency: true,
      effectiveFrom: true,
      effectiveTo: true,
      status: true,
    },
  });
  // Prisma's runtime types match our narrowed shape; assert through
  // ReadonlyArray for the public type contract.
  return rows.map(
    (r): PricingRuleCandidate => ({
      id: r.id,
      clinicId: r.clinicId,
      productId: r.productId,
      kind: r.kind,
      unitAmountCents: r.unitAmountCents,
      currency: r.currency,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      status: r.status,
    })
  );
}

// Re-export Prisma's narrow type so callers can build raw queries
// without importing @pharmax/database directly when they only need
// the JsonValue shape.
export type { Prisma };
