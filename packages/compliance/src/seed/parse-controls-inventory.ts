// Parser for docs/soc2/controls-inventory.md.
//
// The markdown stays the human-editable source of truth — it is what
// the auditor reads and what the rest of docs/soc2 cross-references.
// This parser derives the database rows from it, so there is exactly
// one place a control's status is edited. Transcribing 60 controls
// into a TypeScript literal would create a second copy that drifts
// from the document on the first status flip.
//
// Every unrecognized value throws. A parser that skipped an unknown
// status would drop the control from the seeded catalog while leaving
// it in the auditor's document — the system would then report a clean
// control program that is missing exactly the rows nobody could
// classify.

import { columnIndex, parseMarkdownTables } from "./parse-markdown-table.js";

export const CONTROLS_INVENTORY_UNKNOWN_STATUS = "CONTROLS_INVENTORY_UNKNOWN_STATUS";
export const CONTROLS_INVENTORY_UNKNOWN_CADENCE = "CONTROLS_INVENTORY_UNKNOWN_CADENCE";
export const CONTROLS_INVENTORY_BAD_CONTROL_CODE = "CONTROLS_INVENTORY_BAD_CONTROL_CODE";
export const CONTROLS_INVENTORY_DUPLICATE_CODE = "CONTROLS_INVENTORY_DUPLICATE_CODE";
export const CONTROLS_INVENTORY_NO_CONTROLS = "CONTROLS_INVENTORY_NO_CONTROLS";

export type ParsedControlStatus =
  "IMPLEMENTED" | "PARTIAL" | "PLANNED" | "DEPRECATED" | "NOT_APPLICABLE";

export type ParsedCadence =
  | "CONTINUOUS"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUAL"
  | "ON_CHANGE"
  | "PER_EVENT";

export interface ParsedControl {
  /** Stable identifier, e.g. "CC6.1-2". */
  readonly code: string;
  /** Criterion this control is filed under, derived from `code`. */
  readonly criterionCode: string;
  /** Category from the section heading ("Common Criteria"). */
  readonly category: string;
  readonly title: string;
  readonly status: ParsedControlStatus;
  readonly ownerRole: string;
  /** The single cadence stored on the row — see `resolveCadence`. */
  readonly cadence: ParsedCadence;
  /** Cadence cell verbatim, e.g. "Continuous, daily". */
  readonly cadenceRaw: string;
  /** Notes cell verbatim (markdown), or null when empty. */
  readonly notes: string | null;
  /** Code paths and ADR ids mined out of the notes cell. */
  readonly implementationRefs: readonly string[];
}

const STATUS_BY_LABEL: ReadonlyMap<string, ParsedControlStatus> = new Map([
  ["implemented", "IMPLEMENTED"],
  ["partial", "PARTIAL"],
  ["planned", "PLANNED"],
  ["deprecated", "DEPRECATED"],
  ["n/a", "NOT_APPLICABLE"],
]);

const CADENCE_BY_LABEL: ReadonlyMap<string, ParsedCadence> = new Map([
  ["continuous", "CONTINUOUS"],
  ["daily", "DAILY"],
  ["weekly", "WEEKLY"],
  ["monthly", "MONTHLY"],
  ["quarterly", "QUARTERLY"],
  ["annual", "ANNUAL"],
  ["annually", "ANNUAL"],
  ["on-change", "ON_CHANGE"],
  ["per-event", "PER_EVENT"],
  // Onboarding-triggered review is event-driven, not periodic.
  ["on-onboarding", "PER_EVENT"],
]);

/**
 * Periodic cadences, tightest first. Used to pick the binding
 * obligation out of a multi-valued cell.
 */
const PERIODIC_PRECEDENCE: readonly ParsedCadence[] = [
  "CONTINUOUS",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
];

/** `CC6.1-2` → `CC6.1`; `PI1.4-2` → `PI1.4`. */
const CONTROL_CODE_PATTERN = /^([A-Z]+\d+\.\d+)-\d+$/;

/**
 * Collapse a cadence cell to the one value the row stores.
 *
 * Several inventory rows carry two cadences ("Continuous, daily",
 * "Per-event, quarterly") because the control is both event-driven
 * and reviewed on a clock. The column holds one enum, so the rule is:
 * prefer the tightest PERIODIC cadence when one is present, because
 * that is the obligation with a deadline attached and therefore the
 * one a scheduler or a reviewer can miss. Fall back to the
 * event-driven value when the cell has no periodic term.
 *
 * The full cell is preserved on `cadenceRaw` and written into the
 * control's notes by the seeder, so nothing is lost.
 */
export function resolveCadence(raw: string): {
  readonly cadence: ParsedCadence;
  readonly all: readonly ParsedCadence[];
} {
  const terms = raw
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    throw new Error(`${CONTROLS_INVENTORY_UNKNOWN_CADENCE}: cadence cell is empty.`);
  }

  const all: ParsedCadence[] = [];
  for (const term of terms) {
    const mapped = CADENCE_BY_LABEL.get(term);
    if (mapped === undefined) {
      throw new Error(
        `${CONTROLS_INVENTORY_UNKNOWN_CADENCE}: "${term}" (from "${raw}") is not a known ` +
          `cadence. Known: ${[...CADENCE_BY_LABEL.keys()].join(", ")}.`
      );
    }
    if (!all.includes(mapped)) all.push(mapped);
  }

  const tightestPeriodic = PERIODIC_PRECEDENCE.find((candidate) => all.includes(candidate));
  // `all[0]` is safe: `terms` is non-empty and every term mapped.
  const cadence = tightestPeriodic ?? (all[0] as ParsedCadence);
  return { cadence, all };
}

/**
 * Mine implementation references out of a notes cell.
 *
 * Picks up backticked spans (`@pharmax/rbac`,
 * `scripts/security/run-access-review.ts`), markdown link targets,
 * and ADR ids. Best-effort by design: this populates a convenience
 * column, and the authoritative crosswalk remains
 * docs/soc2/code-evidence-map.md. Nothing downstream fails when a
 * note happens to mention no reference.
 */
export function extractImplementationRefs(notes: string): readonly string[] {
  const refs: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !refs.includes(trimmed)) refs.push(trimmed);
  };

  for (const match of notes.matchAll(/`([^`]+)`/g)) push(match[1] ?? "");
  for (const match of notes.matchAll(/\]\(([^)]+)\)/g)) push(match[1] ?? "");
  for (const match of notes.matchAll(/\bADR-\d{4}\b/g)) push(match[0]);

  return refs;
}

/** Strip a markdown link to its text: `[a](b)` → `a`. */
function unlink(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

/**
 * Section heading → category. `## Additional Criteria — Availability`
 * becomes "Availability"; `## Common Criteria` stays as-is.
 */
function categoryFromHeading(heading: string | null): string {
  if (heading === null) return "Uncategorized";
  // Em dash in the source; accept a hyphen too so a reformat of the
  // document does not silently re-file every control.
  const match = /^Additional Criteria\s*[—-]\s*(.+)$/.exec(heading);
  return (match?.[1] ?? heading).trim();
}

export function parseControlsInventory(markdown: string): readonly ParsedControl[] {
  const tables = parseMarkdownTables(markdown);
  const controls: ParsedControl[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    // Only the control tables have a "Control ID" column; the
    // document's other tables (status vocabulary, etc.) are skipped
    // without ceremony.
    if (!table.headers.some((h) => h.toLowerCase() === "control id")) continue;

    const idCol = columnIndex(table, "Control ID");
    const descCol = columnIndex(table, "Description");
    const statusCol = columnIndex(table, "Status");
    const ownerCol = columnIndex(table, "Owner");
    const cadenceCol = columnIndex(table, "Review Cadence");
    const notesCol = columnIndex(table, "Notes");
    const category = categoryFromHeading(table.heading);

    for (const row of table.rows) {
      const code = (row[idCol] ?? "").trim();
      const codeMatch = CONTROL_CODE_PATTERN.exec(code);
      if (codeMatch === null) {
        throw new Error(
          `${CONTROLS_INVENTORY_BAD_CONTROL_CODE}: "${code}" does not match ` +
            `<criterion>-<n> (e.g. "CC6.1-2").`
        );
      }
      if (seen.has(code)) {
        throw new Error(
          `${CONTROLS_INVENTORY_DUPLICATE_CODE}: "${code}" appears more than once. ` +
            `Control codes are stable identifiers and must be unique.`
        );
      }
      seen.add(code);

      const statusLabel = (row[statusCol] ?? "").trim().toLowerCase();
      const status = STATUS_BY_LABEL.get(statusLabel);
      if (status === undefined) {
        throw new Error(
          `${CONTROLS_INVENTORY_UNKNOWN_STATUS}: "${row[statusCol] ?? ""}" on control ` +
            `"${code}" is not a known status. Known: ` +
            `${[...STATUS_BY_LABEL.keys()].join(", ")}.`
        );
      }

      const cadenceRaw = (row[cadenceCol] ?? "").trim();
      const { cadence } = resolveCadence(cadenceRaw);

      const notesRaw = (row[notesCol] ?? "").trim();

      controls.push({
        code,
        criterionCode: codeMatch[1] ?? "",
        category,
        title: unlink(row[descCol] ?? ""),
        status,
        ownerRole: (row[ownerCol] ?? "").trim(),
        cadence,
        cadenceRaw,
        notes: notesRaw.length > 0 ? notesRaw : null,
        implementationRefs: notesRaw.length > 0 ? extractImplementationRefs(notesRaw) : [],
      });
    }
  }

  if (controls.length === 0) {
    throw new Error(
      `${CONTROLS_INVENTORY_NO_CONTROLS}: no control tables found. Either the document ` +
        `changed shape or the wrong file was passed — refusing to seed an empty catalog ` +
        `over an existing one.`
    );
  }

  return controls;
}
