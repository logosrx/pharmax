// GET /api/ops/shipping/package-photos/:photoId/image
//
// Authenticated byte-proxy that streams a captured package photo's
// bytes to the operator's browser. Rendered by the order-detail
// "Package photos" section and the unmatched-bucket triage surface
// (`<img src=".../image">`).
//
// Why a byte-proxy and NOT a presigned S3 GET:
//
//   - Every fetch stays authorization-checked + tenant-scoped. A
//     presigned URL is a bearer token: anyone who captures it can
//     fetch until expiry, and the auth decision is frozen at
//     issue-time. For a multi-tenant store of sealed-package imagery
//     (which can incidentally include a shipping label), re-checking
//     RBAC + tenancy on every request is the safer default.
//   - It works identically against the in-memory dev adapter and the
//     S3 prod adapter — the route only talks to the
//     `PackagePhotoStorage` port, never the AWS SDK.
//   - The presigned-GET optimization (skip the web tier for large
//     objects) is tracked as follow-up; package photos are small.
//
// Authorization:
//
//   - The bytes are package-shipping content visible from three
//     surfaces. We OR the permissions that gate those surfaces:
//       · orders.read                  — order-detail timeline
//       · ship.resolve_package_photo_match — triage (unmatched bucket)
//       · ship.capture_package_photo   — dock recent-captures
//     Holding ANY of them is a legitimate reason to view package
//     photos in this org. The row lookup is RLS-scoped, so the photo
//     must also belong to the caller's tenant.
//
// Integrity:
//
//   - After the bytes come back we recompute sha256 and compare to
//     the `package_photo.sha256` column. A mismatch (bucket policy
//     drift, object swap) is refused with a 502 — we never serve
//     bytes that don't match what was captured.
//
// Response shape:
//
//   - Plain status codes (NOT redirects): an `<img>` src can't
//     follow a redirect-to-sign-in usefully, so 401/403/404/502
//     surface as a broken image, which is the correct UX.
//   - `Content-Type` is the DB-validated `package_photo.contentType`
//     (from the upload allowlist), never storage-reported metadata.
//   - `Cache-Control: private, no-store` + `X-Content-Type-Options:
//     nosniff` — don't let a shared cache retain potentially
//     label-bearing imagery, and don't let the browser MIME-sniff a
//     served object into something executable.
//
// PHI invariant:
//
//   - Logs structural fields only (operatorUserId, organizationId,
//     photoId, fileSize, sha256). Never the bytes.

import "server-only";

import { createHash } from "node:crypto";

import { getPackagePhotoStorage } from "@pharmax/package-capture";
import { PERMISSIONS } from "@pharmax/rbac";
import { NextResponse } from "next/server";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../../src/server/logger.js";
import { getPackagePhotoStorageDescriptor } from "../../../../../../../src/server/ops/get-package-photo-descriptor.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  readonly params: Promise<{ readonly photoId: string }>;
}

function statusJson(status: number, code: string, message: string): Response {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(_request: Request, context: RouteParams): Promise<Response> {
  const { photoId } = await context.params;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return statusJson(401, "IMAGE_NO_SESSION", "Sign in to view package photos.");
  }

  if (typeof photoId !== "string" || photoId.trim().length === 0) {
    return statusJson(400, "IMAGE_PHOTO_ID_MISSING", "Path parameter :photoId is required.");
  }

  const permissions = await loadOperatorPermissions(session.tenancy);
  const canView =
    hasOperatorPermission(permissions, PERMISSIONS.ORDERS_READ) ||
    hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_PACKAGE_PHOTO_MATCH) ||
    hasOperatorPermission(permissions, PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO);
  if (!canView) {
    return statusJson(
      403,
      "IMAGE_FORBIDDEN",
      "You do not have permission to view package photos. Requires orders.read, ship.capture_package_photo, or ship.resolve_package_photo_match."
    );
  }

  // 1. Confirm the photo exists in the caller's tenant + recover its
  //    storage pointer. RLS + the explicit org predicate are the
  //    isolation boundary.
  const descriptor = await getPackagePhotoStorageDescriptor({
    organizationId: session.tenancy.organizationId,
    photoId: photoId.trim(),
  });
  if (descriptor === null) {
    return statusJson(404, "IMAGE_NOT_FOUND", "Package photo not found in your organization.");
  }

  // 2. Fetch the bytes from the configured storage adapter. `null`
  //    means the object is gone (in-memory adapter after a restart,
  //    or an S3 object swept by the janitor) — a 404 with a hint.
  const storage = getPackagePhotoStorage();
  let object;
  try {
    object = await storage.readObject({
      organizationId: session.tenancy.organizationId,
      bucket: descriptor.bucket,
      key: descriptor.key,
    });
  } catch (cause) {
    logger.error("ops.shipping.package_photo.image.storage_error", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: descriptor.photoId,
      error: cause,
    });
    return statusJson(
      502,
      "IMAGE_STORAGE_ERROR",
      "Could not read the photo from storage. It may be temporarily unavailable."
    );
  }
  if (object === null) {
    logger.warn("ops.shipping.package_photo.image.object_missing", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: descriptor.photoId,
    });
    return statusJson(
      404,
      "IMAGE_OBJECT_MISSING",
      "The photo record exists but its bytes are not in storage (non-durable dev storage, or swept)."
    );
  }

  // 3. Integrity gate. Recompute sha256 and compare to the captured
  //    digest. A mismatch means the stored object is not what was
  //    captured — refuse rather than serve drifted bytes.
  const actualSha = createHash("sha256").update(object.bytes).digest("hex");
  if (actualSha !== descriptor.sha256) {
    logger.error("ops.shipping.package_photo.image.integrity_violation", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: descriptor.photoId,
      expectedSha: descriptor.sha256,
      actualSha,
    });
    return statusJson(
      502,
      "IMAGE_INTEGRITY_VIOLATION",
      "The stored photo failed an integrity check and was not served."
    );
  }

  logger.info("ops.shipping.package_photo.image.served", {
    operatorUserId: session.operator.userId,
    organizationId: session.tenancy.organizationId,
    photoId: descriptor.photoId,
    fileSize: descriptor.fileSize,
    sha256: descriptor.sha256,
  });

  // Node 22 `Response` rejects a bare `Uint8Array` in some strict
  // libcheck modes — wrap as a Buffer for unambiguous BodyInit
  // overload selection (mirrors the report-download route).
  const body = Buffer.from(object.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      // DB-validated content type (upload allowlist), not the
      // storage-reported value.
      "Content-Type": descriptor.contentType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Pharmax-Package-Photo-Id": descriptor.photoId,
    },
  });
}
