export const DEFAULT_VIAL_TEMPLATE_CODE = "vial.standard";
export const DEFAULT_VIAL_TEMPLATE_VERSION = 1;

/** Zebra ZPL vial label template (2x1-ish). Placeholders are replaced server-side. */
export const DEFAULT_VIAL_ZPL_TEMPLATE = `^XA
^FO20,20^A0N,28,28^FD{{patientDisplayName}}^FS
^FO20,60^A0N,24,24^FD{{drugName}} {{drugStrength}}^FS
^FO20,100^A0N,20,20^FDNDC: {{drugNdc}} Rx: {{rxNumber}}^FS
^FO20,140^A0N,20,20^FDQty: {{quantity}} DS: {{daysSupply}}^FS
^FO20,180^A0N,18,18^FD{{sigText}}^FS
^FO20,230^A0N,18,18^FDLot: {{lotNumber}} Exp: {{lotExpiration}}^FS
^FO20,290^BY2^BCN,80,Y,N,N^FD{{barcodeValue}}^FS
^XZ`;
