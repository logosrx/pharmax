// PDF report renderer.
//
// Hand-rolled PDF 1.4 writer tuned for carrier-facing tabular report
// exports (e.g. the late-deliveries report an operator sends to
// FedEx for service-failure review). Same philosophy as `csv.ts`:
//
//   - Zero new dependencies. The subset of PDF we need — base-14
//     Helvetica text on US-Letter landscape pages — requires no font
//     embedding, no compression, and no external assets, so a
//     correct writer fits in one reviewable module. (The popular PDF
//     libraries ship font files that Next.js bundling mangles;
//     avoiding them removes that whole failure class.)
//   - Predictable output: uncompressed content streams mean the
//     document text is grep-able in tests and in support tickets.
//
// Layout: US-Letter LANDSCAPE (792x612pt — report tables are wide),
// title + window/aggregates header block on page 1, a column-header
// row repeated on every page, row grid, and a footer with page
// numbers + the report-run reference.
//
// Text encoding: sanitized to printable ASCII (0x20–0x7E); anything
// else becomes "?". Base-14 Helvetica with WinAnsi covers more, but
// ASCII-only keeps byte-offset bookkeeping trivially correct and our
// report content (ids, tracking numbers, enum labels, timestamps) is
// ASCII already.
//
// PHI invariant: content-agnostic, same as `toCsv` — reports MUST
// project to non-PHI columns before rendering.

// ---------------------------------------------------------------
// Geometry + typography constants
// ---------------------------------------------------------------

const PAGE_W = 792; // US-Letter landscape
const PAGE_H = 612;
const MARGIN = 36;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const TITLE_SIZE = 15;
const META_SIZE = 8;
const TABLE_SIZE = 7.5;
const ROW_H = 13;
const FOOTER_SIZE = 7;

/** Average Helvetica glyph width as a fraction of font size. A
 *  conservative estimate — real widths vary per glyph; using the
 *  average with truncation headroom keeps cells inside their
 *  columns without shipping AFM metrics. */
const CHAR_W = 0.52;

const MIN_COL_W = 42;
const MAX_COL_W = 230;

// ---------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------

function sanitize(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? ch : "?";
  }
  return out;
}

/** Escape for a PDF literal string: backslash, parens. */
function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function textWidth(value: string, size: number): number {
  return value.length * size * CHAR_W;
}

function truncateToWidth(value: string, width: number, size: number): string {
  const maxChars = Math.max(1, Math.floor(width / (size * CHAR_W)));
  if (value.length <= maxChars) return value;
  return maxChars <= 3 ? value.slice(0, maxChars) : `${value.slice(0, maxChars - 3)}...`;
}

function formatCell(raw: unknown): string {
  if (raw === null || raw === undefined) return "-";
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return JSON.stringify(raw);
}

function formatDateUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

// ---------------------------------------------------------------
// Content-stream builder (one per page)
// ---------------------------------------------------------------

class PageContent {
  private readonly ops: string[] = [];

  text(input: {
    x: number;
    y: number;
    size: number;
    value: string;
    bold?: boolean;
    gray?: boolean;
  }): void {
    const font = input.bold === true ? "/F2" : "/F1";
    const color = input.gray === true ? "0.45 0.45 0.45 rg" : "0 0 0 rg";
    this.ops.push(
      `BT ${color} ${font} ${input.size} Tf 1 0 0 1 ${input.x.toFixed(2)} ${input.y.toFixed(2)} Tm (${escapePdfText(sanitize(input.value))}) Tj ET`
    );
  }

  hline(y: number, x1: number = MARGIN, x2: number = PAGE_W - MARGIN): void {
    this.ops.push(`0.75 0.75 0.75 RG 0.5 w ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S`);
  }

  render(): string {
    return this.ops.join("\n");
  }
}

// ---------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------

/**
 * Assemble a PDF from per-page content streams. Handles object
 * numbering, byte-exact xref offsets, and the trailer. All content
 * is ASCII, so string length == byte length (latin1 write).
 */
function assemblePdf(pageContents: ReadonlyArray<string>): Uint8Array {
  const objects: string[] = [];

  const pageCount = pageContents.length;
  const pageObjNum = (i: number) => 5 + i * 2;
  const contentObjNum = (i: number) => 6 + i * 2;

  const kids = pageContents.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");

  // 1: Catalog, 2: Pages, 3: Helvetica, 4: Helvetica-Bold.
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  objects.push(
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`
  );
  objects.push(
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`
  );

  pageContents.forEach((content, i) => {
    objects.push(
      `${pageObjNum(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>\nendobj\n`
    );
    objects.push(
      `${contentObjNum(i)} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
    );
  });

  const header = "%PDF-1.4\n";
  let offset = header.length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(offset);
    offset += obj.length;
  }

  const xrefStart = offset;
  const objCount = objects.length + 1; // + the free object 0
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (const objOffset of offsets) {
    xref += `${objOffset.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const full = header + objects.join("") + xref + trailer;
  const bytes = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i += 1) {
    bytes[i] = full.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export interface ReportPdfInput {
  /** Operator-facing report title (from the report definition). */
  readonly title: string;
  /** One-line description rendered under the title. */
  readonly subtitle?: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly generatedAt: Date;
  readonly aggregates: Readonly<Record<string, number>>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /**
   * Pin column order / restrict the projection (same contract as
   * `toCsv`). Defaults to the first row's keys.
   */
  readonly columns?: ReadonlyArray<string>;
  /** Footer reference, e.g. `Pharmax report run <id>`. */
  readonly footerNote?: string;
}

/**
 * Render a report result to a printable PDF (US-Letter landscape).
 * Returns the raw document bytes; callers own the HTTP headers /
 * filesystem write.
 */
export function toPdf(input: ReportPdfInput): Uint8Array {
  const columns = input.columns ?? (input.rows[0] !== undefined ? Object.keys(input.rows[0]) : []);

  // ---- Column widths: proportional to observed content length,
  // clamped, then scaled to exactly fill the content width. Sample
  // the first 200 rows for the estimate — enough signal, bounded
  // cost on large exports.
  const sample = input.rows.slice(0, 200);
  const desired = columns.map((col) => {
    let maxChars = col.length;
    for (const row of sample) {
      const len = formatCell(row[col]).length;
      if (len > maxChars) maxChars = len;
    }
    return Math.min(Math.max(maxChars * TABLE_SIZE * CHAR_W + 6, MIN_COL_W), MAX_COL_W);
  });
  const desiredTotal = desired.reduce((sum, w) => sum + w, 0);
  const scale = desiredTotal === 0 ? 1 : CONTENT_W / desiredTotal;
  const widths = desired.map((w) => w * scale);
  const colX: number[] = [];
  let acc = MARGIN;
  for (const w of widths) {
    colX.push(acc);
    acc += w;
  }

  // ---- Paginate rows.
  const footerY = MARGIN;
  const tableBottom = footerY + 16;

  interface PageLayout {
    readonly firstPage: boolean;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
  }
  const pages: PageLayout[] = [];
  {
    let index = 0;
    let first = true;
    do {
      const headerBlockH = first
        ? 66 + 12 * Math.ceil(Object.keys(input.aggregates).length / 6)
        : 10;
      const tableTop = PAGE_H - MARGIN - headerBlockH;
      const usable = tableTop - ROW_H /* column header */ - tableBottom;
      const perPage = Math.max(1, Math.floor(usable / ROW_H));
      pages.push({ firstPage: first, rows: input.rows.slice(index, index + perPage) });
      index += perPage;
      first = false;
    } while (index < input.rows.length);
  }

  // ---- Render each page.
  const contents = pages.map((page, pageIndex) => {
    const c = new PageContent();
    let y = PAGE_H - MARGIN;

    if (page.firstPage) {
      y -= TITLE_SIZE;
      c.text({ x: MARGIN, y, size: TITLE_SIZE, value: input.title, bold: true });
      if (input.subtitle !== undefined && input.subtitle.length > 0) {
        y -= 12;
        c.text({
          x: MARGIN,
          y,
          size: META_SIZE,
          value: truncateToWidth(input.subtitle, CONTENT_W, META_SIZE),
          gray: true,
        });
      }
      y -= 13;
      c.text({
        x: MARGIN,
        y,
        size: META_SIZE,
        value:
          `Window ${input.windowFrom.toISOString().slice(0, 10)} to ${input.windowTo.toISOString().slice(0, 10)}` +
          ` | Generated ${formatDateUtc(input.generatedAt)} | ${input.rows.length} row${input.rows.length === 1 ? "" : "s"}`,
      });

      // Aggregates, six per line.
      const entries = Object.entries(input.aggregates);
      for (let i = 0; i < entries.length; i += 6) {
        y -= 12;
        c.text({
          x: MARGIN,
          y,
          size: META_SIZE,
          value: entries
            .slice(i, i + 6)
            .map(([k, v]) => `${k}: ${v}`)
            .join("   "),
          gray: true,
        });
      }
      y -= 16;
    } else {
      y -= 10;
    }

    // Column header row + underline.
    if (columns.length > 0) {
      y -= ROW_H;
      columns.forEach((col, i) => {
        c.text({
          x: colX[i]!,
          y,
          size: TABLE_SIZE,
          value: truncateToWidth(col, widths[i]! - 4, TABLE_SIZE),
          bold: true,
        });
      });
      c.hline(y - 3);
    }

    for (const row of page.rows) {
      y -= ROW_H;
      columns.forEach((col, i) => {
        c.text({
          x: colX[i]!,
          y,
          size: TABLE_SIZE,
          value: truncateToWidth(formatCell(row[col]), widths[i]! - 4, TABLE_SIZE),
        });
      });
    }

    if (columns.length === 0 && page.firstPage) {
      y -= ROW_H;
      c.text({ x: MARGIN, y, size: META_SIZE, value: "No rows in this window.", gray: true });
    }

    // Footer.
    if (input.footerNote !== undefined && input.footerNote.length > 0) {
      c.text({ x: MARGIN, y: footerY, size: FOOTER_SIZE, value: input.footerNote, gray: true });
    }
    const pageLabel = `Page ${pageIndex + 1} of ${pages.length}`;
    c.text({
      x: PAGE_W - MARGIN - textWidth(pageLabel, FOOTER_SIZE),
      y: footerY,
      size: FOOTER_SIZE,
      value: pageLabel,
      gray: true,
    });

    return c.render();
  });

  return assemblePdf(contents);
}
