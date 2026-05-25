export interface VialLabelRenderInput {
  readonly patientDisplayName: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugNdc: string;
  readonly rxNumber: string;
  readonly quantity: string;
  readonly daysSupply: number;
  readonly sigText: string;
  readonly lotNumber: string;
  readonly lotExpiration: string;
  readonly barcodeValue: string;
}
