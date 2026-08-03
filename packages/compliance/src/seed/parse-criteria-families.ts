// Criterion family titles, read out of
// docs/soc2/trust-service-criteria-mapping.md.
//
// Why titles come from our own crosswalk document rather than from
// the standard: the per-criterion titles in the AICPA Trust Services
// Criteria are copyrighted text, the same reason
// `ComplianceCriterion.requirementText` is seeded NULL. The family
// headings in our mapping document ("CC6 — Logical and Physical
// Access Controls") are our own editorial labels for the groups, are
// already the words the team and the auditor use, and are safe to
// carry into the database.
//
// The consequence, stated plainly so nobody mistakes it for a bug:
// every criterion in a family shares its family's title. CC6.1 and
// CC6.2 are both titled "Logical and Physical Access Controls". A
// precise per-criterion title is a licensed transcription task for a
// human, not something this seeder should invent.

/** Family prefix ("CC6", "A") → human title. */
export type CriterionFamilyTitles = ReadonlyMap<string, string>;

/**
 * Extract family titles from the mapping document's headings.
 *
 * Recognizes two shapes:
 *   `### CC6 — Logical and Physical Access Controls` → CC6
 *   `## TSC: Availability (A)`                       → A
 */
export function parseCriteriaFamilies(markdown: string): CriterionFamilyTitles {
  const families = new Map<string, string>();

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();

    const familyHeading = /^#{2,4}\s+([A-Z]+\d+)\s*[—-]\s*(.+)$/.exec(line);
    if (familyHeading !== null) {
      families.set(familyHeading[1] ?? "", (familyHeading[2] ?? "").trim());
      continue;
    }

    const sectionHeading = /^#{2,4}\s+TSC:\s*(.+?)\s*\(([A-Z]+)(?:\s*—\s*[A-Z]+)?\)\s*$/.exec(line);
    if (sectionHeading !== null) {
      const title = (sectionHeading[1] ?? "").trim();
      const prefix = sectionHeading[2] ?? "";
      // Do not let a section heading overwrite a more specific
      // family heading parsed earlier.
      if (!families.has(prefix)) families.set(prefix, title);
    }
  }

  return families;
}

/**
 * Best available title for a criterion code.
 *
 * Falls back from the exact family ("CC6") to the bare letter prefix
 * ("A"), then to the code itself. The final fallback is deliberately
 * the code and not a generic string like "Uncategorized": a criterion
 * showing its own code in the UI is obviously untitled, whereas a
 * plausible-looking placeholder reads like real reference data.
 */
export function resolveCriterionTitle(
  criterionCode: string,
  families: CriterionFamilyTitles
): string {
  const family = /^([A-Z]+\d+)\./.exec(criterionCode)?.[1];
  if (family !== undefined) {
    const exact = families.get(family);
    if (exact !== undefined) return exact;
  }

  const letters = /^([A-Z]+)/.exec(criterionCode)?.[1];
  if (letters !== undefined) {
    const byLetters = families.get(letters);
    if (byLetters !== undefined) return byLetters;
  }

  return criterionCode;
}
