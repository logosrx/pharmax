// Printers and workstations available for compound stock labels at one
// site — drives the print controls on the batch detail page.
//
// Scoped to the BATCH's site, not the operator's: labels for stock
// compounded at one site must not print at another site's bench. The
// route re-validates the submitted workstation server-side, so this
// read is a convenience for the form, never the authorization.
//
// Printers are grouped by label stock because the two compound label
// kinds land on different media: the batch record label on BATCH_2X1,
// the per-unit vial labels on VIAL.
//
// PHI: none. Tenancy: explicit organizationId predicate on top of RLS.

import "server-only";

import { LabelPrinterStatus, LabelStockKind, readInOrgScope } from "@pharmax/database";

export interface LabelPrinterOption {
  readonly printerId: string;
  readonly code: string;
  readonly name: string;
}

export interface WorkstationOption {
  readonly workstationId: string;
  readonly code: string;
  readonly name: string;
}

export interface CompoundLabelPrintOptions {
  readonly batchPrinters: ReadonlyArray<LabelPrinterOption>;
  readonly unitPrinters: ReadonlyArray<LabelPrinterOption>;
  readonly workstations: ReadonlyArray<WorkstationOption>;
}

export async function getCompoundLabelPrintOptions(options: {
  readonly organizationId: string;
  readonly siteId: string;
}): Promise<CompoundLabelPrintOptions> {
  return readInOrgScope(options.organizationId, async (tx) => {
    const [printers, workstations] = await Promise.all([
      tx.labelPrinter.findMany({
        where: {
          organizationId: options.organizationId,
          siteId: options.siteId,
          status: LabelPrinterStatus.ACTIVE,
          labelStock: { in: [LabelStockKind.BATCH_2X1, LabelStockKind.VIAL] },
        },
        orderBy: [{ code: "asc" }],
        select: { id: true, code: true, name: true, labelStock: true },
      }),
      tx.workstation.findMany({
        where: { organizationId: options.organizationId, siteId: options.siteId },
        orderBy: [{ code: "asc" }],
        select: { id: true, code: true, name: true, status: true },
      }),
    ]);

    const toOption = (p: { id: string; code: string; name: string }): LabelPrinterOption =>
      Object.freeze({ printerId: p.id, code: p.code, name: p.name });

    return Object.freeze({
      batchPrinters: printers
        .filter((p) => p.labelStock === LabelStockKind.BATCH_2X1)
        .map(toOption),
      unitPrinters: printers.filter((p) => p.labelStock === LabelStockKind.VIAL).map(toOption),
      workstations: workstations
        .filter((w) => w.status === "ACTIVE")
        .map((w) => Object.freeze({ workstationId: w.id, code: w.code, name: w.name })),
    });
  });
}
