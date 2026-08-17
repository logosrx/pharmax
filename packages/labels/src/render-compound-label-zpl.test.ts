// Rendering tests for compound stock labels.
//
// The invariants that matter operationally:
//   - every placeholder is substituted (a blank drug name or serial on
//     a printed label is worse than a failed print);
//   - the batch label prints the Pharmax Product ID and batch number
//     as text, not only inside the barcode, so a smudged barcode still
//     leaves a human-readable identity;
//   - the unit label's printed serial and its barcode payload are the
//     SAME string — a disagreement there is the one failure
//     traceability cannot absorb;
//   - the batch label carries that same equality for its batch number,
//     which the batch barcode embeds verbatim: an identifier that does
//     not fit its printed field fails the render rather than printing
//     an abbreviated identity next to the full encoded one;
//   - ZPL-active characters in field data are neutralized, and in a
//     barcode payload are a hard error.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
  DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
} from "./compound-label-templates.js";
import {
  COMPOUND_BATCH_NUMBER_PRINT_MAX,
  COMPOUND_LABEL_IDENTITY_TOO_LONG,
  renderCompoundBatchLabelZpl,
  renderCompoundUnitLabelZpl,
} from "./render-compound-label-zpl.js";
import type { CompoundBatchLabelRenderInput, CompoundUnitLabelRenderInput } from "./types.js";

function batchInput(
  overrides: Partial<CompoundBatchLabelRenderInput> = {}
): CompoundBatchLabelRenderInput {
  return {
    productName: "Tirzepatide/Glycine",
    productStrength: "10mg/20mg/3mL",
    pharmaxProductId: "PXP-000042",
    batchNumber: "PHX-T30-1-040327",
    compoundedOn: "2027-04-03",
    beyondUseDate: "2027-07-02",
    unitCount: 40,
    batchBarcodeValue: "PXB:PXP-000042:PHX-T30-1-040327",
    ...overrides,
  };
}

function unitInput(
  overrides: Partial<CompoundUnitLabelRenderInput> = {}
): CompoundUnitLabelRenderInput {
  return {
    productName: "Tirzepatide/Glycine",
    productStrength: "10mg/20mg/3mL",
    beyondUseDate: "2027-07-02",
    unitNumber: 11,
    unitCount: 40,
    serialNumber: "PHX-T30-1-040327-11",
    ...overrides,
  };
}

describe("renderCompoundBatchLabelZpl", () => {
  it("substitutes every placeholder and emits a complete label", () => {
    const zpl = renderCompoundBatchLabelZpl(DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE, batchInput());

    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.trimEnd().endsWith("^XZ")).toBe(true);
    expect(zpl).not.toContain("{{");
  });

  it("prints the Pharmax Product ID and batch number as text, not only in the barcode", () => {
    const zpl = renderCompoundBatchLabelZpl(DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE, batchInput());

    // Barcode payload present once, as its own field.
    expect(zpl).toContain("^FDPXB:PXP-000042:PHX-T30-1-040327^FS");
    // And both identifiers legible on their own lines.
    expect(zpl).toContain("^FDPXP-000042^FS");
    expect(zpl).toContain("^FDPHX-T30-1-040327^FS");
  });

  it("carries the operational facts a compounder needs", () => {
    const zpl = renderCompoundBatchLabelZpl(DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE, batchInput());

    expect(zpl).toContain("Tirzepatide/Glycine");
    expect(zpl).toContain("10mg/20mg/3mL");
    expect(zpl).toContain("BUD: 2027-07-02");
    expect(zpl).toContain("Compounded: 2027-04-03");
    expect(zpl).toContain("Units: 40");
  });

  it("renders a null strength as empty rather than the string 'null'", () => {
    const zpl = renderCompoundBatchLabelZpl(
      DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
      batchInput({ productStrength: null })
    );
    expect(zpl).not.toContain("null");
  });

  it("neutralizes ZPL-active characters in a product name", () => {
    const zpl = renderCompoundBatchLabelZpl(
      DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
      batchInput({ productName: "Tirz^FS~bad" })
    );
    // The raw caret/tilde must not survive to command the printer.
    expect(zpl).not.toContain("Tirz^FS");
    expect(zpl).toContain("Tirzˆ");
  });

  it("refuses a barcode payload carrying ZPL control characters", () => {
    expect(() =>
      renderCompoundBatchLabelZpl(
        DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
        batchInput({ batchBarcodeValue: "PXB:^XA" })
      )
    ).toThrowError(/ZPL control characters/);
  });

  it("throws when the template references an unknown placeholder", () => {
    expect(() =>
      renderCompoundBatchLabelZpl("^XA^FD{{notAField}}^FS^XZ", batchInput())
    ).toThrowError(/compound batch label template placeholder: notAField/);
  });

  it("prints a batch number at the length limit in full, matching its barcode", () => {
    const batchNumber = "PHARMACYNORTHXX-T30-1-040327";
    expect(batchNumber).toHaveLength(COMPOUND_BATCH_NUMBER_PRINT_MAX);

    const zpl = renderCompoundBatchLabelZpl(
      DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
      batchInput({ batchNumber, batchBarcodeValue: `PXB:PXP-000042:${batchNumber}` })
    );

    // Twice: once inside the barcode payload, once as printed text.
    expect(zpl.split(batchNumber)).toHaveLength(3);
    expect(zpl).not.toContain("…");
  });

  it("refuses an over-long batch number rather than printing an abbreviated identity", () => {
    // A long site code produces this. Truncating the printed copy
    // would leave the label reading PHARMACYCOMPOUNDINGNORTH-T30-1-04…
    // beside a barcode encoding the whole thing — a human and a
    // scanner disagreeing about which batch is in the tote.
    const batchNumber = "PHARMACYCOMPOUNDINGNORTH-T30-1-040327";

    expect(() =>
      renderCompoundBatchLabelZpl(
        DEFAULT_COMPOUND_BATCH_ZPL_TEMPLATE,
        batchInput({ batchNumber, batchBarcodeValue: `PXB:PXP-000042:${batchNumber}` })
      )
    ).toThrowError(expect.objectContaining({ code: COMPOUND_LABEL_IDENTITY_TOO_LONG }));
  });
});

describe("renderCompoundUnitLabelZpl", () => {
  it("substitutes every placeholder and emits a complete label", () => {
    const zpl = renderCompoundUnitLabelZpl(DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE, unitInput());

    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.trimEnd().endsWith("^XZ")).toBe(true);
    expect(zpl).not.toContain("{{");
  });

  it("prints the serial and encodes the identical string in the barcode", () => {
    const serial = "PHX-T30-1-040327-11";
    const zpl = renderCompoundUnitLabelZpl(
      DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
      unitInput({ serialNumber: serial })
    );

    // Twice: once as the barcode payload, once as printed text. What
    // the scanner reads and what the technician reads must match.
    const occurrences = zpl.split(serial).length - 1;
    expect(occurrences).toBe(2);
  });

  it("shows the unit's position within its batch", () => {
    const zpl = renderCompoundUnitLabelZpl(DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE, unitInput());
    expect(zpl).toContain("Unit 11 of 40");
    expect(zpl).toContain("BUD: 2027-07-02");
  });

  it("does not truncate a long serial into disagreeing with its barcode", () => {
    // A pathologically long site code still yields one printed serial
    // identical to the encoded one.
    const serial = `${"SITECODE".repeat(2)}-T30-12-040327-4000`;
    const zpl = renderCompoundUnitLabelZpl(
      DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
      unitInput({ serialNumber: serial })
    );
    expect(zpl.split(serial).length - 1).toBe(2);
    expect(zpl).not.toContain("…");
  });

  it("prints the widest serial a printable batch number can produce", () => {
    // Worst case reachable through CreateCompoundBatch: a batch number
    // at its own limit, on the last unit of the largest allowed batch.
    // The unit label has to carry that without truncating.
    const batchNumber = "PHARMACYNORTHXX-T30-1-040327";
    expect(batchNumber).toHaveLength(COMPOUND_BATCH_NUMBER_PRINT_MAX);
    const serial = `${batchNumber}-5000`;

    const zpl = renderCompoundUnitLabelZpl(
      DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
      unitInput({ serialNumber: serial, unitNumber: 5000, unitCount: 5000 })
    );

    expect(zpl.split(serial)).toHaveLength(3);
    expect(zpl).not.toContain("…");
  });

  it("refuses a serial too long for its printed field rather than abbreviating it", () => {
    expect(() =>
      renderCompoundUnitLabelZpl(
        DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
        unitInput({ serialNumber: `${"SITECODE".repeat(6)}-T30-12-040327-4000` })
      )
    ).toThrowError(expect.objectContaining({ code: COMPOUND_LABEL_IDENTITY_TOO_LONG }));
  });

  it("refuses a serial carrying ZPL control characters", () => {
    expect(() =>
      renderCompoundUnitLabelZpl(
        DEFAULT_COMPOUND_UNIT_ZPL_TEMPLATE,
        unitInput({ serialNumber: "PHX~1" })
      )
    ).toThrowError(/ZPL control characters/);
  });
});
