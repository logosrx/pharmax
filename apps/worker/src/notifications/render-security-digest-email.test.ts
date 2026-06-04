import { describe, expect, it } from "vitest";

import { renderSecurityDigestEmail } from "./render-security-digest-email.js";

const BASE_CLEAN = {
  generatedAtIso: "2026-06-02T06:30:00.000Z",
  windowFromIso: "2026-06-01T06:30:00.000Z",
  windowToIso: "2026-06-02T06:30:00.000Z",
  digestText:
    "Pharmax Nightly Security Digest\nWindow: 2026-06-01T06:30:00.000Z → 2026-06-02T06:30:00.000Z\n" +
    "Generated: 2026-06-02T06:30:00.000Z\n\n" +
    "-- Audit chain integrity (3 orgs) --\n" +
    "  All chains verified clean.\n",
  auditOrgCount: 3,
  brokenChainCount: 0,
  breakGlassCount: 0,
  outboxDeadCount: 0,
} as const;

const BASE_ATTENTION = {
  ...BASE_CLEAN,
  brokenChainCount: 1,
  breakGlassCount: 2,
  outboxDeadCount: 0,
} as const;

describe("renderSecurityDigestEmail — subject line", () => {
  it("uses CLEAN status badge when all scalar counts are zero", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.subject).toContain("[Pharmax security] CLEAN");
  });

  it("uses ATTENTION badge when ANY of brokenChainCount/breakGlassCount/outboxDeadCount is non-zero", () => {
    expect(renderSecurityDigestEmail({ ...BASE_CLEAN, brokenChainCount: 1 }).subject).toContain(
      "ATTENTION"
    );
    expect(renderSecurityDigestEmail({ ...BASE_CLEAN, breakGlassCount: 1 }).subject).toContain(
      "ATTENTION"
    );
    expect(renderSecurityDigestEmail({ ...BASE_CLEAN, outboxDeadCount: 1 }).subject).toContain(
      "ATTENTION"
    );
  });

  it("does NOT escalate to ATTENTION on auditOrgCount alone (high org count is healthy, not a signal)", () => {
    const r = renderSecurityDigestEmail({ ...BASE_CLEAN, auditOrgCount: 500 });
    expect(r.subject).toContain("CLEAN");
  });

  it("embeds the UTC calendar date so inbox sorting is by day", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.subject).toContain("2026-06-02");
  });

  it("embeds the four scalar counts for at-a-glance triage from the preview pane", () => {
    const r = renderSecurityDigestEmail(BASE_ATTENTION);
    expect(r.subject).toContain("3 orgs");
    expect(r.subject).toContain("1 broken chains");
    expect(r.subject).toContain("2 break-glass");
    expect(r.subject).toContain("0 dead-outbox orgs");
  });

  it("falls back to the raw ISO string when generatedAtIso is unparseable", () => {
    const r = renderSecurityDigestEmail({ ...BASE_CLEAN, generatedAtIso: "not-an-iso" });
    expect(r.subject).toContain("not-an-iso");
  });
});

describe("renderSecurityDigestEmail — body", () => {
  it("embeds the digestText verbatim in the plaintext part", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.text).toContain("Pharmax Nightly Security Digest");
    expect(r.text).toContain("All chains verified clean.");
  });

  it("ensures the plaintext part ends with a single newline (RFC convention)", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.text.endsWith("\n")).toBe(true);
    expect(r.text.endsWith("\n\n")).toBe(false);
  });

  it("preserves a trailing newline when digestText already includes one (does not double it)", () => {
    const r = renderSecurityDigestEmail({ ...BASE_CLEAN, digestText: "body\n" });
    expect(r.text).toBe("body\n");
  });

  it("renders both window timestamps in the HTML header", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.html).toContain("2026-06-01T06:30:00.000Z");
    expect(r.html).toContain("2026-06-02T06:30:00.000Z");
  });

  it("renders the digestText inside a <pre> block in the HTML part", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(r.html).toMatch(/<pre[^>]*>[\s\S]*All chains verified clean\.[\s\S]*<\/pre>/);
  });

  it("HTML-escapes content embedded in the body (defense-in-depth even though the digest is operator-controlled)", () => {
    const r = renderSecurityDigestEmail({
      ...BASE_CLEAN,
      digestText: '  reason="<script>alert(1)</script>"\n',
    });
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).not.toContain("<script>alert(1)</script>");
  });

  it("renders each scalar with its descriptive label in the HTML dl block", () => {
    const r = renderSecurityDigestEmail(BASE_ATTENTION);
    expect(r.html).toContain("Audit orgs verified");
    expect(r.html).toContain("Broken chains");
    expect(r.html).toContain("Break-glass sessions opened");
    expect(r.html).toContain("Orgs with dead outbox rows");
  });
});

describe("renderSecurityDigestEmail — return shape", () => {
  it("returns a frozen object", () => {
    const r = renderSecurityDigestEmail(BASE_CLEAN);
    expect(Object.isFrozen(r)).toBe(true);
  });
});
