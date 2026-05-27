// Unit tests for pickPricingRule (pure function — no DB required).

import { InvoiceLineKind, PricingRuleStatus } from "@pharmax/database";
import { describe, expect, it } from "vitest";

import {
  pickPricingRule,
  type PricingRuleCandidate,
  type PricingResolutionQuery,
} from "./resolve-pricing.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const CLINIC_A = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const CLINIC_B = "0c0c0c0c-1c0c-4c0c-8c0c-0c0c0c0c0c0c";
const PRODUCT_X = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
const PRODUCT_Y = "0d0d0d0d-1d0d-4d0d-8d0d-0d0d0d0d0d0d";

function rule(over: Partial<PricingRuleCandidate>): PricingRuleCandidate {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    clinicId: over.clinicId ?? null,
    productId: over.productId ?? null,
    kind: over.kind ?? InvoiceLineKind.DISPENSE_FEE,
    unitAmountCents: over.unitAmountCents ?? 5000,
    currency: over.currency ?? "usd",
    effectiveFrom: over.effectiveFrom ?? new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: over.effectiveTo ?? null,
    status: over.status ?? PricingRuleStatus.ACTIVE,
  };
}

const baseQuery = (): PricingResolutionQuery => ({
  organizationId: ORG,
  clinicId: CLINIC_A,
  productId: PRODUCT_X,
  kind: InvoiceLineKind.DISPENSE_FEE,
  occurredAt: new Date("2026-05-25T17:00:00.000Z"),
});

describe("pickPricingRule — specificity ranking", () => {
  it("CLINIC_PRODUCT beats CLINIC + PRODUCT + ORG_DEFAULT", () => {
    const candidates = [
      rule({ id: "org", unitAmountCents: 1000 }),
      rule({ id: "clinic", clinicId: CLINIC_A, unitAmountCents: 2000 }),
      rule({ id: "product", productId: PRODUCT_X, unitAmountCents: 3000 }),
      rule({
        id: "clinic_product",
        clinicId: CLINIC_A,
        productId: PRODUCT_X,
        unitAmountCents: 4000,
      }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("clinic_product");
    expect(result?.tier).toBe("CLINIC_PRODUCT");
    expect(result?.unitAmountCents).toBe(4000);
  });

  it("CLINIC beats PRODUCT + ORG_DEFAULT", () => {
    const candidates = [
      rule({ id: "org", unitAmountCents: 1000 }),
      rule({ id: "product", productId: PRODUCT_X, unitAmountCents: 3000 }),
      rule({ id: "clinic", clinicId: CLINIC_A, unitAmountCents: 2000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("clinic");
    expect(result?.tier).toBe("CLINIC");
  });

  it("PRODUCT beats ORG_DEFAULT", () => {
    const candidates = [
      rule({ id: "org", unitAmountCents: 1000 }),
      rule({ id: "product", productId: PRODUCT_X, unitAmountCents: 3000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("product");
    expect(result?.tier).toBe("PRODUCT");
  });

  it("falls back to ORG_DEFAULT when no narrower rule matches", () => {
    const candidates = [rule({ id: "org", unitAmountCents: 1000 })];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("org");
    expect(result?.tier).toBe("ORG_DEFAULT");
  });

  it("returns null when no rule matches at all", () => {
    expect(pickPricingRule(baseQuery(), [])).toBeNull();
  });
});

describe("pickPricingRule — scope compatibility", () => {
  it("skips rules for a different clinic", () => {
    const candidates = [
      rule({ id: "clinic_b", clinicId: CLINIC_B, unitAmountCents: 9999 }),
      rule({ id: "org", unitAmountCents: 1000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("org");
  });

  it("skips rules for a different product", () => {
    const candidates = [
      rule({ id: "product_y", productId: PRODUCT_Y, unitAmountCents: 9999 }),
      rule({ id: "org", unitAmountCents: 1000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("org");
  });

  it("does not apply a product-specific rule when the query has no productId", () => {
    const query: PricingResolutionQuery = { ...baseQuery(), productId: null };
    const candidates = [
      rule({ id: "product", productId: PRODUCT_X, unitAmountCents: 9999 }),
      rule({ id: "org", unitAmountCents: 1000 }),
    ];
    const result = pickPricingRule(query, candidates);
    expect(result?.ruleId).toBe("org");
  });
});

describe("pickPricingRule — time windows", () => {
  it("ignores rules whose effectiveFrom is in the future", () => {
    const candidates = [
      rule({
        id: "future",
        unitAmountCents: 9999,
        effectiveFrom: new Date("2026-12-01T00:00:00.000Z"),
      }),
      rule({ id: "current", unitAmountCents: 1000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("current");
  });

  it("ignores rules whose effectiveTo has passed", () => {
    const candidates = [
      rule({
        id: "past",
        unitAmountCents: 9999,
        effectiveTo: new Date("2026-04-01T00:00:00.000Z"),
      }),
      rule({ id: "current", unitAmountCents: 1000 }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("current");
  });

  it("within the same tier, picks the rule with the latest effectiveFrom", () => {
    const candidates = [
      rule({
        id: "old",
        clinicId: CLINIC_A,
        unitAmountCents: 1000,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      }),
      rule({
        id: "new",
        clinicId: CLINIC_A,
        unitAmountCents: 2000,
        effectiveFrom: new Date("2026-05-01T00:00:00.000Z"),
      }),
    ];
    const result = pickPricingRule(baseQuery(), candidates);
    expect(result?.ruleId).toBe("new");
  });
});
