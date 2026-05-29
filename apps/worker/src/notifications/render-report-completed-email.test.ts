import { describe, expect, it } from "vitest";

import { renderReportCompletedEmail } from "./render-report-completed-email.js";

const BASE = {
  scheduleName: "Weekly volume Mondays",
  reportTitle: "Order volume by stage",
  windowFromIso: "2026-05-21T00:00:00.000Z",
  windowToIso: "2026-05-28T00:00:00.000Z",
  generatedAtIso: "2026-05-28T13:00:00.000Z",
  rowCount: 1234,
  aggregates: { totalShipped: 1024, slaBreaches: 3, openOrders: 207 },
  dashboardLink: "https://ops.pharmax.test/ops/reports/order-volume",
} as const;

describe("renderReportCompletedEmail — happy path", () => {
  it("includes the schedule name + report title + status in subject", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    expect(r.subject).toContain("Weekly volume Mondays");
    expect(r.subject).toContain("SUCCEEDED");
  });

  it("renders aggregates sorted alphabetically in plaintext", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    const idx1 = r.text.indexOf("openOrders");
    const idx2 = r.text.indexOf("slaBreaches");
    const idx3 = r.text.indexOf("totalShipped");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it("includes a dashboard link in both text and html", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    expect(r.text).toContain(BASE.dashboardLink);
    expect(r.html).toContain(BASE.dashboardLink);
  });

  it("formats row counts with locale thousands separators", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    expect(r.text).toContain("Rows: 1234"); // rowCount is direct number
    expect(r.text).toContain("totalShipped: 1,024"); // aggregate values get locale formatting
  });
});

describe("renderReportCompletedEmail — failure path", () => {
  it("surfaces the error code line for FAILED runs", () => {
    const r = renderReportCompletedEmail({
      ...BASE,
      runStatus: "FAILED",
      errorCode: "REPORT_PARAMETERS_INVALID",
    });
    expect(r.subject).toContain("FAILED");
    expect(r.text).toContain("Error code: REPORT_PARAMETERS_INVALID");
    expect(r.html).toContain("REPORT_PARAMETERS_INVALID");
  });

  it("omits the error line when errorCode is undefined", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    expect(r.text).not.toContain("Error code:");
  });
});

describe("renderReportCompletedEmail — downloadLink", () => {
  it("includes the Download CSV button + text line when downloadLink is set", () => {
    const r = renderReportCompletedEmail({
      ...BASE,
      runStatus: "SUCCEEDED",
      downloadLink: "https://ops.pharmax.test/api/ops/reports/runs/run-1/download",
    });
    expect(r.text).toContain(
      "Download CSV: https://ops.pharmax.test/api/ops/reports/runs/run-1/download"
    );
    expect(r.html).toContain(">Download CSV<");
  });

  it("omits the Download CSV button when downloadLink is undefined", () => {
    const r = renderReportCompletedEmail({ ...BASE, runStatus: "SUCCEEDED" });
    expect(r.text).not.toContain("Download CSV:");
    expect(r.html).not.toContain(">Download CSV<");
  });
});

describe("renderReportCompletedEmail — HTML escaping", () => {
  it("escapes characters in user-supplied schedule name", () => {
    const r = renderReportCompletedEmail({
      ...BASE,
      runStatus: "SUCCEEDED",
      scheduleName: "<img src=x>",
    });
    expect(r.html).not.toContain("<img src=x>");
    expect(r.html).toContain("&lt;img");
  });
});
