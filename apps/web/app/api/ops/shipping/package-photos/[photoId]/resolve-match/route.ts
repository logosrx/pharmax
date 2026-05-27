// POST /api/ops/shipping/package-photos/:photoId/resolve-match
//
// Operator triage step for a dock capture that did not auto-match
// at capture time. The unmatched-bucket UI lets the operator
// pick a candidate `Order` (search by external order number /
// patient / scan); when they confirm, the UI POSTs JSON here:
//
//     { "targetOrderId": "<uuid>" }
//
// The route dispatches `ResolvePackagePhotoMatch` through the
// standard command bus, which:
//
//   - Permission-gates on `ship.resolve_package_photo_match` (held
//     by ShippingClerk; deliberately NOT held by
//     PharmacyTechnician — the producer/dispositioner separation
//     mirrors the rest of the workflow safety model).
//   - Refuses to re-match an already-matched photo (the audit
//     anchor is the photo, not a movable pointer).
//   - Back-fills clinic + tracking metadata from the target order
//     when the photo had nulls at capture time.
//
// JSON in / JSON out: same convention as the capture-dispatch
// route — the unmatched-bucket UI is JS-driven and wants typed
// codes back, not redirects.
//
// Idempotency:
//
//   - Key: `route:resolve-package-photo-match:{photoId}:{targetOrderId}`.
//
//     Including BOTH ids in the key is deliberate. A double-click
//     on the same candidate dedupes correctly (same key →
//     cached response). But a misclick that picks DIFFERENT
//     candidates yields different keys, so both dispatches hit
//     the bus — the first wins, the second surfaces
//     `PACKAGE_PHOTO_ALREADY_MATCHED` with the winner's id in
//     metadata. If we keyed on photoId alone, the second click
//     would silently return the first click's response and the
//     operator would never see the conflict.
//
// PHI invariant:
//
//   - No PHI in inputs (structural ids only).
//   - Logged fields are structural deltas only (photoId,
//     targetOrderId, matchedPatientId, clinicBackfilled,
//     trackingBackfilled). No notes, no patient names.

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import {
  ResolvePackagePhotoMatch,
  type ResolvePackagePhotoMatchInput,
} from "@pharmax/package-capture";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../../src/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  readonly params: Promise<{ readonly photoId: string }>;
}

interface ResolveErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present for `PACKAGE_PHOTO_ALREADY_MATCHED` so the UI can deep-link the winner. */
    readonly existingMatchedOrderId?: string;
    readonly existingMatchStrategy?: string;
  };
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { photoId } = await context.params;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return jsonError(401, "RESOLVE_NO_SESSION", "Sign in to resolve package-photo matches.");
  }

  if (typeof photoId !== "string" || photoId.trim().length === 0) {
    return jsonError(
      400,
      "RESOLVE_PHOTO_ID_MISSING",
      "Path parameter :photoId is required and must be non-empty."
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(
      400,
      "RESOLVE_BODY_INVALID",
      "Request body is not valid JSON. Expected { targetOrderId }."
    );
  }
  if (raw === null || typeof raw !== "object") {
    return jsonError(400, "RESOLVE_BODY_INVALID", "Request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const targetOrderId = readString(body["targetOrderId"]);
  if (targetOrderId === null) {
    return jsonError(
      400,
      "RESOLVE_TARGET_ORDER_ID_MISSING",
      "targetOrderId is required and must be a non-empty string."
    );
  }

  const input: ResolvePackagePhotoMatchInput = {
    photoId: photoId.trim(),
    targetOrderId,
  };

  const idempotencyKey = `route:resolve-package-photo-match:${input.photoId}:${input.targetOrderId}`;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(ResolvePackagePhotoMatch, input, { idempotencyKey })
    );
    logger.info("ops.shipping.package_photo.match_resolved", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: out.photoId,
      matchedOrderId: out.matchedOrderId,
      matchedPatientId: out.matchedPatientId,
      clinicBackfilled: out.clinicBackfilled,
      trackingBackfilled: out.trackingBackfilled,
    });
    return NextResponse.json(out, { status: 200 });
  } catch (cause) {
    return mapCommandError(cause, session.operator.userId, session.tenancy.organizationId);
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map command-bus errors to JSON responses. Same `httpStatus`-driven
 * pattern as the capture-dispatch route. The
 * `PACKAGE_PHOTO_ALREADY_MATCHED` branch cracks metadata open to
 * surface the WINNER's order id — the unmatched-bucket UI uses
 * this to render "this photo was already matched to Order
 * <link-to-existing>" instead of a generic conflict message.
 */
function mapCommandError(cause: unknown, operatorUserId: string, organizationId: string): Response {
  if (!(cause instanceof errors.PharmaxError)) {
    logger.error("ops.shipping.package_photo.match_resolved.unknown_error", {
      operatorUserId,
      organizationId,
    });
    return jsonError(
      500,
      "RESOLVE_UNKNOWN_ERROR",
      "Unexpected error resolving package-photo match."
    );
  }

  const code = cause.code;
  logger.warn("ops.shipping.package_photo.match_resolved.failed", {
    operatorUserId,
    organizationId,
    code,
  });

  if (code === "PACKAGE_PHOTO_ALREADY_MATCHED") {
    const existingOrder = cause.metadata["existingMatchedOrderId"];
    const existingStrategy = cause.metadata["existingMatchStrategy"];
    const existingMatchedOrderId = typeof existingOrder === "string" ? existingOrder : undefined;
    const existingMatchStrategy =
      typeof existingStrategy === "string" ? existingStrategy : undefined;
    return jsonConflictError(
      cause.httpStatus,
      code,
      cause.message,
      existingMatchedOrderId,
      existingMatchStrategy
    );
  }

  return jsonError(cause.httpStatus, code, cause.message);
}

function jsonError(status: number, code: string, message: string): Response {
  const body: ResolveErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}

function jsonConflictError(
  status: number,
  code: string,
  message: string,
  existingMatchedOrderId: string | undefined,
  existingMatchStrategy: string | undefined
): Response {
  const body: ResolveErrorBody = {
    error: {
      code,
      message,
      ...(existingMatchedOrderId !== undefined ? { existingMatchedOrderId } : {}),
      ...(existingMatchStrategy !== undefined ? { existingMatchStrategy } : {}),
    },
  };
  return NextResponse.json(body, { status });
}
