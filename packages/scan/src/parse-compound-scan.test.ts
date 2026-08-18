// Parser tests for compound stock label shapes.
//
// The regression these exist for: the `LOT` fallback accepts any
// dash-and-alphanumeric token, so before compound shapes were
// recognized a unit serial parsed as a lot number. That failed closed
// at fill, but told the operator "lot mismatch" for a scan that was
// never a lot and misrouted a scan-to-open. Precedence is therefore
// part of the contract, not an implementation detail.

import { describe, expect, it } from "vitest";

import { parseScannedValue } from "./parse-scanned-value.js";

describe("parseScannedValue — compound batch barcodes", () => {
  it("recognizes a batch barcode and splits out both identifiers", () => {
    const parsed = parseScannedValue("PXB:PXP-000042:PHX-T30-1-040327");
    expect(parsed.kind).toBe("COMPOUND_BATCH");
    if (parsed.kind !== "COMPOUND_BATCH") throw new Error("narrowing");
    expect(parsed.pharmaxProductId).toBe("PXP-000042");
    expect(parsed.batchNumber).toBe("PHX-T30-1-040327");
  });

  it("normalizes case so a lowercase-configured scanner still resolves", () => {
    const parsed = parseScannedValue("pxb:pxp-000042:phx-t30-1-040327");
    expect(parsed.kind).toBe("COMPOUND_BATCH");
    if (parsed.kind !== "COMPOUND_BATCH") throw new Error("narrowing");
    expect(parsed.pharmaxProductId).toBe("PXP-000042");
    expect(parsed.batchNumber).toBe("PHX-T30-1-040327");
  });

  it("tolerates surrounding whitespace from a scanner wedge", () => {
    expect(parseScannedValue("  PXB:PXP-000042:PHX-T30-1-040327\n").kind).toBe("COMPOUND_BATCH");
  });

  it("does not accept a PXB token whose batch number is malformed", () => {
    // Missing the day-sequence segment.
    expect(parseScannedValue("PXB:PXP-000042:PHX-T30-040327").kind).not.toBe("COMPOUND_BATCH");
  });
});

describe("parseScannedValue — compound unit serials", () => {
  it("recognizes a bare unit serial rather than treating it as a lot", () => {
    const parsed = parseScannedValue("PHX-T30-1-040327-11");
    // The regression guard: this token matches the LOT fallback
    // pattern, so kind order is what keeps it out of the lot path.
    expect(parsed.kind).toBe("COMPOUND_UNIT");
    if (parsed.kind !== "COMPOUND_UNIT") throw new Error("narrowing");
    expect(parsed.serialNumber).toBe("PHX-T30-1-040327-11");
    expect(parsed.batchNumber).toBe("PHX-T30-1-040327");
    expect(parsed.unitNumber).toBe(11);
  });

  it("handles unit number 1 and large unit numbers", () => {
    const first = parseScannedValue("PHX-T30-1-040327-1");
    expect(first.kind).toBe("COMPOUND_UNIT");
    if (first.kind !== "COMPOUND_UNIT") throw new Error("narrowing");
    expect(first.unitNumber).toBe(1);

    const last = parseScannedValue("PHX-T30-1-040327-4000");
    if (last.kind !== "COMPOUND_UNIT") throw new Error("narrowing");
    expect(last.unitNumber).toBe(4000);
  });

  it("handles a site code containing digits and a multi-digit day sequence", () => {
    const parsed = parseScannedValue("PHX2-T30-12-040327-7");
    expect(parsed.kind).toBe("COMPOUND_UNIT");
    if (parsed.kind !== "COMPOUND_UNIT") throw new Error("narrowing");
    expect(parsed.batchNumber).toBe("PHX2-T30-12-040327");
    expect(parsed.unitNumber).toBe(7);
  });

  it("normalizes serial case so the stored uppercase row still matches", () => {
    const parsed = parseScannedValue("phx-t30-1-040327-11");
    if (parsed.kind !== "COMPOUND_UNIT") throw new Error("narrowing");
    expect(parsed.serialNumber).toBe("PHX-T30-1-040327-11");
  });

  it("treats a batch number with no unit suffix as NOT a unit", () => {
    // A bare batch number is not a scannable artifact on its own — the
    // batch label encodes the PXB token — so it should not silently
    // resolve as a unit.
    expect(parseScannedValue("PHX-T30-1-040327").kind).not.toBe("COMPOUND_UNIT");
  });
});

describe("parseScannedValue — precedence is preserved for existing kinds", () => {
  it("still recognizes a vial label ahead of everything else", () => {
    const parsed = parseScannedValue("PX:0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(parsed.kind).toBe("VIAL_LABEL");
  });

  it("still treats an ordinary manufacturer lot token as a lot", () => {
    const parsed = parseScannedValue("ABC123XY");
    expect(parsed.kind).toBe("LOT");
  });

  it("still treats a lot token containing dashes as a lot when it is not a serial shape", () => {
    const parsed = parseScannedValue("LOT-2027-A");
    expect(parsed.kind).toBe("LOT");
  });

  it("still returns UNKNOWN for an empty scan", () => {
    expect(parseScannedValue("   ").kind).toBe("UNKNOWN");
  });
});
