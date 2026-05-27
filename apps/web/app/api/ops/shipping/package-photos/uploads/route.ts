// POST /api/ops/shipping/package-photos/uploads
//
// Multipart receiver for the dock-side package-photo capture flow.
// The operator's client (the dock UI camera capture component) POSTs
// a multipart/form-data body with a single `file` field containing
// the photo bytes. The route:
//
//   1. Resolves the Clerk session → Pharmax `TenancyContext`.
//   2. Gates the call on `ship.capture_package_photo` so a
//      session-stealer cannot fill storage with garbage. Same
//      permission the downstream `CapturePackagePhoto` command
//      enforces — duplicating it here is intentional defense in
//      depth (the storage layer has no view into RBAC).
//   3. Validates content-type + size via `parsePackagePhotoUpload`.
//   4. Calls `PackagePhotoStorage.beginUpload` with the operator's
//      organizationId. The adapter computes sha256 + the storage
//      key shape and returns an opaque `uploadToken`.
//   5. Returns JSON `{ uploadToken, sha256, fileSize, contentType }`
//      so the client can immediately POST the dispatch step
//      (`/api/ops/shipping/package-photos`) with the token + the
//      typed external order number.
//
// Why JSON (not redirect):
//
//   - The capture UI is JS-driven (camera capture + form). A
//     redirect-driven shape (the pattern the form-based ops routes
//     follow) would force an extra page load between the upload
//     and the dispatch, which breaks the "snap → confirm" UX.
//
// Why two routes (upload + dispatch) instead of one:
//
//   - The bus's idempotency cache hashes the command input. Binary
//     bytes don't serialize deterministically through canonicalize +
//     hash — `Buffer` / `Uint8Array` instances stringify differently
//     across realms. Splitting the upload out keeps the bytes off
//     the bus surface entirely; the command sees only an opaque
//     `uploadToken`.
//
//   - It lets a future S3 adapter swap the upload step for a
//     pre-signed PUT to S3 + a metadata roundtrip — clients write
//     to S3 directly, the web tier never sees the bytes, and the
//     dispatch step stays identical.
//
// PHI invariant:
//
//   - The route NEVER logs the bytes, the filename, or the
//     content-type. We log only the operator's user id, the
//     tenancy's organization id, and the resulting `sha256` /
//     `fileSize` (structural). The `parsePackagePhotoUpload`
//     helper has the same rule.

import "server-only";

import { errors, ids } from "@pharmax/platform-core";
import { getPackagePhotoStorage } from "@pharmax/package-capture";
import { PERMISSIONS, requirePermission } from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";
import { parsePackagePhotoUpload } from "../../../../../../src/server/ops/parse-package-photo-upload.js";

// Next.js route segment config — opt out of route-level body-size
// limits here; the helper enforces our own 25 MiB cap. The default
// is platform-dependent (Vercel's serverless function default is
// 4.5 MiB) and would silently truncate large multipart bodies
// without surfacing a typed error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UploadResponseBody {
  readonly uploadToken: string;
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
  readonly fileSize: number;
  readonly contentType: string;
}

interface UploadErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export async function POST(request: Request): Promise<Response> {
  // 1. Resolve operator session.
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return jsonError(401, "UPLOAD_NO_SESSION", "Sign in to capture package photos.");
  }

  // 2. Read the multipart body. Wrap in try/catch because Next
  // throws on malformed multipart bodies and we want the error
  // shape to match the rest of this route.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "UPLOAD_MULTIPART_INVALID", "Could not parse multipart/form-data body.");
  }

  // 3. Enter tenancy + RBAC-check.
  //
  // We enter the operator's tenancy specifically so
  // `requirePermission` reads from the canonical context (it pulls
  // from AsyncLocalStorage). The same frame also stamps the
  // operator's correlationId on any downstream logs.
  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  return await withTenancyContext(tenancy, async () => {
    try {
      await requirePermission(PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO);
    } catch (cause) {
      const code =
        cause instanceof errors.PharmaxError ? cause.code : "PACKAGE_PHOTO_UPLOAD_FORBIDDEN";
      logger.warn("ops.shipping.package_photo.upload.forbidden", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code,
      });
      return jsonError(
        403,
        code,
        "You do not have permission to capture package photos for this organization."
      );
    }

    // 4. Validate content type + size + read bytes.
    const parsed = await parsePackagePhotoUpload(form);
    if (parsed.kind === "error") {
      logger.info("ops.shipping.package_photo.upload.rejected", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code: parsed.code,
      });
      return jsonError(400, parsed.code, parsed.message);
    }

    // 5. Hand the bytes to the configured storage adapter.
    const storage = getPackagePhotoStorage();
    const upload = await storage.beginUpload({
      organizationId: tenancy.organizationId,
      contentType: parsed.contentType,
      bytes: parsed.bytes,
    });

    logger.info("ops.shipping.package_photo.upload.accepted", {
      operatorUserId: session.operator.userId,
      organizationId: tenancy.organizationId,
      sha256: upload.sha256,
      fileSize: upload.fileSize,
      contentType: upload.contentType,
    });

    const body: UploadResponseBody = {
      uploadToken: upload.uploadToken,
      bucket: upload.bucket,
      key: upload.key,
      sha256: upload.sha256,
      fileSize: upload.fileSize,
      contentType: upload.contentType,
    };
    return NextResponse.json(body, { status: 201 });
  });
}

function jsonError(status: number, code: string, message: string): Response {
  const body: UploadErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status });
}
