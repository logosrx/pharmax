// POST /api/ops/shipping/package-photos
//
// Dispatch step of the dock-side package-photo capture flow. The
// operator's client has already POSTed the photo bytes to
// `/api/ops/shipping/package-photos/uploads` and received an opaque
// `uploadToken`. This route accepts a JSON body containing that
// token plus the pharmacy's external order number (and optional
// manual tracking number / workstation context / notes), then
// dispatches `CapturePackagePhoto` through the standard command
// bus.
//
// JSON in / JSON out: the dock UI is JS-driven, so a redirect-style
// response would break the "snap → confirm → toast" UX. Success
// returns the command's output (`{ photoId, matched, ... }`) so
// the UI can render the right toast immediately ("Captured and
// matched to Order ABC-123" / "Captured but no matching order
// found — verify the order number"). Failures return typed error
// codes so the UI can map e.g. `PACKAGE_PHOTO_DUPLICATE_BYTES` to
// "You've already captured this exact photo" (treated as success
// in the UI flow).
//
// Idempotency:
//
//   - Per-request key: `route:capture-package-photo:{uploadToken}`.
//     The token is itself unique per upload, so this key naturally
//     dedupes a double-click that retries the dispatch with the
//     same token. The command's own
//     `(organizationId, sha256)` unique index is the second line of
//     defense (different tokens, identical bytes).
//
// PHI invariant:
//
//   - The `notes` field MAY contain PHI; the command's
//     `redactFields: ["notes"]` declaration scrubs it from
//     `command_log.requestPayload` and the encrypted column
//     `notesEnc` is the only persisted form. The route logs only
//     structural fields (operatorUserId, organizationId, photoId,
//     matched, sha256).
//
// Why not `dispatchOpsCommand`:
//
//   - That helper is hard-wired to redirect-driven responses for
//     server-rendered HTML forms. The capture UI is JS-driven and
//     wants JSON. We replicate the helper's RBAC + tenancy + idem
//     skeleton inline because the dispatcher's signature can't
//     return JSON without a much wider refactor that we don't
//     need today.

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import { CapturePackagePhoto, type CapturePackagePhotoInput } from "@pharmax/package-capture";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../src/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CaptureErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present for `PACKAGE_PHOTO_DUPLICATE_BYTES` so the UI can deep-link the existing row. */
    readonly existingPhotoId?: string;
  };
}

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return jsonError(401, "CAPTURE_NO_SESSION", "Sign in to capture package photos.");
  }

  // Parse JSON body. Bad JSON → 400 with a typed code (the bus's
  // Zod validation would reject this anyway, but a malformed body
  // shouldn't even reach the bus dispatch.)
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(
      400,
      "CAPTURE_BODY_INVALID",
      "Request body is not valid JSON. Expected { uploadToken, pharmacyExternalOrderNumber, ... }."
    );
  }
  if (raw === null || typeof raw !== "object") {
    return jsonError(400, "CAPTURE_BODY_INVALID", "Request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const uploadToken = readString(body["uploadToken"]);
  if (uploadToken === null) {
    return jsonError(
      400,
      "CAPTURE_UPLOAD_TOKEN_MISSING",
      "uploadToken is required. POST the photo bytes to /uploads first to obtain a token."
    );
  }

  // We don't pre-validate the rest of the fields here — the
  // command's Zod schema is the canonical contract; surfacing its
  // typed error code in the JSON response is more useful than
  // re-implementing the validation. The Zod errors arrive as
  // ValidationError instances which carry a code we can map.
  const input: CapturePackagePhotoInput = {
    uploadToken,
    pharmacyExternalOrderNumber: readString(body["pharmacyExternalOrderNumber"]) ?? "",
    ...(typeof body["manualTrackingNumber"] === "string"
      ? { manualTrackingNumber: body["manualTrackingNumber"] }
      : {}),
    ...(typeof body["workstationId"] === "string" ? { workstationId: body["workstationId"] } : {}),
    ...(typeof body["notes"] === "string" ? { notes: body["notes"] } : {}),
  };

  const idempotencyKey = `route:capture-package-photo:${uploadToken}`;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(CapturePackagePhoto, input, { idempotencyKey })
    );
    logger.info("ops.shipping.package_photo.captured", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: out.photoId,
      matched: out.matched,
      matchedOrderId: out.matchedOrderId,
      trackingSource: out.trackingSource,
      sha256: out.sha256,
    });
    return NextResponse.json(out, { status: 201 });
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
 * Map command-bus errors to JSON responses. We rely on the
 * `httpStatus` already declared on each `PharmaxError` subclass
 * (e.g. `ConflictError.httpStatus = 409`), which keeps this route
 * decoupled from the command's specific error catalog. The
 * conflict-on-duplicate branch is the one place we crack metadata
 * open — to surface `existingPhotoId` so the UI can navigate / link
 * back to the prior capture.
 */
function mapCommandError(cause: unknown, operatorUserId: string, organizationId: string): Response {
  if (!(cause instanceof errors.PharmaxError)) {
    logger.error("ops.shipping.package_photo.capture.unknown_error", {
      operatorUserId,
      organizationId,
    });
    return jsonError(500, "CAPTURE_UNKNOWN_ERROR", "Unexpected error capturing package photo.");
  }

  const code = cause.code;
  logger.warn("ops.shipping.package_photo.capture.failed", {
    operatorUserId,
    organizationId,
    code,
  });

  if (code === "PACKAGE_PHOTO_DUPLICATE_BYTES") {
    const existing = cause.metadata["existingPhotoId"];
    const existingPhotoId = typeof existing === "string" ? existing : undefined;
    return jsonError(cause.httpStatus, code, cause.message, existingPhotoId);
  }

  return jsonError(cause.httpStatus, code, cause.message);
}

function jsonError(
  status: number,
  code: string,
  message: string,
  existingPhotoId?: string
): Response {
  const body: CaptureErrorBody = {
    error: {
      code,
      message,
      ...(existingPhotoId !== undefined ? { existingPhotoId } : {}),
    },
  };
  return NextResponse.json(body, { status });
}
