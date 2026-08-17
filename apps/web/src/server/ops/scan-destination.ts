// Where a token from the topbar scan bar belongs, and which grant
// gates it once it gets there.
//
// The scan bar routes every scan and every typed query to
// `/ops/orders/{token}`, which makes the order-detail page the
// console's scan dispatcher. Two destinations are reachable from it
// and they are NOT gated alike:
//
//   order detail            orders.read + patients.read   decrypts PHI
//   compound batch detail   inventory.read                no PHI
//
// So the gate has to be chosen by DESTINATION, not by the route the
// token arrived on. Checking the order grants first refuses a compound
// stock label — which identifies a production run, has no patient, and
// resolves to an inventory page — at a PHI gate it has no reason to
// pass. A compounding or QA operator holding `inventory.read` and the
// batch-lifecycle grants but no order/PHI grants is exactly the
// least-privilege role the batch RBAC split invites, and for them the
// scan the topbar advertises never reaches its page.
//
// Deciding this in a pure function is deliberate: the defect above was
// an ORDERING mistake in a server component, invisible to every unit
// test in the tree because a page's guard sequence is not reachable
// without a request. Here it is one call with an asserted answer.
//
// PHI: none. Classification is regex work on a scanned string, and the
// permission set holds grant codes.

import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";
import { parseScannedValue } from "@pharmax/scan";

/** Which surface a dispatched token is asking for. */
export type ScanSurface = "order" | "compound-stock";

export type ScanDestination =
  /** Resolve as an order: internal id, external number, or vial label. */
  | { readonly kind: "order" }
  /**
   * Compound stock — a batch barcode (`PXB:<productId>:<batchNumber>`)
   * or a bare unit serial (`PHX-T30-1-040327-11`). Stock that has never
   * been dispensed has no order to find.
   */
  | { readonly kind: "compound-stock"; readonly batchNumber: string }
  /** The operator may not read the surface this token resolves to. */
  | {
      readonly kind: "denied";
      readonly surface: ScanSurface;
      /** The FIRST missing grant, so the guard can name one thing to ask for. */
      readonly grant: PermissionCode;
    };

/**
 * Classify a dispatched token and apply the destination's own gate.
 *
 * Pure — no I/O, no lookup. A `compound-stock` or `order` result says
 * the operator may proceed to that surface, not that the token
 * resolves to a row there; the caller still has to look it up.
 */
export function scanDestination(input: {
  readonly token: string;
  readonly permissions: ReadonlySet<PermissionCode>;
}): ScanDestination {
  const parsed = parseScannedValue(input.token);

  if (parsed.kind === "COMPOUND_BATCH" || parsed.kind === "COMPOUND_UNIT") {
    // Catalog/inventory data only. `inventory.read` is what the batch
    // page itself checks, and it is the whole gate here — asking a
    // compound label for order or patient grants would deny the page
    // to operators the page admits.
    return input.permissions.has(PERMISSIONS.INVENTORY_READ)
      ? { kind: "compound-stock", batchNumber: parsed.batchNumber }
      : { kind: "denied", surface: "compound-stock", grant: PERMISSIONS.INVENTORY_READ };
  }

  if (!input.permissions.has(PERMISSIONS.ORDERS_READ)) {
    return { kind: "denied", surface: "order", grant: PERMISSIONS.ORDERS_READ };
  }
  // Order detail decrypts patient identity, contact, and sig; without
  // `patients.read` the page refuses outright rather than rendering a
  // half-populated view.
  if (!input.permissions.has(PERMISSIONS.PATIENTS_READ)) {
    return { kind: "denied", surface: "order", grant: PERMISSIONS.PATIENTS_READ };
  }
  return { kind: "order" };
}
