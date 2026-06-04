// POST /api/ops/shipping/unmatched/archive
//
// Server-rendered orchestrator for the triage page's "Archive"
// action. The clerk picks a disposition reason on an unmatched
// capture and submits a native HTML form; this route dispatches
// `ArchivePackagePhoto` and redirects back to the triage page with a
// typed flash.
//
// Same server-rendered idiom as the resolve orchestrator
// (`/api/ops/shipping/unmatched/resolve`): form in, redirect-with-
// flash out, JS-free.
//
// Idempotency:
//
//   - Key: `route:archive-package-photo:{photoId}`. Archiving is a
//     terminal idempotent disposition (a second archive of the same
//     photo is a no-op the command handles), so a single
//     photo-scoped key is correct — a double-submit collapses onto
//     the first response and the command's own already-archived
//     branch is the data-level guard.
//
// PHI invariant: inputs are a photo id + a reason enum. No PHI. The
// flash carries only the photo id + reason. Logs structural only.

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import {
  ArchivePackagePhoto,
  type ArchivePackagePhotoInput,
  type PackagePhotoArchiveReason,
} from "@pharmax/package-capture";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAGE_PATH = "/ops/shipping/unmatched";

const VALID_REASONS: ReadonlySet<PackagePhotoArchiveReason> = new Set([
  "TEST_CAPTURE",
  "DUPLICATE",
  "CAPTURED_IN_ERROR",
  "UNRESOLVABLE",
]);

function isArchiveReason(value: string): value is PackagePhotoArchiveReason {
  return VALID_REASONS.has(value as PackagePhotoArchiveReason);
}

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return redirect("/sign-in");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectFlash(TRIAGE_PATH, {
      error: "ARCHIVE_FORM_INVALID:Could not read the form submission.",
    });
  }

  const photoId = readFormString(form, "photoId");
  const reasonRaw = readFormString(form, "reason");

  if (photoId === null) {
    return redirectFlash(TRIAGE_PATH, {
      error: "ARCHIVE_PHOTO_ID_MISSING:Missing photo id on the archive submission.",
    });
  }
  if (reasonRaw === null || !isArchiveReason(reasonRaw)) {
    return redirectFlash(TRIAGE_PATH, {
      error: "ARCHIVE_REASON_INVALID:Pick a valid archive reason.",
      photoId,
    });
  }

  const input: ArchivePackagePhotoInput = { photoId, reason: reasonRaw };
  const idempotencyKey = `route:archive-package-photo:${photoId}`;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(ArchivePackagePhoto, input, { idempotencyKey })
    );
    logger.info("ops.shipping.package_photo.archived", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: out.photoId,
      reason: out.reason,
      wasMatched: out.wasMatched,
      alreadyArchived: out.alreadyArchived,
    });
    return redirectFlash(TRIAGE_PATH, {
      flash: out.alreadyArchived ? "archived_noop" : "archived",
      photoId: out.photoId,
      reason: out.reason,
    });
  } catch (cause) {
    const code = cause instanceof errors.PharmaxError ? cause.code : "ARCHIVE_UNKNOWN";
    const message =
      cause instanceof errors.PharmaxError
        ? cause.message
        : "Unexpected error archiving the photo.";
    logger.warn("ops.shipping.package_photo.archive.failed", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      code,
    });
    return redirectFlash(TRIAGE_PATH, { error: `${code}:${message}`, photoId });
  }
}

function readFormString(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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
