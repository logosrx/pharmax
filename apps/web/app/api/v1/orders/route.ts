// GET /api/v1/orders — partner order list (ADR-0032, public v1).
//
// Auth: partner API key (Bearer). Scope: `orders.read`.
// Pagination: cursor on order id, `limit` 1-100 (default 50),
// newest-first. Optional `status` filter (workflow OrderStatus).
//
// Projection is PHI-free: workflow/state/timing fields plus opaque
// UUID references. Patient demographics are NEVER exposed on v1
// order reads — a future `/api/v1/patients/{id}` surface with its
// own scope would own that decision.

import { OrderStatus, readInOrgScope } from "@pharmax/database";
import { NextResponse } from "next/server";

import {
  partnerJsonError,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../src/server/partner/resolve-partner-context.js";
import { PERMISSIONS } from "@pharmax/rbac";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const ORDER_SELECT = {
  id: true,
  externalOrderNumber: true,
  clinicId: true,
  siteId: true,
  patientId: true,
  currentStatus: true,
  priority: true,
  version: true,
  slaDeadlineAt: true,
  receivedAt: true,
  shippedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.ORDERS_READ);
  if (denied !== null) return denied;

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const cursor = url.searchParams.get("cursor");
  const rawStatus = url.searchParams.get("status");

  if (rawStatus !== null && !(rawStatus in OrderStatus)) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_STATUS",
      message: `Unknown order status "${rawStatus}".`,
    });
  }

  const organizationId = resolved.context.key.organizationId;
  const rows = await readInOrgScope(organizationId, (tx) =>
    tx.order.findMany({
      where: {
        organizationId,
        ...(rawStatus !== null ? { currentStatus: rawStatus as OrderStatus } : {}),
      },
      select: ORDER_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    data: page,
    pagination: {
      hasMore,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    },
  });
}
