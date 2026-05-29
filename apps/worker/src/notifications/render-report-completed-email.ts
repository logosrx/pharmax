// Render a `REPORT_RUN_COMPLETED_V1` notification context into the
// subject + plain-text + HTML payload Resend (or any email adapter)
// needs.
//
// Renderer kept SEPARATE from the channel adapter so:
//   - The HTML/text strings have their own focused unit tests
//     without needing a fake Resend SDK.
//   - A future template-versioned bump (REPORT_RUN_COMPLETED_V2)
//     can ship a sibling renderer without touching the adapter.
//   - In-app / Slack notifications can render the SAME context
//     into their own surface (markdown blocks, etc.) by writing
//     a sibling renderer.
//
// PHI invariant: the renderer receives a `context` already
// PHI-guarded by `assertNoPhiInContext` at the channel boundary.
// We DO NOT re-decode or re-format any field that could carry PHI.
// The aggregates Record is `Record<string, number>` — scalars
// only by the report's contract.

export interface ReportCompletedRenderInput {
  /** Schedule display name from the operator. */
  readonly scheduleName: string;
  /** Report title from the registry. */
  readonly reportTitle: string;
  /** Run outcome — drives subject prefix + color. */
  readonly runStatus: "SUCCEEDED" | "FAILED" | "SKIPPED";
  /** ISO timestamps the report covered. */
  readonly windowFromIso: string;
  readonly windowToIso: string;
  /** When the run produced its result set. */
  readonly generatedAtIso: string;
  /** Number of result rows. */
  readonly rowCount: number;
  /**
   * Scalar aggregates surfaced by the report. PHI-free by the
   * report's contract (Record<string, number>). The renderer
   * sorts entries alphabetically for stable email output.
   */
  readonly aggregates: Readonly<Record<string, number>>;
  /** Deep-link back to a re-run UI. Full absolute URL. */
  readonly dashboardLink: string;
  /** Optional direct CSV download URL. Present when the run
   *  persisted its CSV to the archive (always true for scheduled
   *  SUCCEEDED runs in production; absent for FAILED/SKIPPED runs
   *  where there's no row set to download). */
  readonly downloadLink?: string;
  /** Optional typed error code when runStatus is FAILED/SKIPPED. */
  readonly errorCode?: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderReportCompletedEmail(input: ReportCompletedRenderInput): RenderedEmail {
  const statusBadge = statusEmoji(input.runStatus);
  const subject = `[Pharmax] ${statusBadge} ${input.scheduleName} — ${input.runStatus}`;

  const aggregatesLines = renderAggregates(input.aggregates);
  const windowLabel = `${input.windowFromIso} → ${input.windowToIso}`;

  const errorLine = input.errorCode !== undefined ? `Error code: ${input.errorCode}\n` : "";

  const text = [
    `${input.scheduleName}`,
    `Report: ${input.reportTitle}`,
    `Status: ${input.runStatus}`,
    `Window: ${windowLabel}`,
    `Generated at: ${input.generatedAtIso}`,
    `Rows: ${input.rowCount}`,
    errorLine,
    aggregatesLines.length > 0 ? "Aggregates:" : "",
    ...aggregatesLines.map((l) => `  ${l}`),
    "",
    input.downloadLink !== undefined ? `Download CSV: ${input.downloadLink}` : "",
    `Re-run from dashboard: ${input.dashboardLink}`,
    "",
    "—",
    "You are receiving this because the schedule's recipient list includes your address.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const aggregatesHtml =
    aggregatesLines.length > 0
      ? `<dl style="margin:8px 0 0;padding:0">${aggregatesLines
          .map((line) => {
            const [k, v] = line.split(": ");
            return `<div style="display:flex;gap:12px;margin:2px 0"><dt style="min-width:240px;color:#525252">${escapeHtml(k ?? "")}</dt><dd style="margin:0;font-variant-numeric:tabular-nums">${escapeHtml(v ?? "")}</dd></div>`;
          })
          .join("")}</dl>`
      : "";

  const statusColor = statusHexColor(input.runStatus);
  const errorBlock =
    input.errorCode !== undefined
      ? `<p style="margin:8px 0 0;color:#9f1239"><strong>Error code:</strong> <code>${escapeHtml(input.errorCode)}</code></p>`
      : "";

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;color:#0a0a0a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px">
    <div style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${statusColor.bg};color:${statusColor.fg};border:1px solid ${statusColor.border}">${escapeHtml(input.runStatus)}</div>
    <h1 style="margin:12px 0 4px;font-size:20px">${escapeHtml(input.scheduleName)}</h1>
    <p style="margin:0;color:#525252;font-size:14px">${escapeHtml(input.reportTitle)}</p>
    ${errorBlock}
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0" />
    <div style="font-size:14px;line-height:1.6">
      <div><strong>Window:</strong> <code style="font-size:12px">${escapeHtml(windowLabel)}</code></div>
      <div><strong>Generated at:</strong> <code style="font-size:12px">${escapeHtml(input.generatedAtIso)}</code></div>
      <div><strong>Rows:</strong> <span style="font-variant-numeric:tabular-nums">${input.rowCount}</span></div>
    </div>
    ${aggregatesHtml}
    <p style="margin:24px 0 0;display:flex;gap:8px;flex-wrap:wrap">
      ${
        input.downloadLink !== undefined
          ? `<a href="${escapeHtml(input.downloadLink)}" style="display:inline-block;padding:10px 16px;background:#0a0a0a;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Download CSV</a>`
          : ""
      }
      <a href="${escapeHtml(input.dashboardLink)}" style="display:inline-block;padding:10px 16px;background:#fff;color:#0a0a0a;border:1px solid #d4d4d4;border-radius:6px;text-decoration:none;font-weight:500">Re-run in Pharmax</a>
    </p>
    <p style="margin:24px 0 0;color:#737373;font-size:12px">You are receiving this because the schedule's recipient list includes your address.</p>
  </div>
</body></html>`;

  return Object.freeze({ subject, text, html });
}

function statusEmoji(status: ReportCompletedRenderInput["runStatus"]): string {
  switch (status) {
    case "SUCCEEDED":
      return "✓";
    case "FAILED":
      return "✗";
    case "SKIPPED":
      return "⚠";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown status: ${String(exhaustive)}`);
    }
  }
}

function statusHexColor(status: ReportCompletedRenderInput["runStatus"]): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (status) {
    case "SUCCEEDED":
      return { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" };
    case "FAILED":
      return { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" };
    case "SKIPPED":
      return { bg: "#fffbeb", fg: "#92400e", border: "#fde68a" };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown status: ${String(exhaustive)}`);
    }
  }
}

function renderAggregates(agg: Readonly<Record<string, number>>): string[] {
  return Object.keys(agg)
    .sort()
    .map((k) => `${k}: ${formatNumber(agg[k] ?? 0)}`);
}

function formatNumber(n: number): string {
  if (Number.isFinite(n)) {
    return n.toLocaleString("en-US");
  }
  return String(n);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
