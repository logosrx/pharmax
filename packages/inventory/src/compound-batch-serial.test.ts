// Unit tests for the compound batch serial formatters.
//
// These strings print on physical labels and are parsed back by
// scanners, so the shape is a contract: site code, drug initial + mg,
// batch-of-the-day, MMDDYY, unit number — dash-delimited, nothing
// else.

import { describe, expect, it } from "vitest";

import {
  buildBatchBarcodeValue,
  buildBatchNumber,
  buildUnitSerial,
  formatCompoundedOnCode,
  normalizeSiteSerialCode,
} from "./compound-batch-serial.js";

describe("normalizeSiteSerialCode", () => {
  it("uppercases and strips everything outside A–Z / 0–9", () => {
    expect(normalizeSiteSerialCode("phx")).toBe("PHX");
    expect(normalizeSiteSerialCode("Main")).toBe("MAIN");
    // A dash inside the site code would corrupt every downstream
    // parse of the dash-delimited serial.
    expect(normalizeSiteSerialCode("ph-x 2")).toBe("PHX2");
  });

  it("returns null when nothing survives normalization", () => {
    expect(normalizeSiteSerialCode("--- ")).toBeNull();
    expect(normalizeSiteSerialCode("")).toBeNull();
  });
});

describe("formatCompoundedOnCode", () => {
  it("rearranges an ISO date into MMDDYY", () => {
    expect(formatCompoundedOnCode("2027-04-03")).toBe("040327");
    expect(formatCompoundedOnCode("2026-08-16")).toBe("081626");
  });

  it("keeps leading zeros (pure string rearrangement, no Date math)", () => {
    expect(formatCompoundedOnCode("2030-01-05")).toBe("010530");
  });
});

describe("buildBatchNumber / buildUnitSerial / buildBatchBarcodeValue", () => {
  const batchNumber = buildBatchNumber({
    siteCode: "PHX",
    serialDrugInitial: "T",
    serialDrugMg: 30,
    daySequence: 1,
    compoundedOn: "2027-04-03",
  });

  it("assembles the documented batch number shape", () => {
    expect(batchNumber).toBe("PHX-T30-1-040327");
  });

  it("appends the unit number for the full serial", () => {
    expect(buildUnitSerial(batchNumber, 11)).toBe("PHX-T30-1-040327-11");
    expect(buildUnitSerial(batchNumber, 1)).toBe("PHX-T30-1-040327-1");
  });

  it("carries product id + batch number in the barcode payload", () => {
    expect(buildBatchBarcodeValue("PXP-000042", batchNumber)).toBe(
      "PXB:PXP-000042:PHX-T30-1-040327"
    );
  });

  it("increments the day sequence for a same-day second batch", () => {
    const second = buildBatchNumber({
      siteCode: "PHX",
      serialDrugInitial: "T",
      serialDrugMg: 30,
      daySequence: 2,
      compoundedOn: "2027-04-03",
    });
    expect(second).toBe("PHX-T30-2-040327");
  });
});
