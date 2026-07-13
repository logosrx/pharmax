// Resolve the token an operator typed or scanned into the topbar
// order search into an internal order id.
//
// The search bar advertises "Search or scan an order…" and routes
// whatever it gets to `/ops/orders/{token}`. Three token shapes are
// legitimate:
//
//   1. Internal order UUID           → use as-is.
//   2. Vial-label scan `PX:<uuid>`   → the uuid is the ORDER LINE id
//      (see @pharmax/labels buildVialBarcodeValue); resolve the
//      line's order.
//   3. External order number         → resolve via the
//      (organizationId, externalOrderNumber) index. Not unique by
//      schema; ties resolve to the most recently received order
//      (the one an operator scanning a fresh label wants).
//
// Before this resolver existed, only shape 1 worked — scanning or
// typing an external order number (the advertised fast path) landed
// on "Order not found".
//
// Tenancy: every lookup carries the explicit organizationId
// predicate on top of the RLS scope.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIAL_BARCODE_RE = /^PX:([0-9a-f-]{36})$/i;

export type ResolvedOrderSearchToken =
  | { readonly kind: "order-id"; readonly orderId: string }
  | { readonly kind: "not-found" };

export async function resolveOrderSearchToken(input: {
  readonly organizationId: string;
  readonly token: string;
}): Promise<ResolvedOrderSearchToken> {
  const token = input.token.trim();

  // Shape 1 — internal order UUID. No lookup; the detail page's
  // own org-scoped query is the existence check.
  if (UUID_RE.test(token)) {
    return { kind: "order-id", orderId: token.toLowerCase() };
  }

  // Shape 2 — vial-label barcode (PX:<orderLineId>).
  const barcodeMatch = VIAL_BARCODE_RE.exec(token);
  if (barcodeMatch !== null) {
    const orderLineId = barcodeMatch[1]!.toLowerCase();
    if (!UUID_RE.test(orderLineId)) {
      return { kind: "not-found" };
    }
    const line = await readInOrgScope(input.organizationId, (tx) =>
      tx.orderLine.findFirst({
        where: { id: orderLineId, organizationId: input.organizationId },
        select: { orderId: true },
      })
    );
    return line === null ? { kind: "not-found" } : { kind: "order-id", orderId: line.orderId };
  }

  // Shape 3 — external order number.
  const order = await readInOrgScope(input.organizationId, (tx) =>
    tx.order.findFirst({
      where: { organizationId: input.organizationId, externalOrderNumber: token },
      select: { id: true },
      orderBy: { receivedAt: "desc" },
    })
  );
  return order === null ? { kind: "not-found" } : { kind: "order-id", orderId: order.id };
}
