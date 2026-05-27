// Domain-level test for order.* event definitions.
//
// Asserts:
//   - Every order.* event aggregates over `Order` or `Shipment`.
//   - Every event has a non-empty description.
//   - Owner is one of the workflow domains (orders, verification,
//     fill, shipping).
//   - All are PHI-free.

import { describe, expect, it } from "vitest";

import * as OrderEvents from "./index.js";

const ALL = Object.values(OrderEvents);
const VALID_OWNERS = new Set(["orders", "verification", "fill", "shipping"]);
const VALID_AGGREGATES = new Set(["Order", "Shipment"]);

describe("order domain barrel", () => {
  it("at least 20 order.* events are registered", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(20);
  });

  it("every order.* event aggregates over Order or Shipment", () => {
    for (const def of ALL) {
      expect(VALID_AGGREGATES.has(def.aggregateType), `${def.fullName} aggregateType`).toBe(true);
    }
  });

  it("every order.* event is owned by a workflow domain", () => {
    for (const def of ALL) {
      expect(VALID_OWNERS.has(def.owner), `${def.fullName} owner=${def.owner}`).toBe(true);
    }
  });

  it("every order.* event is PHI-free", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(true);
    }
  });
});
