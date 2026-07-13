import { describe, expect, it } from "vitest";

import { renderVialLabelZpl } from "./render-vial-label-zpl.js";
import { DEFAULT_VIAL_ZPL_TEMPLATE } from "./default-vial-template.js";
import type { VialLabelRenderInput } from "./types.js";

const sampleInput: VialLabelRenderInput = {
  patientDisplayName: "Alex Sample",
  drugName: "Testosterone Cypionate",
  drugStrength: "200mg/mL",
  drugNdc: "12345678901",
  rxNumber: "RX-1001",
  quantity: "10",
  daysSupply: 30,
  sigText: "Inject 0.5mL weekly",
  lotNumber: "LOT-A1",
  lotExpiration: "2026-12-31",
  barcodeValue: "PX:00000000-0000-4000-8000-0000000000aa",
};

describe("renderVialLabelZpl", () => {
  it("replaces all placeholders in the default template", () => {
    const zpl = renderVialLabelZpl(DEFAULT_VIAL_ZPL_TEMPLATE, sampleInput);
    expect(zpl).toContain("^XA");
    expect(zpl).toContain("Alex Sample");
    expect(zpl).toContain("Testosterone Cypionate 200mg/mL");
    expect(zpl).toContain("12345678901");
    expect(zpl).toContain("Inject 0.5mL weekly");
    expect(zpl).toContain("LOT-A1");
    expect(zpl).toContain(sampleInput.barcodeValue);
    expect(zpl).not.toContain("{{");
  });

  it("neutralizes ZPL control characters in field data (^ and ~ cannot inject commands)", () => {
    // Regression: a SIG containing a literal "^FS" terminated the
    // field early and the remaining text executed as ZPL commands.
    const zpl = renderVialLabelZpl(DEFAULT_VIAL_ZPL_TEMPLATE, {
      ...sampleInput,
      sigText: "Take 1 daily ^FS^XZ evil",
      drugName: "Weird~Drug^Name",
    });
    // The injected sequence must not survive as ZPL-active bytes...
    expect(zpl).not.toContain("^FS^XZ evil");
    expect(zpl).not.toContain("Weird~Drug^Name");
    // ...but the template's own structure is intact.
    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.endsWith("^XZ")).toBe(true);
  });

  it("collapses newlines in field data", () => {
    const zpl = renderVialLabelZpl(DEFAULT_VIAL_ZPL_TEMPLATE, {
      ...sampleInput,
      sigText: "Line one\nLine two\r\nLine three",
    });
    expect(zpl).toContain("Line one Line two Line three");
  });

  it("truncates over-length fields so they cannot overflow into the barcode area", () => {
    const longSig = "Inject one full syringe subcutaneously into the ".repeat(5);
    const zpl = renderVialLabelZpl(DEFAULT_VIAL_ZPL_TEMPLATE, {
      ...sampleInput,
      sigText: longSig,
    });
    expect(zpl).not.toContain(longSig);
    expect(zpl).toContain("…");
  });

  it("rejects barcode values carrying ZPL-active characters instead of altering them", () => {
    expect(() =>
      renderVialLabelZpl(DEFAULT_VIAL_ZPL_TEMPLATE, {
        ...sampleInput,
        barcodeValue: "PX:^XZ-corrupted",
      })
    ).toThrowError(/ZPL control characters/);
  });
});
