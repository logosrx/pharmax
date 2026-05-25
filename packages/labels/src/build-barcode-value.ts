/** PHI-free scan token printed on vial labels and used at final verification. */
export function buildVialBarcodeValue(orderLineId: string): string {
  return `PX:${orderLineId}`;
}
