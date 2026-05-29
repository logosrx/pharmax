// GET /api/ops/reports/runs/[reportRunId]/download
//
// Streams the persisted CSV for a `report_run` row to the
// operator's browser. Wraps the call in:
//
//   1. Clerk session → Pharmax tenancy resolution.
//   2. `reports.run` permission check (the same gate that
//      authorized the run itself; we don't introduce a separate
//      `reports.download` permission today because the use case
//      is identical).
//   3. Tenancy-scoped lookup of the `report_run` row (RLS
//      guarantees we can't see another org's row even if a
//      malicious id is guessed).
//   4. ReportRunArchivePort GET — re-validates sha256 after the
//      bytes come back (defense against bucket policy drift).
//   5. Stream with `Content-Type: text/csv` + a sane
//      `Content-Disposition` attachment filename.
//
// Errors surface as redirects to `/ops/reports/runs?error=...`
// (consistent with the rest of the operator console) for cases
// the operator can act on (no archive, run not found, archive
// unavailable), and as 5xx pages for genuine server errors.

import { errors } from "@pharmax/platform-core";
import {
  getReportRunArchive,
  REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION,
  REPORT_RUN_ARCHIVE_NOT_FOUND,
} from "@pharmax/reporting";
import { NextResponse } from "next/server";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../../src/server/logger.js";
import { withSentryOpsScope } from "../../../../../../../src/server/observability/ops-scope.js";
import { getReportRunForDownload } from "../../../../../../../src/server/ops/list-report-runs.js";
import { PERMISSIONS } from "@pharmax/rbac";

export const dynamic = "force-dynamic";

function redirectWithError(message: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/ops/reports/runs?error=${encodeURIComponent(message)}`, "http://internal").toString(),
    { status: 303 }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportRunId: string }> }
): Promise<Response> {
  const { reportRunId } = await params;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.REPORTS_RUN)) {
    return redirectWithError("Your role does not include reports.run.");
  }

  return withSentryOpsScope(
    {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      operatorDisplayName: session.operator.displayName,
      clerkUserId: session.operator.clerkUserId,
      commandName: "DownloadReportRunCsv",
      route: "ops:reports:runs:download",
    },
    async () => {
      const descriptor = await getReportRunForDownload({
        tenancy: session.tenancy,
        reportRunId,
      });
      if (descriptor === null) {
        return redirectWithError(
          "Report run was not archived. Older runs may not have a stored CSV."
        );
      }

      const archive = getReportRunArchive();
      if (archive === null) {
        logger.warn("ops.report_run.download.no_archive", {
          reportRunId,
          operatorUserId: session.operator.userId,
        });
        return redirectWithError("CSV archive is not configured in this environment.");
      }

      try {
        const got = await archive.get({
          organizationId: session.tenancy.organizationId,
          reportRunId,
          bucket: descriptor.csvObjectBucket,
          key: descriptor.csvObjectKey,
        });

        // Compose a friendly filename. The window dates make the
        // filename self-describing for an operator who downloads
        // multiple runs of the same report.
        const filename = composeFilename(descriptor);

        // Node 22 `Response` rejects a generic `Uint8Array` in some
        // strict-libcheck modes — wrap as a Buffer so the BodyInit
        // overload selection is unambiguous (Buffer extends Uint8Array
        // and is accepted as ArrayBufferView by the DOM types).
        const body = Buffer.from(got.csv);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": got.contentType,
            "Content-Length": String(body.byteLength),
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, no-store",
            "X-Pharmax-Report-Run-Id": descriptor.id,
          },
        });
      } catch (cause) {
        const code =
          cause instanceof errors.PharmaxError ? cause.code : "REPORT_RUN_DOWNLOAD_FAILED";
        logger.error("ops.report_run.download.fail", {
          operatorUserId: session.operator.userId,
          reportRunId,
          code,
          error: cause,
        });
        if (code === REPORT_RUN_ARCHIVE_NOT_FOUND) {
          return redirectWithError(
            "The CSV for this run is missing from the archive (the row exists but the object is gone)."
          );
        }
        if (code === REPORT_RUN_ARCHIVE_INTEGRITY_VIOLATION) {
          return redirectWithError(
            "The CSV failed an integrity check and was not served. Contact ops."
          );
        }
        return redirectWithError(
          "Unable to retrieve the CSV. The archive may be temporarily unavailable."
        );
      }
    }
  );
}

function composeFilename(d: {
  readonly reportId: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
}): string {
  const fromStr = d.windowFrom.toISOString().slice(0, 10);
  const toStr = d.windowTo.toISOString().slice(0, 10);
  // Escape any double-quotes in the reportId before stuffing into
  // Content-Disposition. The registry guarantees a safe shape
  // (lowercase + hyphens) but defense in depth keeps the header
  // parseable if a future report id includes weird chars.
  const safe = d.reportId.replace(/"/g, "_");
  return `${safe}__${fromStr}_to_${toStr}.csv`;
}
