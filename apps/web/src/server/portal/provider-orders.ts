// Prescriber order visibility (ADR-0033, slice 3).
//
// Lists the orders that contain at least one order line whose
// prescription was written by THIS provider — the treatment
// relationship is the access rule, enforced structurally by the
// query shape (both the order filter and the line projection are
// pinned to (organizationId, providerId) from the RESOLVED SESSION).
//
// PHI posture: the projection is deliberately PHI-FREE. The
// prescriber sees their own rx numbers, drug identity (public NDC
// vocabulary), workflow status, and dates — but NO patient fields.
// The prescriber can correlate an rx number to a patient from their
// own records; we do not decrypt or transmit patient identity here.
// Widening this projection to patient identity would require a
// deliberate ADR-level decision (PHI-capable portal surface).
//
// Runs in system context: portal principals have no tenancy frame,
// so — as everywhere in the portal server layer — the session row is
// the tenancy proof and every query is explicitly org-scoped.

import "server-only";

import { prisma, type OrderStatus, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

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

export async function listProviderOrders(input: {
  readonly organizationId: string;
  readonly providerId: string;
  readonly client?: Pick<PrismaClient, "$transaction">;
}): Promise<PortalOrdersPage> {
  const client = input.client ?? prisma;
  const { organizationId, providerId } = input;

  const orderFilter = {
    organizationId,
    orderLines: {
      some: { organizationId, prescription: { providerId } },
    },
  } as const;

  return withSystemContext(REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);

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
              // Only THIS provider's lines — an order can carry lines
              // from several prescribers; the others are not this
              // prescriber's business.
              where: { prescription: { providerId } },
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
    })
  );
}
