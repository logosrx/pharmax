import { describe, expect, it } from "vitest";

import { toPdf, type ReportPdfInput } from "./pdf.js";

function decode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function baseInput(overrides: Partial<ReportPdfInput> = {}): ReportPdfInput {
  return {
    title: "Late deliveries",
    subtitle: "Shipments that missed the carrier estimate.",
    windowFrom: new Date("2026-07-01T00:00:00.000Z"),
    windowTo: new Date("2026-07-31T23:59:59.999Z"),
    generatedAt: new Date("2026-08-01T10:00:00.000Z"),
    aggregates: { totalCount: 2, deliveredLateCount: 1, stillOutstandingCount: 1 },
    rows: [
      {
        carrier: "FEDEX",
        trackingNumber: "794665654567",
        hoursLate: 12.5,
        outcome: "DELIVERED_LATE",
      },
      {
        carrier: "FEDEX",
        trackingNumber: "794665654568",
        hoursLate: 48,
        outcome: "STILL_OUTSTANDING",
      },
    ],
    footerNote: "Pharmax report run 01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ...overrides,
  };
}

function pageCount(doc: string): number {
  return (doc.match(/\/Type \/Page[^s]/g) ?? []).length;
}

describe("toPdf — document structure", () => {
  it("produces a structurally valid PDF (header, xref, trailer, EOF)", () => {
    const doc = decode(toPdf(baseInput()));
    expect(doc.startsWith("%PDF-1.4\n")).toBe(true);
    expect(doc).toContain("/Type /Catalog");
    expect(doc).toContain("/BaseFont /Helvetica");
    expect(doc).toContain("xref");
    expect(doc.trimEnd().endsWith("%%EOF")).toBe(true);

    // startxref must point at the literal `xref` keyword — byte-
    // offset bookkeeping is the easiest thing to break in a
    // hand-rolled writer.
    const startxref = Number(/startxref\n(\d+)\n/.exec(doc)![1]);
    expect(doc.slice(startxref, startxref + 4)).toBe("xref");

    // Every recorded object offset must point at its own "N 0 obj".
    const entries = [...doc.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    for (const off of entries) {
      expect(/^\d+ 0 obj/.test(doc.slice(off, off + 20))).toBe(true);
    }
  });

  it("renders title, window, aggregates, rows, and footer as page text", () => {
    const doc = decode(toPdf(baseInput()));
    expect(doc).toContain("(Late deliveries)");
    expect(doc).toContain("Window 2026-07-01 to 2026-07-31");
    expect(doc).toContain("totalCount: 2");
    expect(doc).toContain("794665654567");
    expect(doc).toContain("DELIVERED_LATE");
    expect(doc).toContain("Pharmax report run 01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(doc).toContain("(Page 1 of 1)");
  });

  it("escapes PDF-delimiter characters and sanitizes non-ASCII", () => {
    const doc = decode(
      toPdf(
        baseInput({
          rows: [{ note: "paren (danger) \\ backslash", city: "Zürich" }],
          columns: ["note", "city"],
        })
      )
    );
    expect(doc).toContain("paren \\(danger\\) \\\\ backslash");
    expect(doc).toContain("Z?rich"); // non-ASCII replaced, never raw bytes
  });

  it("paginates large row sets and repeats the column header per page", () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      carrier: "FEDEX",
      trackingNumber: `79466565${String(i).padStart(4, "0")}`,
      hoursLate: i,
    }));
    const doc = decode(toPdf(baseInput({ rows })));
    const pages = pageCount(doc);
    expect(pages).toBeGreaterThan(2);
    expect(doc).toContain(`(Page ${pages} of ${pages})`);
    // The bold column-header row renders once per page.
    const headerOccurrences = (doc.match(/\/F2 7\.5 Tf [\d. ]+Tm \(trackingNumber\)/g) ?? [])
      .length;
    expect(headerOccurrences).toBe(pages);
    // Last row made it onto the final page.
    expect(doc).toContain("794665650149");
  });

  it("renders an empty-window document without throwing", () => {
    const doc = decode(toPdf(baseInput({ rows: [], aggregates: {} })));
    expect(doc).toContain("(No rows in this window.)");
    expect(pageCount(doc)).toBe(1);
  });

  it("respects a pinned column projection", () => {
    const doc = decode(
      toPdf(
        baseInput({
          rows: [{ visible: "yes", hidden: "MUST-NOT-APPEAR" }],
          columns: ["visible"],
        })
      )
    );
    expect(doc).toContain("(yes)");
    expect(doc).not.toContain("MUST-NOT-APPEAR");
  });
});
