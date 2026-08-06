import { describe, expect, it } from "vitest";

import {
  isFinalRejectionReason,
  isPV1RejectionReason,
  FINAL_REJECTION_REASONS,
  PV1_REJECTION_REASONS,
  PV1_REJECTION_REASONS_SET,
} from "./rejection-reasons.js";

// Invariants of the registries themselves. The CROSS-PACKAGE parity
// checks — that `@pharmax/events` payload schemas and the
// `@pharmax/clinical-screening` PV1 hints still name codes that exist
// here — live in `scripts/check-event-reason-mirrors.test.ts`, which
// is where this repo keeps reason-code parity so that a test-only
// import does not add an edge to the package dependency graph.

describe("rejection-reason registries", () => {
  it("expose no duplicate codes", () => {
    expect(new Set(PV1_REJECTION_REASONS).size).toBe(PV1_REJECTION_REASONS.length);
    expect(new Set(FINAL_REJECTION_REASONS).size).toBe(FINAL_REJECTION_REASONS.length);
  });

  it("keep the O(1) lookup set in step with the list it was built from", () => {
    expect(PV1_REJECTION_REASONS_SET.size).toBe(PV1_REJECTION_REASONS.length);
    for (const reason of PV1_REJECTION_REASONS) {
      expect(PV1_REJECTION_REASONS_SET.has(reason)).toBe(true);
    }
  });

  it("keep the two stage vocabularies distinct", () => {
    // PV1 reasons describe typing errors and Final reasons describe
    // fill errors. A code drifting into both would make
    // rejections-by-reason reporting ambiguous about which stage the
    // rejection came from, which is the reason the lists are split.
    expect(isPV1RejectionReason("DRUG_INTERACTION")).toBe(true);
    expect(isPV1RejectionReason("WRONG_DRUG_PULLED")).toBe(false);
    expect(isFinalRejectionReason("WRONG_DRUG_PULLED")).toBe(true);
    expect(isFinalRejectionReason("DRUG_INTERACTION")).toBe(false);
  });

  it("both offer the OTHER escape hatch", () => {
    // Pinned because both reject handlers rely on it existing for the
    // free-text path.
    expect(isPV1RejectionReason("OTHER")).toBe(true);
    expect(isFinalRejectionReason("OTHER")).toBe(true);
  });
});
