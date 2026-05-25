import { describe, expect, it } from "vitest";

import { parseGs1 } from "./parse-gs1.js";

describe("parseGs1", () => {
  it("parses parenthesized GS1 with GTIN, expiry, and lot", () => {
    const parsed = parseGs1("(01)00368140986755(17)251231(10)LOT-A1");
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.gtin14).toBe("00368140986755");
    expect(parsed!.fields.lotNumber).toBe("LOT-A1");
    expect(parsed!.fields.expirationDate).toBe("2025-12-31");
    expect(parsed!.fields.ndc11).toBe("03681409867");
  });

  it("parses element-string GS1 with FNC1 separators", () => {
    const parsed = parseGs1("0100368140986755\u001d17251231\u001d10LOT-A1");
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.gtin14).toBe("00368140986755");
    expect(parsed!.fields.lotNumber).toBe("LOT-A1");
    expect(parsed!.fields.expirationDate).toBe("2025-12-31");
  });

  it("returns null for invalid payloads", () => {
    expect(parseGs1("not-a-barcode")).toBeNull();
    expect(parseGs1("")).toBeNull();
  });
});
