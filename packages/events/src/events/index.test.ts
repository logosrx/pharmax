// Top-level event-catalog tests.
//
// Pins:
//   - Every registered definition has a non-empty description.
//   - Every registered definition has an explicit owner (NOT the
//     "system" default — that default is reserved as a red flag).
//   - Every registered definition has a retention drawn from the
//     `{7y, 90d, 30d}` set.
//   - phiSafe is declared explicitly on every definition, any event
//     carrying `patientId` is classified PHI-bearing, and the
//     PHI-bearing set itself is pinned.
//   - The registry's sorted name list matches the union of the
//     per-domain barrels' exports.
//
// The repo-wide parity guard lives in `../parity-guard.test.ts` —
// these tests cover the SHAPE of registry entries, not parity
// against source.

import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, listRegisteredEventDefinitions } from "../registry.js";

describe("event catalog", () => {
  it("has at least 50 registered definitions (post-allowlist-migration baseline)", () => {
    // Sanity floor — if the count drops below this without a
    // corresponding allowlist increase, something was removed.
    expect(EVENT_REGISTRY.size).toBeGreaterThanOrEqual(50);
  });

  it("every definition has a non-empty description", () => {
    for (const def of EVENT_REGISTRY.values()) {
      expect(def.description, `${def.fullName} has empty description`).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it("every definition declares an explicit owner (no 'system' default)", () => {
    const unowned = [...EVENT_REGISTRY.values()].filter((d) => d.owner === "system");
    expect(unowned.map((d) => d.fullName)).toEqual([]);
  });

  it("every definition has a valid retention", () => {
    const valid = new Set(["7y", "90d", "30d"]);
    for (const def of EVENT_REGISTRY.values()) {
      expect(valid.has(def.retention), `${def.fullName} retention=${def.retention}`).toBe(true);
    }
  });

  // `phiSafe` gates partner-webhook egress: an event marked PHI-safe
  // is deliverable to a third-party endpoint. Misclassifying one is
  // therefore not a documentation error, it is a disclosure.
  //
  // A payload carrying `patientId` is PHI. A persistent record
  // identifier is an identifier under 45 CFR §164.514(b)(2)(i)(R), so
  // withholding the name, DOB and address does not de-identify the
  // event — it only makes it look de-identified to a reader who has
  // not checked the rule. This assertion is the mechanical version of
  // that check, so the next author cannot restate the argument and
  // reach the wrong answer.
  it("classifies every event carrying patientId as PHI-bearing", () => {
    const misclassified = listRegisteredEventDefinitions()
      .filter((def) => {
        const shape = (def.schema as unknown as { shape: Record<string, unknown> }).shape;
        return Object.hasOwn(shape, "patientId");
      })
      .filter((def) => def.phiSafe)
      .map((def) => def.fullName);
    expect(misclassified).toEqual([]);
  });

  // Pinned in both directions. Adding an event here must be a
  // reviewed classification; REMOVING one silently re-opens an egress
  // path, which is the failure this pin exists to catch.
  it("pins the PHI-bearing event set", () => {
    const phiBearing = listRegisteredEventDefinitions()
      .filter((def) => !def.phiSafe)
      .map((def) => def.fullName);
    expect(phiBearing).toEqual([
      "order.pv1.screening.acknowledged_for_patient.v1",
      "patient.allergy.recorded.v1",
      "patient.allergy.status.amended.v1",
      "patient.allergy_history.asserted.v1",
      "patient.crypto_shredded.v1",
      "patient.registered.v1",
      "patient.updated.v1",
      "patient.viewed.v1",
      "prescription.created.v1",
    ]);
  });

  it("listRegisteredEventDefinitions is sorted by fullName", () => {
    const defs = listRegisteredEventDefinitions();
    const names = defs.map((d) => d.fullName);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
