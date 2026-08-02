// POST /api/ops/reports/:reportId/run
//
// Operator dispatches `RunReport` with parameters from the form,
// then streams the result as CSV in the response body. The
// audit + report_run row are written by the command; we only
// own the CSV serialization here.
//
// Unlike the other operator routes, this one does NOT use
// `dispatchOpsCommand` because the success path returns a CSV
// body, not a redirect. We replicate the session resolution +
// tenancy build + Sentry scope manually so the wiring stays
// consistent with the rest of the operator surface.

import { executeCommand, fingerprintRequest } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import {
  dateRangeFields,
  paramSourceFromFormData,
  paramSourceFromRecord,
  parseReportParameters,
  REPORT_REGISTRY,
  RunReport,
  toCsv,
  toPdf,
} from "@pharmax/reporting";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";
import { withSentryOpsScope } from "../../../../../../src/server/observability/ops-scope.js";

interface RouteParams {
  readonly params: Promise<{ readonly reportId: string }>;
}

function redirectWithError(reportId: string, message: string): Response {
  const url = new URL(
    `/ops/reports/${reportId}?error=${encodeURIComponent(message)}`,
    "http://internal"
  );
  return NextResponse.redirect(url.toString(), { status: 303 });
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { reportId } = await context.params;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  // Resolve the report's declarative field descriptor (fallback
  // to the standard from/to pair for reports that predate it),
  // then coerce the submitted form into the typed parameter shape.
  // The report's own Zod schema is the validation authority —
  // `RunReport` re-parses this object and surfaces
  // REPORT_PARAMETERS_INVALID on any mismatch (e.g. from > to).
  const definition = REPORT_REGISTRY[reportId];
  if (definition === undefined) {
    return redirectWithError(reportId, `No report registered with id "${reportId}".`);
  }
  const fields = definition.parameterFields ?? dateRangeFields();

  // Parse form body. The `format` key selects the download
  // serialization (csv default | pdf) and is read OUTSIDE
  // `parseReportParameters` — it is transport chrome, not a report
  // parameter, so it never reaches the report's Zod schema.
  const contentType = request.headers.get("content-type") ?? "";
  let format: "csv" | "pdf" = "csv";
  let source;
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body["format"] === "pdf") format = "pdf";
    source = paramSourceFromRecord(body);
  } else {
    const formData = await request.formData();
    if (formData.get("format") === "pdf") format = "pdf";
    source = paramSourceFromFormData(formData);
  }

  const parsed = parseReportParameters(fields, source);
  if (!parsed.ok) {
    return redirectWithError(reportId, parsed.error);
  }
  const parameters = parsed.parameters;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  // Minute-bucketed idempotency, keyed by the PARSED PARAMETERS as
  // well as the report id. Two refreshes of the same form within a
  // minute return the same audit row + CSV; running the SAME report
  // with a DIFFERENT date range (or any other parameter change)
  // inside the same minute is a new key and executes normally —
  // without the fingerprint the second run collided with the first
  // and redirected with a payload-mismatch error instead of
  // downloading the CSV.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `route:run-report:${reportId}:${fingerprintRequest(parameters)}:${minuteBucket}`;

  return await withSentryOpsScope(
    {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      operatorDisplayName: session.operator.displayName,
      commandName: "RunReport",
      route: `route:run-report:${reportId}`,
    },
    async () => {
      try {
        const output = await withTenancyContext(tenancy, () =>
          executeCommand(
            RunReport,
            {
              reportId,
              parameters,
            },
            { idempotencyKey }
          )
        );

        // Stream the result in the requested serialization. We
        // serialize from `output.rows` directly — the command
        // returned the post-run row set + the report_run id was
        // persisted server-side. Headers:
        //   - format-appropriate content-type so browsers
        //     render-as-download
        //   - attachment disposition with a stable filename
        //     including the reportId + the windowFrom date so
        //     repeated downloads sort sensibly.
        //   - X-Pharmax-Report-Run-Id surfaces the audit row id
        //     in the response for support tickets / log
        //     correlation.
        const filenameBase = `${output.reportId}__${output.windowFrom.slice(0, 10)}_to_${output.windowTo.slice(0, 10)}`;
        logger.info("ops.reports.run.applied", {
          operatorUserId: session.operator.userId,
          reportId: output.reportId,
          reportRunId: output.reportRunId,
          rowCount: output.rowCount,
          format,
        });
        const commonHeaders = {
          "x-pharmax-report-run-id": output.reportRunId,
          "cache-control": "private, no-store",
        };
        if (format === "pdf") {
          // Printable / carrier-shareable artifact (e.g. the
          // late-deliveries evidence pack an operator sends to
          // FedEx). Same rows as the CSV path, same audit row.
          const pdf = toPdf({
            title: definition.title,
            subtitle: definition.description,
            windowFrom: new Date(output.windowFrom),
            windowTo: new Date(output.windowTo),
            generatedAt: new Date(output.generatedAt),
            aggregates: output.aggregates,
            rows: output.rows as ReadonlyArray<Record<string, unknown>>,
            footerNote: `Pharmax report run ${output.reportRunId}`,
          });
          return new Response(Buffer.from(pdf), {
            status: 200,
            headers: {
              ...commonHeaders,
              "content-type": "application/pdf",
              "content-disposition": `attachment; filename="${filenameBase}.pdf"`,
            },
          });
        }
        const csv = toCsv(output.rows as ReadonlyArray<Record<string, unknown>>);
        return new Response(csv, {
          status: 200,
          headers: {
            ...commonHeaders,
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filenameBase}.csv"`,
          },
        });
      } catch (cause) {
        const code = cause instanceof errors.PharmaxError ? cause.code : "OPS_DISPATCH_FAILED";
        const message =
          cause instanceof errors.PharmaxError ? cause.message : "Unable to run report.";
        logger.error("ops.reports.run.failed", {
          operatorUserId: session.operator.userId,
          reportId,
          code,
          error: cause,
        });
        return redirectWithError(reportId, `${code}: ${message}`);
      }
    }
  );
}
