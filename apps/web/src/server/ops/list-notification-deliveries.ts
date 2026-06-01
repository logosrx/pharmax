// Read helpers for the `notification_delivery` projection.
//
// Powers the notifications health view (`/ops/admin/notifications`)
// and the per-schedule run-history delivery rollup. All reads are
// tenant-scoped via `withTenancyContext`.
//
// PHI: `notification_delivery` holds operator/admin email metadata
// only (recipient address, template, status). No patient data.

import "server-only";

import { readInTenantContext } from "@pharmax/database";
import type { NotificationDeliveryStatus } from "@pharmax/database";
import { type TenancyContext } from "@pharmax/tenancy";

export interface NotificationDeliveryListRow {
  readonly id: string;
  readonly template: string;
  readonly channelName: string;
  readonly recipientAddress: string;
  readonly status: NotificationDeliveryStatus;
  readonly lastEventType: string | null;
  readonly lastEventAt: Date | null;
  readonly failureReason: string | null;
  readonly correlationId: string | null;
  readonly createdAt: Date;
}

/** Statuses that indicate something an operator should look at. */
export const PROBLEM_DELIVERY_STATUSES: ReadonlyArray<NotificationDeliveryStatus> = Object.freeze([
  "BOUNCED",
  "COMPLAINED",
  "DELIVERY_DELAYED",
  "FAILED",
]);

const LIST_SELECT = {
  id: true,
  template: true,
  channelName: true,
  recipientAddress: true,
  status: true,
  lastEventType: true,
  lastEventAt: true,
  failureReason: true,
  correlationId: true,
  createdAt: true,
} as const;

export async function listNotificationDeliveries(input: {
  readonly tenancy: TenancyContext;
  readonly limit?: number;
  readonly problemsOnly?: boolean;
}): Promise<ReadonlyArray<NotificationDeliveryListRow>> {
  const limit = input.limit ?? 100;
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.notificationDelivery.findMany({
      ...(input.problemsOnly === true
        ? { where: { status: { in: [...PROBLEM_DELIVERY_STATUSES] } } }
        : {}),
      orderBy: { createdAt: "desc" },
      take: limit,
      select: LIST_SELECT,
    });
    return rows.map((row) =>
      Object.freeze({
        id: row.id,
        template: row.template,
        channelName: row.channelName,
        recipientAddress: row.recipientAddress,
        status: row.status,
        lastEventType: row.lastEventType,
        lastEventAt: row.lastEventAt,
        failureReason: row.failureReason,
        correlationId: row.correlationId,
        createdAt: row.createdAt,
      })
    );
  });
}

// ---------------------------------------------------------------------------
// Per-correlation rollup (used by the schedule run-history page to
// show "delivered/bounced per run").
// ---------------------------------------------------------------------------

export interface DeliveryRollup {
  readonly total: number;
  readonly delivered: number;
  readonly bounced: number;
  readonly complained: number;
  readonly delayed: number;
  readonly failed: number;
  readonly inFlight: number; // QUEUED + SENT (not yet a terminal webhook signal)
}

/** A minimal row shape the pure rollup operates on. */
export interface DeliveryStatusRow {
  readonly correlationId: string | null;
  readonly status: NotificationDeliveryStatus;
}

/**
 * Pure: group delivery rows by `correlationId` into per-key
 * rollups. Rows with a null correlationId are ignored (they
 * aren't tied to a report run). Exported for unit testing the
 * aggregation independent of Prisma.
 */
export function rollupByCorrelation(
  rows: ReadonlyArray<DeliveryStatusRow>
): ReadonlyMap<string, DeliveryRollup> {
  const acc = new Map<
    string,
    {
      total: number;
      delivered: number;
      bounced: number;
      complained: number;
      delayed: number;
      failed: number;
      inFlight: number;
    }
  >();

  for (const row of rows) {
    if (row.correlationId === null) continue;
    const current = acc.get(row.correlationId) ?? {
      total: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      delayed: 0,
      failed: 0,
      inFlight: 0,
    };
    current.total += 1;
    switch (row.status) {
      case "DELIVERED":
        current.delivered += 1;
        break;
      case "BOUNCED":
        current.bounced += 1;
        break;
      case "COMPLAINED":
        current.complained += 1;
        break;
      case "DELIVERY_DELAYED":
        current.delayed += 1;
        break;
      case "FAILED":
      case "CANCELLED":
        current.failed += 1;
        break;
      case "QUEUED":
      case "SENT":
        current.inFlight += 1;
        break;
      default: {
        const exhaustive: never = row.status;
        throw new Error(`Unknown delivery status: ${String(exhaustive)}`);
      }
    }
    acc.set(row.correlationId, current);
  }

  const out = new Map<string, DeliveryRollup>();
  for (const [key, value] of acc) {
    out.set(key, Object.freeze({ ...value }));
  }
  return out;
}

/**
 * Load delivery rollups for a set of report-run ids (the
 * `correlationId` on the delivery rows). Returns an empty map when
 * the input is empty (skips the query).
 */
export async function rollupDeliveriesByReportRun(input: {
  readonly tenancy: TenancyContext;
  readonly reportRunIds: ReadonlyArray<string>;
}): Promise<ReadonlyMap<string, DeliveryRollup>> {
  if (input.reportRunIds.length === 0) return new Map();
  return readInTenantContext(input.tenancy, async (tx) => {
    const rows = await tx.notificationDelivery.findMany({
      where: { correlationId: { in: [...input.reportRunIds] } },
      select: { correlationId: true, status: true },
    });
    return rollupByCorrelation(rows);
  });
}
