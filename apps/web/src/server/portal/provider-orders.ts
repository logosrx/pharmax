// Prescriber order visibility (ADR-0033, slice 3).
//
// Lists the orders that contain at least one order line whose
// prescription was written by THIS provider FOR THE CLIENT PRACTICE THE
// SESSION IS ACTING FOR. Both halves of that come from the resolved
// session, never from a request.
//
// Why the client half was added. Before multi-client affiliations, a
// prescriber had one implicit client and filtering by provider alone
// was sufficient. Now Dr. Chen may write for two practices, and a
// provider-only filter would show her Coastal Med orders while she is
// working as Valley Wellness.
//
// Being precise about what that is and is not: it is NOT a PHI
// disclosure, because both prescriptions are her own and this
// projection carries no patient fields. It is a correctness and
// confidentiality boundary — a practice reasonably expects its order
// book not to appear inside another practice's view, and the moment
// this projection gains a patient field, or a clinic-administrator
// persona who is not the prescriber, the same filter becomes the thing
// preventing a real disclosure. Cheaper to get right now than to
// retrofit under that pressure.
//
// PHI posture unchanged: the projection is deliberately PHI-FREE. The
// prescriber sees their own rx numbers, drug identity (public NDC
// vocabulary), workflow status and dates — but NO patient fields.
// Widening it would require a deliberate ADR-level decision.

import "server-only";

import type { OrderStatus } from "@pharmax/database";

import type { PortalIdentityScoped } from "./current-session";
import { readInClientScope } from "./read-in-client-scope";

const REASON = "portal:list-provider-orders";

/** Server-side page size — bounded by construction, no client input. */
const PAGE_SIZE = 50;

export interface PortalOrderLine {
  readonly rxNumber: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly quantityToFill: string;
}

export interface PortalOrder {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly status: OrderStatus;
  readonly receivedAt: Date;
  readonly shippedAt: Date | null;
  /** Only the lines whose prescription belongs to this provider. */
  readonly lines: ReadonlyArray<PortalOrderLine>;
}

export interface PortalOrdersPage {
  readonly orders: ReadonlyArray<PortalOrder>;
  readonly totalCount: number;
  readonly pageSize: number;
}

export async function listProviderOrders(
  identity: PortalIdentityScoped
): Promise<PortalOrdersPage> {
  const providerId = identity.provider.id;

  return readInClientScope(identity, REASON, async (tx, filter) => {
    // `filter` carries organizationId AND clinicId from the session.
    // The order must belong to this client and carry a line prescribed
    // by this provider; the line projection repeats the provider
    // predicate so an order shared with another prescriber does not
    // leak their lines.
    const orderFilter = {
      ...filter,
      orderLines: {
        some: { ...filter, prescription: { providerId } },
      },
    } as const;

    const [totalCount, rows] = await Promise.all([
      tx.order.count({ where: orderFilter }),
      tx.order.findMany({
        where: orderFilter,
        orderBy: { receivedAt: "desc" },
        take: PAGE_SIZE,
        select: {
          id: true,
          externalOrderNumber: true,
          currentStatus: true,
          receivedAt: true,
          shippedAt: true,
          orderLines: {
            // Only THIS provider's lines for THIS client — an order can
            // carry lines from several prescribers; the others are not
            // this prescriber's business.
            where: { ...filter, prescription: { providerId } },
            select: {
              quantityToFill: true,
              prescription: {
                select: { rxNumber: true, drugName: true, drugStrength: true },
              },
            },
          },
        },
      }),
    ]);

    const orders: PortalOrder[] = rows.map((row) => ({
      orderId: row.id,
      externalOrderNumber: row.externalOrderNumber,
      status: row.currentStatus,
      receivedAt: row.receivedAt,
      shippedAt: row.shippedAt,
      lines: row.orderLines.map((line) => ({
        rxNumber: line.prescription.rxNumber,
        drugName: line.prescription.drugName,
        drugStrength: line.prescription.drugStrength,
        quantityToFill: line.quantityToFill.toString(),
      })),
    }));

    return { orders, totalCount, pageSize: PAGE_SIZE };
  });
}
