// POST /api/ops/shipping/package-photos/capture
//
// Server-side orchestration route for the dock-side capture page
// (`/ops/shipping/dock`). The page renders a single multipart form;
// the operator hits Submit; this route does the entire capture in
// ONE round-trip:
//
//   1. Resolve session → tenancy.
//   2. Permission gate (`ship.capture_package_photo`).
//   3. Parse multipart payload (file + form fields).
//   4. `getPackagePhotoStorage().beginUpload(...)` — store bytes,
//      reserve an opaque token.
//   5. `executeCommand(CapturePackagePhoto, ...)` with the token.
//   6. Redirect back to /ops/shipping/dock with a typed flash so
//      the operator sees "matched / unmatched / duplicate / error"
//      without leaving the dock surface.
//
// Why server-side orchestration (NOT the existing two-route JSON
// flow):
//
//   - The existing `/uploads` (JSON) + `/` (JSON) routes were built
//     for a JS-driven SPA-style dock UI. The current codebase is
//     server-component-first with redirect-with-flash form-action
//     conventions everywhere else (every other ops surface — pv1,
//     final, fill, shipping queue — uses native HTML forms). One
//     route that does both steps means:
//
//       - The dock page stays a server component (no client JS).
//       - The form uses the native `<input type="file"
//         capture="environment">` for camera support on every
//         device — works without JS, works on every browser, works
//         offline-first if the bytes are queued by the OS.
//       - The orchestration runs entirely inside the operator's
//         tenancy frame in a single request, so any failure is
//         visible immediately as a flash error (no two-step
//         partial-failure window where the bytes uploaded but the
//         dispatch never fired).
//
//   - The two-route JSON flow stays in place (it's also
//     production-supported for any future SPA / mobile client
//     that prefers the SPA shape). This route simply provides a
//     second, server-rendered path to the same domain command.
//
// Idempotency:
//
//   - The command's idempotency key here is
//     `route:dock-capture-package-photo:{uploadToken}`. The token
//     is generated INSIDE this route, so a double-click that
//     re-submits the same multipart form generates a NEW token —
//     intentional, because the bytes are re-read from the
//     resubmitted form. The data-level safety net is the
//     `(organizationId, sha256)` unique index inside the
//     `CapturePackagePhoto` command, which surfaces a typed
//     `PACKAGE_PHOTO_DUPLICATE_BYTES` ConflictError that we map
//     to a "duplicate" flash with the existing photo's id.
//
// PHI invariant:
//
//   - The route NEVER logs the bytes, the filename, the
//     content-type-from-the-file, or the `notes` value (which
//     may carry incidental PHI). We log only the operator id,
//     the org id, structural metadata (sha256, fileSize,
//     contentType-as-classified-by-our-allowlist, photoId,
//     matched, trackingSource).
//   - The flash query string carries only opaque ids (photoId,
//     matchedOrderId) — no patient identifiers, no notes, no
//     external order number (the rep already typed it; echoing
//     it back is fine, but we don't put it in the URL).

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import { CapturePackagePhoto, getPackagePhotoStorage } from "@pharmax/package-capture";
import { errors, ids } from "@pharmax/platform-core";
import { PERMISSIONS, requirePermission } from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";
import { parsePackagePhotoUpload } from "../../../../../../src/server/ops/parse-package-photo-upload.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCK_PATH = "/ops/shipping/dock";

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    // Mirror dispatchOpsCommand's unauthenticated behaviour —
    // bounce to sign-in. Clerk middleware would catch this
    // earlier in production, but keep the explicit branch for
    // local-dev + test runs where middleware can be relaxed.
    return redirect("/sign-in");
  }

  // Read the form body OUTSIDE the tenancy frame because Next's
  // FormData parser doesn't need any tenancy state, and bad
  // multipart shouldn't reach the RBAC gate.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectFlash(DOCK_PATH, {
      error: "DOCK_CAPTURE_MULTIPART_INVALID:Could not read the form upload.",
    });
  }

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  return await withTenancyContext(tenancy, async () => {
    // -------------------------------------------------------------
    // 1. RBAC. Defense in depth — `beginUpload` is also gated
    //    inside the storage adapter via tenancy frame inspection,
    //    but we want a typed permission denial here so the flash
    //    has a useful error code.
    // -------------------------------------------------------------
    try {
      await requirePermission(PERMISSIONS.SHIP_CAPTURE_PACKAGE_PHOTO);
    } catch (cause) {
      const code = cause instanceof errors.PharmaxError ? cause.code : "DOCK_CAPTURE_FORBIDDEN";
      logger.warn("ops.shipping.package_photo.dock.forbidden", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code,
      });
      return redirectFlash(DOCK_PATH, {
        error: `${code}:You do not have permission to capture package photos.`,
      });
    }

    // -------------------------------------------------------------
    // 2. Validate file bytes (content-type allowlist + size cap).
    //    The helper enforces the same policy the JSON `/uploads`
    //    route does — sharing it keeps "what counts as a valid
    //    package photo" defined in exactly one place.
    // -------------------------------------------------------------
    const parsed = await parsePackagePhotoUpload(form);
    if (parsed.kind === "error") {
      logger.info("ops.shipping.package_photo.dock.rejected", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        code: parsed.code,
      });
      return redirectFlash(DOCK_PATH, { error: `${parsed.code}:${parsed.message}` });
    }

    // -------------------------------------------------------------
    // 3. Read the rest of the form fields. We accept the same
    //    shape the JSON dispatch route does, minus `workstationId`
    //    (the dock UI is mobile-driven; workstation pinning is
    //    irrelevant on a phone-in-hand flow). The rep types the
    //    external order number; the manual-tracking + notes
    //    fields are optional.
    // -------------------------------------------------------------
    const externalOrderNumber = readFormString(form, "pharmacyExternalOrderNumber");
    if (externalOrderNumber === null) {
      return redirectFlash(DOCK_PATH, {
        error: "DOCK_CAPTURE_EXTERNAL_ORDER_REQUIRED:Type the order number on the package label.",
      });
    }
    const manualTrackingNumber = readFormString(form, "manualTrackingNumber");
    const notes = readFormString(form, "notes");

    // -------------------------------------------------------------
    // 4. beginUpload. The S3 adapter requires the active tenancy
    //    frame; the in-memory adapter accepts it but ignores it.
    //    Either way we're inside `withTenancyContext` here.
    // -------------------------------------------------------------
    const storage = getPackagePhotoStorage();
    let upload;
    try {
      upload = await storage.beginUpload({
        organizationId: tenancy.organizationId,
        contentType: parsed.contentType,
        bytes: parsed.bytes,
      });
    } catch (cause) {
      logger.error("ops.shipping.package_photo.dock.storage_failed", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        error: cause,
      });
      return redirectFlash(DOCK_PATH, {
        error: "DOCK_CAPTURE_STORAGE_FAILED:Could not save the photo bytes. Try again.",
      });
    }

    logger.info("ops.shipping.package_photo.dock.upload_accepted", {
      operatorUserId: session.operator.userId,
      organizationId: tenancy.organizationId,
      sha256: upload.sha256,
      fileSize: upload.fileSize,
      contentType: upload.contentType,
    });

    // -------------------------------------------------------------
    // 5. Dispatch the capture command.
    // -------------------------------------------------------------
    const idempotencyKey = `route:dock-capture-package-photo:${upload.uploadToken}`;

    try {
      const out = await executeCommand(
        CapturePackagePhoto,
        {
          uploadToken: upload.uploadToken,
          pharmacyExternalOrderNumber: externalOrderNumber,
          ...(manualTrackingNumber !== null ? { manualTrackingNumber } : {}),
          ...(notes !== null ? { notes } : {}),
        },
        { idempotencyKey }
      );

      logger.info("ops.shipping.package_photo.dock.captured", {
        operatorUserId: session.operator.userId,
        organizationId: tenancy.organizationId,
        photoId: out.photoId,
        matched: out.matched,
        matchedOrderId: out.matchedOrderId,
        trackingSource: out.trackingSource,
        sha256: out.sha256,
      });

      // Flash key choice mirrors the verb in the success log.
      const flashKey = out.matched ? "matched" : "unmatched";
      const flashParams: Record<string, string> = {
        flash: flashKey,
        photoId: out.photoId,
      };
      if (out.matchedOrderId !== null) flashParams["matchedOrderId"] = out.matchedOrderId;
      return redirectFlash(DOCK_PATH, flashParams);
    } catch (cause) {
      return mapCommandErrorToFlash(cause, session.operator.userId, tenancy.organizationId);
    }
  });
}

function readFormString(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapCommandErrorToFlash(
  cause: unknown,
  operatorUserId: string,
  organizationId: string
): Response {
  if (!(cause instanceof errors.PharmaxError)) {
    logger.error("ops.shipping.package_photo.dock.unknown_error", {
      operatorUserId,
      organizationId,
      error: cause,
    });
    return redirectFlash(DOCK_PATH, {
      error: "DOCK_CAPTURE_UNKNOWN:Unexpected error. Try again or escalate.",
    });
  }

  const code = cause.code;
  logger.warn("ops.shipping.package_photo.dock.failed", {
    operatorUserId,
    organizationId,
    code,
  });

  // Duplicate-bytes is a "soft success" in the dock UX — the
  // photo is already on file under `existingPhotoId`. Flash a
  // typed `duplicate` so the page can render a deep-link to the
  // existing capture.
  if (code === "PACKAGE_PHOTO_DUPLICATE_BYTES") {
    const existing = cause.metadata["existingPhotoId"];
    const existingPhotoId = typeof existing === "string" ? existing : "";
    return redirectFlash(DOCK_PATH, {
      flash: "duplicate",
      photoId: existingPhotoId,
    });
  }

  return redirectFlash(DOCK_PATH, {
    error: `${code}:${cause.message}`,
  });
}

function redirect(path: string): Response {
  return NextResponse.redirect(new URL(path, "http://internal").toString(), { status: 303 });
}

function redirectFlash(path: string, params: Record<string, string>): Response {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v.length === 0) continue;
    search.set(k, v);
  }
  const qs = search.toString();
  const target = qs.length > 0 ? `${path}?${qs}` : path;
  return NextResponse.redirect(new URL(target, "http://internal").toString(), { status: 303 });
}
