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
});
