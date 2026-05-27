// CSV serializer.
//
// Trivial implementation tuned for operator-facing exports:
//
//   - Header row from the first object's keys (callers should
//     normalize row shape before serializing).
//   - Field escaping per RFC 4180 — wrap in double quotes when the
//     value contains a comma, double quote, or newline; double up
//     internal quotes.
//   - `Date` → ISO-8601 UTC string.
//   - `null` / `undefined` → empty cell.
//   - `number` / `boolean` → string-cast.
//   - Anything else → `JSON.stringify` (then escaped as text).
//
// Why hand-rolled instead of `csv-stringify` etc:
//
//   - Zero new dependencies. The format is small enough that a
//     correct implementation fits in <50 lines.
//   - Predictable behavior; the heavy-lifting csv libraries differ
//     on edge cases (BOM, header inference, newline conventions).
//
// PHI invariant: this module is content-agnostic. Reports MUST
// project to non-PHI columns BEFORE serializing — there's no
// downstream check. Reviewers should reject any report whose
// row type carries a PHI-encrypted column.

const FIELDS_NEEDING_QUOTES = /["\n,]/;

function escapeCsvField(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw.toISOString();
  const value =
    typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
      ? String(raw)
      : JSON.stringify(raw);
  if (!FIELDS_NEEDING_QUOTES.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialize a row array to CSV. Returns an empty string for an
 * empty input (no header — there are no columns to advertise).
 *
 * `columns` lets the caller pin the column order + restrict the
 * projection (defense against accidentally including non-public
 * fields). When omitted, the first row's keys define the order.
 */
export function toCsv<TRow extends object>(
  rows: ReadonlyArray<TRow>,
  columns?: ReadonlyArray<string>
): string {
  if (rows.length === 0) return "";
  const firstRow = rows[0]!;
  const cols = columns ?? Object.keys(firstRow);
  const header = cols.map(escapeCsvField).join(",");
  const body = rows.map((row) =>
    cols.map((col) => escapeCsvField((row as Record<string, unknown>)[col])).join(",")
  );
  return [header, ...body].join("\n");
}
