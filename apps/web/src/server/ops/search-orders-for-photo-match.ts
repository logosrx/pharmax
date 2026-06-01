// Order candidate search for the unmatched-bucket triage picker.
//
// Given the clerk's query term — typically the corrected external
// order number read off the physical pick-ticket, or a barcode
// scan of it — find candidate `Order` rows the clerk can match an
// unmatched package photo to. The match itself is dispatched
// through `ResolvePackagePhotoMatch` (which takes the chosen
// `targetOrderId`); this helper only populates the picker.
//
// Search dimension:
//
//   - `externalOrderNumber` (case-insensitive substring). This is
//     the dominant triage path: the photo failed to auto-match
//     because the rep typo'd the order number, so the corrected
//     number is usually a near-miss of the captured one. A scan of
//     the pick-ticket barcode lands in the same input.
//
//   - Patient-name search is deliberately NOT in this helper. That
//     path needs the PHI blind-index + per-result view-audit
//     machinery (`searchPatientsForAdmin` + `auditPatientViewsBatch`)
//     and is tracked as a follow-up. Reps reconciling a typo work
//     from the printed order number, which this covers.
//
// Bounded by construction:
//
//   - Requires a query term of at least MIN_QUERY_LEN characters —
//     we never dispense an unbounded order scan from the triage
//     surface (same rule the patient search enforces).
//   - Hard result cap (MAX_RESULTS); the page nudges the clerk to
//     refine when the cap is hit.
//
// PHI rule:
//
//   - Returns non-PHI order context only (external number, status,
//     priority, clinic/site ids, received timestamp, whether a
//     shipment already exists). NO patient identity. The clerk
//     reconciles against the order number printed on the package;
//     patient name is not required for the typo-correction flow and
//     would drag in the PHI-audit obligation.

import "server-only";

import { type OrderPriority, type OrderStatus, readInOrgScope } from "@pharmax/database";

export interface OrderMatchCandidate {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly currentStatus: OrderStatus;
  readonly priority: OrderPriority;
  readonly clinicId: string;
  readonly siteId: string;
  readonly receivedAt: Date;
  /** True when the order already has at least one shipment row. */
  readonly hasShipment: boolean;
}

export interface SearchOrdersForPhotoMatchResult {
  readonly rows: ReadonlyArray<OrderMatchCandidate>;
  /** True when MAX_RESULTS was hit — the picker shows a "refine" hint. */
  readonly truncated: boolean;
  /** Echoed back so the page can decide whether a search actually ran. */
  readonly tooShort: boolean;
}

const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 25;

export async function searchOrdersForPhotoMatch(input: {
  readonly organizationId: string;
  readonly query: string;
}): Promise<SearchOrdersForPhotoMatchResult> {
  const q = input.query.trim();
  if (q.length < MIN_QUERY_LEN) {
    return Object.freeze({ rows: [], truncated: false, tooShort: true });
  }

  return readInOrgScope(input.organizationId, async (tx) => {
    const orders = await tx.order.findMany({
      where: {
        organizationId: input.organizationId,
        externalOrderNumber: { contains: q, mode: "insensitive" },
      },
      select: {
        id: true,
        externalOrderNumber: true,
        currentStatus: true,
        priority: true,
        clinicId: true,
        siteId: true,
        receivedAt: true,
        _count: { select: { shipments: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: MAX_RESULTS + 1,
    });

    const truncated = orders.length > MAX_RESULTS;
    const visible = truncated ? orders.slice(0, MAX_RESULTS) : orders;

    return Object.freeze({
      truncated,
      tooShort: false,
      rows: visible.map((o) =>
        Object.freeze({
          orderId: o.id,
          externalOrderNumber: o.externalOrderNumber,
          currentStatus: o.currentStatus,
          priority: o.priority,
          clinicId: o.clinicId,
          siteId: o.siteId,
          receivedAt: o.receivedAt,
          hasShipment: o._count.shipments > 0,
        })
      ),
    });
  });
}
