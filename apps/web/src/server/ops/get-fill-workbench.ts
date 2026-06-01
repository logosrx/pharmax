// Fill workbench projection — drives `/ops/fill/[orderId]`.
//
// The tech bench is the longest action chain in the workflow:
//   1. Claim (StartFill, already done by the time this projection
//      is rendered for an in-flight order)
//   2. Per-line: assign a lot (lot dropdown filtered to compatible
//      lots — same NDC, same site, ACTIVE, unexpired)
//   3. Per-line: print a vial label (printer dropdown filtered to
//      active printers at the order's site)
//   4. Whole-order: scan each printed vial + lot, dispatch
//      CompleteFill
//
// What this projection returns:
//   - The order header (id, status, version, siteId)
//   - Per-line: rx + drug + qty + current lot assignment + current
//     vial-label print status + the list of CANDIDATE lots the tech
//     can pick from
//   - Order-level: the list of ACTIVE label printers at this site
//   - Order-level: the list of ACTIVE workstations at this site
//     (the tech must pick one for the print form because
//     PrintVialLabel `requiresWorkstation: true`)
//
// PHI is NOT decrypted here — the order-detail page is the PHI
// surface; the workbench is operational chrome. If the tech needs
// to read the sig before scanning, they open the detail page in a
// new tab. (Future enhancement: inline the decrypted sig per line,
// gated by `orders.read`.)
//
// Tenancy: standard organization filter. The Prisma extension is
// the gate; this query passes the explicit `organizationId`
// predicate as defense in depth.

import "server-only";

import {
  readInOrgScope,
  LabelPrinterStatus,
  LotStatus,
  WorkstationStatus,
  type OrderStatus,
  type PrintJobStatus,
} from "@pharmax/database";

export interface FillWorkbenchCandidateLot {
  readonly lotId: string;
  readonly lotNumber: string;
  readonly expirationDate: Date;
}

export interface FillWorkbenchPrinter {
  readonly printerId: string;
  readonly code: string;
  readonly name: string;
  readonly workstationId: string | null;
}

export interface FillWorkbenchWorkstation {
  readonly workstationId: string;
  readonly code: string;
  readonly name: string;
}

export interface FillWorkbenchLine {
  readonly orderLineId: string;
  readonly prescriptionId: string;
  readonly rxNumber: string;
  readonly drugNdc: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly quantityToFill: string;
  readonly assignedLot: {
    readonly lotId: string;
    readonly lotNumber: string;
  } | null;
  readonly vialLabel: {
    readonly vialLabelId: string;
    readonly barcodeValue: string;
    readonly latestPrintJobStatus: PrintJobStatus | null;
  } | null;
  readonly candidateLots: ReadonlyArray<FillWorkbenchCandidateLot>;
}

export interface FillWorkbench {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: OrderStatus;
  readonly version: number;
  readonly currentAssigneeUserId: string | null;
  readonly siteId: string;
  readonly lines: ReadonlyArray<FillWorkbenchLine>;
  readonly availablePrinters: ReadonlyArray<FillWorkbenchPrinter>;
  readonly availableWorkstations: ReadonlyArray<FillWorkbenchWorkstation>;
  /** Convenience: every line has both an assigned lot AND a vial label. */
  readonly readyForCompletionScans: boolean;
}

const CANDIDATE_LOTS_LIMIT = 25;

export async function getFillWorkbench(input: {
  readonly organizationId: string;
  readonly orderId: string;
}): Promise<FillWorkbench | null> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: input.orderId, organizationId: input.organizationId },
      select: {
        id: true,
        externalOrderNumber: true,
        currentStatus: true,
        version: true,
        currentAssigneeUserId: true,
        siteId: true,
        orderLines: {
          select: {
            id: true,
            quantityToFill: true,
            lot: { select: { id: true, lotNumber: true } },
            vialLabel: {
              select: {
                id: true,
                barcodeValue: true,
                activePrintJob: { select: { status: true } },
              },
            },
            prescription: {
              select: {
                id: true,
                rxNumber: true,
                drugNdc: true,
                drugName: true,
                drugStrength: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (order === null) return null;

    const todayUtc = new Date();
    const todayDate = new Date(
      Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate())
    );

    // ---- Fetch candidate lots per distinct NDC in one round trip ----
    const distinctNdcs = Array.from(
      new Set(order.orderLines.map((line) => line.prescription.drugNdc))
    );
    const candidateLotRows =
      distinctNdcs.length === 0
        ? []
        : await tx.lot.findMany({
            where: {
              organizationId: input.organizationId,
              siteId: order.siteId,
              status: LotStatus.ACTIVE,
              expirationDate: { gte: todayDate },
              product: { ndc: { in: distinctNdcs } },
            },
            select: {
              id: true,
              lotNumber: true,
              expirationDate: true,
              product: { select: { ndc: true } },
            },
            // Soonest-to-expire first → encourages FEFO (first-expiring-
            // first-out) without forcing the tech. Cap so a thousand-lot
            // product can't bloat the page.
            orderBy: [{ expirationDate: "asc" }, { lotNumber: "asc" }],
            take: distinctNdcs.length * CANDIDATE_LOTS_LIMIT,
          });

    const lotsByNdc = new Map<string, FillWorkbenchCandidateLot[]>();
    for (const row of candidateLotRows) {
      const bucket = lotsByNdc.get(row.product.ndc) ?? [];
      if (bucket.length < CANDIDATE_LOTS_LIMIT) {
        bucket.push(
          Object.freeze({
            lotId: row.id,
            lotNumber: row.lotNumber,
            expirationDate: row.expirationDate,
          })
        );
      }
      lotsByNdc.set(row.product.ndc, bucket);
    }

    // ---- Fetch site-scoped print infrastructure ----
    // Sequential (not Promise.all): these run inside one interactive
    // transaction on a single connection.
    const printers = await tx.labelPrinter.findMany({
      where: {
        organizationId: input.organizationId,
        siteId: order.siteId,
        status: LabelPrinterStatus.ACTIVE,
      },
      select: { id: true, code: true, name: true, workstationId: true },
      orderBy: [{ code: "asc" }],
    });
    const workstations = await tx.workstation.findMany({
      where: {
        organizationId: input.organizationId,
        siteId: order.siteId,
        status: WorkstationStatus.ACTIVE,
      },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: "asc" }],
    });

    const lines: FillWorkbenchLine[] = order.orderLines.map((line) =>
      Object.freeze({
        orderLineId: line.id,
        prescriptionId: line.prescription.id,
        rxNumber: line.prescription.rxNumber,
        drugNdc: line.prescription.drugNdc,
        drugName: line.prescription.drugName,
        drugStrength: line.prescription.drugStrength,
        quantityToFill: String(line.quantityToFill),
        assignedLot:
          line.lot !== null
            ? Object.freeze({ lotId: line.lot.id, lotNumber: line.lot.lotNumber })
            : null,
        vialLabel:
          line.vialLabel !== null
            ? Object.freeze({
                vialLabelId: line.vialLabel.id,
                barcodeValue: line.vialLabel.barcodeValue,
                latestPrintJobStatus: line.vialLabel.activePrintJob.status,
              })
            : null,
        candidateLots: Object.freeze(lotsByNdc.get(line.prescription.drugNdc) ?? []),
      })
    );

    const readyForCompletionScans =
      lines.length > 0 &&
      lines.every((line) => line.assignedLot !== null && line.vialLabel !== null);

    return Object.freeze({
      orderId: order.id,
      externalOrderNumber: order.externalOrderNumber,
      currentStatus: order.currentStatus,
      version: order.version,
      currentAssigneeUserId: order.currentAssigneeUserId,
      siteId: order.siteId,
      lines,
      availablePrinters: printers.map((p) =>
        Object.freeze({
          printerId: p.id,
          code: p.code,
          name: p.name,
          workstationId: p.workstationId,
        })
      ),
      availableWorkstations: workstations.map((w) =>
        Object.freeze({ workstationId: w.id, code: w.code, name: w.name })
      ),
      readyForCompletionScans,
    });
  });
}

/**
 * Authorization helper for the print route. Verifies that the
 * workstation id submitted by the operator (a) belongs to the
 * operator's organization, (b) is at the given site, and (c) is
 * ACTIVE. Returns the workstation id on success or `null` on any
 * failure (caller surfaces a flash error).
 */
export async function assertWorkstationBelongsToSite(input: {
  readonly organizationId: string;
  readonly siteId: string;
  readonly workstationId: string;
}): Promise<boolean> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const ws = await tx.workstation.findFirst({
      where: {
        id: input.workstationId,
        organizationId: input.organizationId,
        siteId: input.siteId,
        status: WorkstationStatus.ACTIVE,
      },
      select: { id: true },
    });
    return ws !== null;
  });
}
