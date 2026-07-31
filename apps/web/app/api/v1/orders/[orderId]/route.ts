// GET /api/v1/orders/{orderId} — partner order detail (ADR-0032).
//
// Auth: partner API key (Bearer). Scope: `orders.read`.
// Same PHI-free projection as the list, plus line-level references
// (opaque prescription ids + fill quantities) and shipment tracking
// summaries — no patient demographics.

import { readInOrgScope } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { NextResponse } from "next/server";

import {
  partnerJsonError,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../../src/server/partner/resolve-partner-context.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.ORDERS_READ);
  if (denied !== null) return denied;

  const { orderId } = await params;
  if (!UUID_REGEX.test(orderId)) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_ORDER_ID",
      message: "orderId must be a UUID.",
    });
  }

  const organizationId = resolved.context.key.organizationId;
  const order = await readInOrgScope(organizationId, (tx) =>
    tx.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
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
        orderLines: {
          select: {
            id: true,
            prescriptionId: true,
            quantityToFill: true,
            daysSupplyToFill: true,
            lineStatus: true,
          },
          orderBy: { createdAt: "asc" },
        },
        shipments: {
          select: {
            id: true,
            carrier: true,
            serviceLevel: true,
            trackingNumber: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    })
  );

  if (order === null) {
    return partnerJsonError({
      status: 404,
      code: "ORDER_NOT_FOUND",
      message: "Order not found.",
    });
  }
  return NextResponse.json({ data: order });
}
