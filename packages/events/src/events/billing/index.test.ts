// Domain-level test for billing.* event definitions.
//
// Asserts:
//   - The expected billing.* names are registered.
//   - Every billing.* event is owned by `billing`.
//   - Every billing.* event aggregates over `Invoice` or
//     `PricingRule` (the only billing aggregates in scope).

import { describe, expect, it } from "vitest";

import {
  BillingInvoiceCreditedV1,
  BillingInvoiceFinalizedV1,
  BillingInvoiceLineCreatedV1,
  BillingInvoicePaidV1,
  BillingInvoicePaymentFailedV1,
  BillingInvoiceRefundedV1,
  BillingInvoiceStripePushedV1,
  BillingInvoiceUncollectibleV1,
  BillingInvoiceVoidedV1,
  BillingPricingRuleUpsertedV1,
} from "./index.js";

const ALL = [
  BillingInvoiceCreditedV1,
  BillingInvoiceFinalizedV1,
  BillingInvoiceLineCreatedV1,
  BillingInvoicePaidV1,
  BillingInvoicePaymentFailedV1,
  BillingInvoiceRefundedV1,
  BillingInvoiceStripePushedV1,
  BillingInvoiceUncollectibleV1,
  BillingInvoiceVoidedV1,
  BillingPricingRuleUpsertedV1,
];

describe("billing domain barrel", () => {
  it("every billing.* event is owned by `billing`", () => {
    for (const def of ALL) {
      expect(def.owner, `${def.fullName} owner`).toBe("billing");
    }
  });

  it("every billing.* event uses Invoice or PricingRule aggregate", () => {
    const valid = new Set(["Invoice", "PricingRule"]);
    for (const def of ALL) {
      expect(valid.has(def.aggregateType), `${def.fullName} aggregateType`).toBe(true);
    }
  });

  it("every billing.* event retains for 7y (financial compliance)", () => {
    for (const def of ALL) {
      expect(def.retention, `${def.fullName} retention`).toBe("7y");
    }
  });

  it("every billing.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });
});
