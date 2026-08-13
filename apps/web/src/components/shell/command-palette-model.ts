// Pure ranking model for the command palette — kept free of client
// imports so the matching behaviour is unit-testable.

export interface PaletteEntry {
  readonly label: string;
  readonly group: string;
}

/**
 * Rank an entry against the query. 0 = no match; higher = better.
 * Every whitespace-separated token must land somewhere in the label
 * or group, so "rep sch" still finds "Report schedules".
 */
export function scoreEntry(entry: PaletteEntry, query: string): number {
  const label = entry.label.toLowerCase();
  const group = entry.group.toLowerCase();
  let total = 0;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (label.startsWith(token)) total += 3;
    else if (label.includes(` ${token}`)) total += 2;
    else if (label.includes(token)) total += 1.5;
    else if (group.includes(token)) total += 0.5;
    else return 0;
  }
  return total;
}

/** Rank + filter a command list, best match first (stable within ties). */
export function rankEntries<T extends PaletteEntry>(
  entries: ReadonlyArray<T>,
  query: string
): ReadonlyArray<T> {
  return entries
    .map((entry, index) => ({ entry, index, s: scoreEntry(entry, query) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map(({ entry }) => entry);
}
