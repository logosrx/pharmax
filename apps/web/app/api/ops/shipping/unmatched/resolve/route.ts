// POST /api/ops/shipping/unmatched/resolve
//
// Server-rendered orchestrator for the unmatched-bucket triage page
// (`/ops/shipping/unmatched`). The clerk picks a candidate order in
// the picker and submits a native HTML form; this route dispatches
// `ResolvePackagePhotoMatch` and redirects back to the triage page
// with a typed flash so the result is visible inline.
//
// Why a second route (the JSON `[photoId]/resolve-match` already
// exists):
//
//   - Same reasoning as the dock `/capture` orchestrator. Every
//     ops surface in `apps/web` is a server component with native
//     form-action POST + redirect-with-flash. This route lets the
//     triage page stay JS-free; the pre-existing JSON route remains
//     for any future SPA / mobile client.
//
// Idempotency:
//
//   - Key: `route:resolve-package-photo-match:{photoId}:{targetOrderId}`.
//     BOTH ids are in the key (matching the JSON route's contract):
//     a double-submit on the same candidate dedupes, but a clerk
//     who picks a DIFFERENT order on a second click gets a distinct
//     key — so the second dispatch reaches the bus and surfaces the
//     `PACKAGE_PHOTO_ALREADY_MATCHED` conflict instead of silently
//     replaying the first match. We deliberately do NOT use the
//     generic `dispatchOpsCommand` helper here because its key is a
//     static prefix + minute-bucket, which would collapse two
//     different-target clicks in the same minute onto one cached
//     response.
//
// PHI invariant:
//
//   - Inputs are structural ids only (photoId, targetOrderId). No
//     PHI. The flash query string carries only opaque ids
//     (photoId, matchedOrderId). Logs carry structural deltas only.

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import {
  ResolvePackagePhotoMatch,
  type ResolvePackagePhotoMatchInput,
} from "@pharmax/package-capture";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAGE_PATH = "/ops/shipping/unmatched";

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
      error: "RESOLVE_FORM_INVALID:Could not read the form submission.",
    });
  }

  const photoId = readFormString(form, "photoId");
  const targetOrderId = readFormString(form, "targetOrderId");

  if (photoId === null) {
    return redirectFlash(TRIAGE_PATH, {
      error: "RESOLVE_PHOTO_ID_MISSING:Missing photo id on the resolve submission.",
    });
  }
  if (targetOrderId === null) {
    return redirectFlash(TRIAGE_PATH, {
      // Keep the operator on the photo they were working so the
      // picker re-opens with their context intact.
      error: "RESOLVE_TARGET_ORDER_ID_MISSING:Pick an order before confirming the match.",
      photoId,
    });
  }

  const input: ResolvePackagePhotoMatchInput = { photoId, targetOrderId };
  const idempotencyKey = `route:resolve-package-photo-match:${photoId}:${targetOrderId}`;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(ResolvePackagePhotoMatch, input, { idempotencyKey })
    );
    logger.info("ops.shipping.package_photo.triage.resolved", {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      photoId: out.photoId,
      matchedOrderId: out.matchedOrderId,
      matchedPatientId: out.matchedPatientId,
      clinicBackfilled: out.clinicBackfilled,
      trackingBackfilled: out.trackingBackfilled,
    });
    return redirectFlash(TRIAGE_PATH, {
      flash: "resolved",
      photoId: out.photoId,
      matchedOrderId: out.matchedOrderId,
    });
  } catch (cause) {
    return mapCommandErrorToFlash(
      cause,
      photoId,
      session.operator.userId,
      session.tenancy.organizationId
    );
  }
}

function readFormString(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapCommandErrorToFlash(
  cause: unknown,
  photoId: string,
  operatorUserId: string,
  organizationId: string
): Response {
  if (!(cause instanceof errors.PharmaxError)) {
    logger.error("ops.shipping.package_photo.triage.unknown_error", {
      operatorUserId,
      organizationId,
      error: cause,
    });
    return redirectFlash(TRIAGE_PATH, {
      error: "RESOLVE_UNKNOWN:Unexpected error resolving the match. Try again or escalate.",
      photoId,
    });
  }

  const code = cause.code;
  logger.warn("ops.shipping.package_photo.triage.failed", {
    operatorUserId,
    organizationId,
    code,
  });

  // Already-matched (someone beat the clerk to it, or a stale tab)
  // surfaces the winner's order id so the page can deep-link it.
  if (code === "PACKAGE_PHOTO_ALREADY_MATCHED") {
    const existing = cause.metadata["existingMatchedOrderId"];
    const existingMatchedOrderId = typeof existing === "string" ? existing : "";
    return redirectFlash(TRIAGE_PATH, {
      error: `${code}:This photo was already matched by someone else. No change was made.`,
      photoId,
      matchedOrderId: existingMatchedOrderId,
    });
  }

  return redirectFlash(TRIAGE_PATH, {
    error: `${code}:${cause.message}`,
    photoId,
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
