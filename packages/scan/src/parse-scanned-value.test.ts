import { describe, expect, it } from "vitest";

import { parseScannedValue } from "./parse-scanned-value.js";

const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";

describe("parseScannedValue", () => {
  it("detects vial label tokens", () => {
    const parsed = parseScannedValue(`PX:${ORDER_LINE_ID}`);
    expect(parsed.kind).toBe("VIAL_LABEL");
    if (parsed.kind === "VIAL_LABEL") {
      expect(parsed.orderLineId).toBe(ORDER_LINE_ID);
    }
  });

  it("detects GS1 payloads", () => {
    const parsed = parseScannedValue("(01)00368140986755(10)LOT-A1");
    expect(parsed.kind).toBe("GS1");
  });

  it("detects plain NDC", () => {
    const parsed = parseScannedValue("12345-6789-01");
    expect(parsed.kind).toBe("NDC");
    if (parsed.kind === "NDC") {
      expect(parsed.ndc11).toBe("12345678901");
    }
  });

  it("detects plain lot numbers", () => {
    const parsed = parseScannedValue("LOT-A1");
    expect(parsed.kind).toBe("LOT");
    if (parsed.kind === "LOT") {
      expect(parsed.lotNumber).toBe("LOT-A1");
    }
  });
});
