// Focused unit coverage for the COMPLIANCE_NOTICE_V1 renderer —
// subject shape, severity badge, body embedding, evidence link,
// and HTML escaping. No channel or SDK in scope by design.

import { describe, expect, it } from "vitest";

import {
  renderComplianceNoticeEmail,
  type ComplianceNoticeRenderInput,
} from "./render-compliance-notice-email.js";

function buildInput(overrides?: Partial<ComplianceNoticeRenderInput>): ComplianceNoticeRenderInput {
  return {
    noticeKind: "access-review.ready",
    organizationId: "org_acme",
    subject: "Q2 2026 access review ready for acme",
    body: "Walk the evidence pack.\nAnomalies: 0",
    severity: "info",
    evidenceUri: "s3://audit-archive/access-reviews/2026-Q2/org_acme.md",
    ...overrides,
  };
}

describe("renderComplianceNoticeEmail — subject", () => {
  it("prefixes with [Pharmax compliance] and the severity badge", () => {
    const rendered = renderComplianceNoticeEmail(buildInput());
    expect(rendered.subject).toBe(
      "[Pharmax compliance] INFO · Q2 2026 access review ready for acme"
    );
  });

  it("badges warning and critical severities", () => {
    expect(renderComplianceNoticeEmail(buildInput({ severity: "warning" })).subject).toContain(
      " WARNING · "
    );
    expect(renderComplianceNoticeEmail(buildInput({ severity: "critical" })).subject).toContain(
      " CRITICAL · "
    );
  });
});

describe("renderComplianceNoticeEmail — text part", () => {
  it("embeds the body verbatim plus kind, org, and evidence trailer", () => {
    const rendered = renderComplianceNoticeEmail(buildInput());
    expect(rendered.text).toBe(
      "Walk the evidence pack.\nAnomalies: 0\n" +
        "\n" +
        "Notice kind: access-review.ready\n" +
        "Organization: org_acme\n" +
        "Evidence: s3://audit-archive/access-reviews/2026-Q2/org_acme.md\n"
    );
  });

  it("omits the evidence line when no evidenceUri is given", () => {
    const { evidenceUri: _dropped, ...withoutEvidence } = buildInput();
    const rendered = renderComplianceNoticeEmail(withoutEvidence);
    expect(rendered.text).not.toContain("Evidence:");
    expect(rendered.text.endsWith("Organization: org_acme\n")).toBe(true);
  });

  it("does not double a trailing newline already present in the body", () => {
    const rendered = renderComplianceNoticeEmail(buildInput({ body: "Body with newline.\n" }));
    expect(rendered.text.startsWith("Body with newline.\n\nNotice kind:")).toBe(true);
  });
});

describe("renderComplianceNoticeEmail — html part", () => {
  it("embeds subject, kind, org, body, badge, and evidence link", () => {
    const rendered = renderComplianceNoticeEmail(buildInput());
    expect(rendered.html).toContain("Q2 2026 access review ready for acme");
    expect(rendered.html).toContain("access-review.ready");
    expect(rendered.html).toContain("org_acme");
    expect(rendered.html).toContain("Walk the evidence pack.");
    expect(rendered.html).toContain(">INFO<");
    expect(rendered.html).toContain('href="s3://audit-archive/access-reviews/2026-Q2/org_acme.md"');
  });

  it("omits the evidence anchor when no evidenceUri is given", () => {
    const { evidenceUri: _dropped, ...withoutEvidence } = buildInput();
    const rendered = renderComplianceNoticeEmail(withoutEvidence);
    expect(rendered.html).not.toContain("<a href=");
  });

  it("HTML-escapes body and subject content", () => {
    const rendered = renderComplianceNoticeEmail(
      buildInput({
        subject: 'Review <urgent> & "signed"',
        body: "count < 5 && flag > 0",
      })
    );
    expect(rendered.html).toContain("Review &lt;urgent&gt; &amp; &quot;signed&quot;");
    expect(rendered.html).toContain("count &lt; 5 &amp;&amp; flag &gt; 0");
    expect(rendered.html).not.toContain("<urgent>");
  });
});
