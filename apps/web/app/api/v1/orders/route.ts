// /api/v1/orders — partner order surface (ADR-0032, public v1).
//
//   GET  — order list. Scope: `orders.read`.
//          Pagination: cursor on order id, `limit` 1-100 (default
//          50), newest-first. Optional `status` filter.
//   POST — order intake (the "intake API" the ADR deferred v1 writes
//          behind). Scope: `orders.create`. Requires
//          `Idempotency-Key`. Dispatches the same `CreateOrder`
//          command the ops console uses — every workflow invariant
//          (clinic/site link, patient/prescription ownership, INBOX
//          bucket, workflow policy, SLA interval) is enforced by the
//          command, not re-implemented here. `intakeSourceKind` is
//          FORCED to `API`: how an order entered the system is a
//          fact about the transport, not a client claim.
//
// Projections are PHI-free: workflow/state/timing fields plus opaque
// UUID references. Patient demographics are NEVER exposed on v1
// order surfaces — a future `/api/v1/patients/{id}` surface with its
// own scope would own that decision.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { IntakeSourceKind, OrderStatus, readInOrgScope } from "@pharmax/database";
import { CreateOrder } from "@pharmax/orders";
import { withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import {
  partnerCommandError,
  partnerJsonError,
  requireIdempotencyKeyHeader,
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

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.ORDERS_CREATE);
  if (denied !== null) return denied;
  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }
  // Reject an explicit client claim rather than silently overriding
  // it — a partner that sends `intakeSourceKind` has a wrong mental
  // model of the field, and silent coercion would hide that.
  if ("intakeSourceKind" in body) {
    return partnerJsonError({
      status: 400,
      code: "INTAKE_SOURCE_NOT_SETTABLE",
      message: "intakeSourceKind is set by the platform (always API on this endpoint).",
    });
  }

  try {
    const { output, replayed } = await withTenancyContext(resolved.context.tenancy, () =>
      executeCommandDetailed(
        CreateOrder,
        {
          clinicId: body["clinicId"],
          siteId: body["siteId"],
          patientId: body["patientId"],
          intakeSourceKind: IntakeSourceKind.API,
          lines: body["lines"],
          ...(typeof body["externalOrderNumber"] === "string"
            ? { externalOrderNumber: body["externalOrderNumber"] }
            : {}),
          ...(typeof body["intakeSourceRefId"] === "string"
            ? { intakeSourceRefId: body["intakeSourceRefId"] }
            : {}),
          ...(typeof body["priority"] === "string" ? { priority: body["priority"] } : {}),
        },
        { idempotencyKey: `partner:${resolved.context.key.apiKeyId}:${idem.key}` }
      )
    );
    return NextResponse.json(
      {
        data: output,
        ...(replayed ? { meta: { idempotentReplay: true } } : {}),
      },
      { status: replayed ? 200 : 201 }
    );
  } catch (cause) {
    const mapped = partnerCommandError(cause);
    if (mapped !== null) return mapped;
    throw cause;
  }
}
