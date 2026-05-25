import type { VialLabelRenderInput } from "./types.js";

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function normalizeStrength(strength: string | null): string {
  return strength?.trim() ?? "";
}

export function renderVialLabelZpl(templateBody: string, input: VialLabelRenderInput): string {
  const values: Record<string, string> = {
    patientDisplayName: input.patientDisplayName,
    drugName: input.drugName,
    drugStrength: normalizeStrength(input.drugStrength),
    drugNdc: input.drugNdc,
    rxNumber: input.rxNumber,
    quantity: input.quantity,
    daysSupply: String(input.daysSupply),
    sigText: input.sigText,
    lotNumber: input.lotNumber,
    lotExpiration: input.lotExpiration,
    barcodeValue: input.barcodeValue,
  };

  return templateBody.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing vial label template placeholder: ${key}`);
    }
    return value;
  });
}
