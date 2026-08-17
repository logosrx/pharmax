// Default ZPL templates for in-house compounded stock labels.
//
// Two artifacts, two physical stocks:
//
//   Batch label (BATCH_2X1) — goes on the batch tote / batch record.
//     Carries the batch barcode with the Pharmax Product ID and batch
//     number printed beneath it as real text fields rather than as the
//     barcode's interpretation line, so both remain legible if the
//     barcode smudges and a human can read what a scanner would.
//
//   Unit label (VIAL) — goes on each individual vial. Its barcode
//     payload is the unit serial itself, so what a scanner reads is
//     exactly what a technician can read aloud off the label. That
//     equality is the point: a mismatch between printed and encoded
//     identity is the failure mode traceability cannot tolerate.
//
// Both use `^BC` (Code 128) matching the existing vial label, with the
// interpretation line off (`N`) since the human-readable value is
// placed explicitly.

export const DEFAULT_COMPOUND_BATCH_TEMPLATE_CODE = "compound.batch.standard";
export const DEFAULT_COMPOUND_BATCH_TEMPLATE_VERSION = 1;

export const DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE = `^XA
^FO20,20^A0N,28,28^FD{{productName}}^FS
^FO20,58^A0N,24,24^FD{{productStrength}}^FS
^FO20,96^A0N,20,20^FDCompounded: {{compoundedOn}}  Units: {{unitCount}}^FS
^FO20,128^A0N,24,24^FDBUD: {{beyondUseDate}}^FS
^FO20,170^BY2^BCN,70,N,N,N^FD{{batchBarcodeValue}}^FS
^FO20,250^A0N,20,20^FD{{pharmaxProductId}}^FS
^FO20,280^A0N,26,26^FD{{batchNumber}}^FS
^XZ`;

export const DEFAULT_COMPOUND_UNIT_TEMPLATE_CODE = "compound.unit.standard";
export const DEFAULT_COMPOUND_UNIT_TEMPLATE_VERSION = 1;

export const DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE = `^XA
^FO20,20^A0N,26,26^FD{{productName}}^FS
^FO20,54^A0N,22,22^FD{{productStrength}}^FS
^FO20,88^A0N,20,20^FDBUD: {{beyondUseDate}}^FS
^FO20,118^A0N,20,20^FDUnit {{unitNumber}} of {{unitCount}}^FS
^FO20,152^BY2^BCN,70,N,N,N^FD{{serialBarcodeValue}}^FS
^FO20,232^A0N,24,24^FD{{serialNumber}}^FS
^XZ`;
