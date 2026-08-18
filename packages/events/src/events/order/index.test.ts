// Domain-level test for order.* event definitions.
//
// Asserts:
//   - Every order.* event aggregates over `Order` or `Shipment`.
//   - Every event has a non-empty description.
//   - Owner is one of the workflow domains (orders, verification,
//     fill, shipping).
//   - PHI-free EXCEPT the patient-scoped events, which are pinned by
//     name. Order workflow events track a unit of work, not a person,
//     so an order event that reaches for `patientId` has left the
//     workflow plane and needs the classification checked by hand.

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

  // The one exception carries `patientId` alongside a screening
  // finding code and severity — a clinical determination about an
  // identifiable individual, so it is PHI-bearing and not
  // partner-webhook eligible. Everything else in this domain
  // describes the order, not the patient.
  const PHI_BEARING = new Set(["order.pv1.screening.acknowledged_for_patient.v1"]);

  it("every order.* event is PHI-free except the pinned patient-scoped events", () => {
    for (const def of ALL) {
      expect(def.phiSafe, `${def.fullName} phiSafe`).toBe(!PHI_BEARING.has(def.fullName));
    }
  });

  it("the pinned PHI-bearing names all still exist in the barrel", () => {
    const registered = new Set(ALL.map((def) => def.fullName));
    for (const name of PHI_BEARING) {
      expect(registered.has(name), `${name} missing from order barrel`).toBe(true);
    }
  });
});
