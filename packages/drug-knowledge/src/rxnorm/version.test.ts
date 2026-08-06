import { describe, expect, it } from "vitest";

import { parseRxnormVersion, rxnormVersionFromArchiveName } from "./version.js";

describe("parseRxnormVersion", () => {
  it("parses an MMDDYYYY token into a UTC date", () => {
    const parsed = parseRxnormVersion("07072026");
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe("07072026");
    expect(parsed?.releasedOn.toISOString()).toBe("2026-07-07T00:00:00.000Z");
  });

  it("rejects tokens that are not eight digits", () => {
    expect(parseRxnormVersion("2026-07-07")).toBeNull();
    expect(parseRxnormVersion("772026")).toBeNull();
    expect(parseRxnormVersion("")).toBeNull();
    expect(parseRxnormVersion("garbage")).toBeNull();
  });

  it("rejects impossible calendar dates instead of letting Date roll them over", () => {
    // Date.UTC would silently turn Feb 30 into Mar 2 — a garbage
    // version must fail the ingestion, not load under a wrong date.
    expect(parseRxnormVersion("02302026")).toBeNull();
    expect(parseRxnormVersion("13012026")).toBeNull();
    expect(parseRxnormVersion("00152026")).toBeNull();
  });
});

describe("rxnormVersionFromArchiveName", () => {
  it("extracts the version from the NLM archive naming convention", () => {
    expect(rxnormVersionFromArchiveName("RxNorm_full_prescribe_07072026.zip")?.version).toBe(
      "07072026"
    );
    expect(rxnormVersionFromArchiveName("RxNorm_full_prescribe_07072026")?.version).toBe(
      "07072026"
    );
  });

  it("returns null for names carrying no version token", () => {
    expect(rxnormVersionFromArchiveName("extracted-release")).toBeNull();
    expect(rxnormVersionFromArchiveName("RxNorm_full_prescribe_0707.zip")).toBeNull();
  });
});
