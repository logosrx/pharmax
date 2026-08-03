// Minimal GitHub-flavoured-markdown table reader.
//
// Shared by the controls-inventory and TSC-mapping parsers. Extracted
// because both files use the same table dialect and a second
// hand-rolled row splitter would be the place the two silently
// disagree about escaped pipes.
//
// Deliberately strict: a row whose cell count does not match the
// header throws instead of being padded, truncated, or skipped. These
// parsers seed the control catalog, so a quietly dropped row means a
// control that exists in the auditor's document and not in the system
// that claims to be monitoring it — the precise failure this whole
// module exists to prevent.

/** One parsed table: its header labels and its data rows. */
export interface MarkdownTable {
  readonly headers: readonly string[];
  /** Each row is a cell array positionally aligned with `headers`. */
  readonly rows: readonly (readonly string[])[];
  /** 1-based line number of the header row, for error messages. */
  readonly headerLine: number;
}

export const MARKDOWN_TABLE_RAGGED_ROW = "MARKDOWN_TABLE_RAGGED_ROW";

/**
 * True for the `| --- | :-- |` delimiter row that separates a GFM
 * table header from its body.
 */
function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/**
 * Split one `| a | b |` line into trimmed cells.
 *
 * Handles `\|` escapes, which appear in these documents inside code
 * spans. Splitting on a bare `/\|/` would silently produce an extra
 * cell and, because the row is then ragged, abort the seed.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  // Drop the leading and trailing pipe before splitting so an empty
  // first/last cell is not manufactured.
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Extract every table in `markdown`, along with the most recent
 * heading above each one.
 *
 * The heading is returned because in both source documents the
 * section heading carries meaning the table itself does not: the
 * inventory's `## Additional Criteria — Availability` is the only
 * place the criterion CATEGORY appears.
 */
export interface MarkdownTableWithHeading extends MarkdownTable {
  /** Nearest preceding heading text, `null` before the first one. */
  readonly heading: string | null;
  /** Heading depth (2 for `##`), or 0 when there is no heading. */
  readonly headingLevel: number;
}

export function parseMarkdownTables(markdown: string): readonly MarkdownTableWithHeading[] {
  const lines = markdown.split("\n");
  const tables: MarkdownTableWithHeading[] = [];

  let heading: string | null = null;
  let headingLevel = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch !== null) {
      headingLevel = headingMatch[1]?.length ?? 0;
      heading = (headingMatch[2] ?? "").trim();
      index += 1;
      continue;
    }

    // A table starts at a pipe row whose successor is a delimiter row.
    const isPipeRow = line.trim().startsWith("|");
    const nextLine = lines[index + 1] ?? "";
    if (!isPipeRow || !nextLine.trim().startsWith("|")) {
      index += 1;
      continue;
    }
    const headers = splitRow(line);
    if (!isDelimiterRow(splitRow(nextLine))) {
      index += 1;
      continue;
    }

    const headerLine = index + 1;
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().startsWith("|")) {
      const cells = splitRow(lines[cursor] ?? "");
      if (cells.length !== headers.length) {
        throw new Error(
          `${MARKDOWN_TABLE_RAGGED_ROW}: line ${cursor + 1} has ${cells.length} cells but the ` +
            `header at line ${headerLine} has ${headers.length}. Refusing to guess which ` +
            `column is missing — fix the table.`
        );
      }
      rows.push(cells);
      cursor += 1;
    }

    tables.push({ headers, rows, headerLine, heading, headingLevel });
    index = cursor;
  }

  return tables;
}

/**
 * Resolve a header label to its column index, throwing when absent.
 * Callers address cells by name so a reordered column in the source
 * document cannot shift every field by one.
 */
export function columnIndex(table: MarkdownTable, label: string): number {
  const index = table.headers.findIndex((header) => header.toLowerCase() === label.toLowerCase());
  if (index === -1) {
    throw new Error(
      `Table at line ${table.headerLine} has no "${label}" column ` +
        `(found: ${table.headers.join(", ")}).`
    );
  }
  return index;
}
