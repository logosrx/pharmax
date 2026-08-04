// RxNorm release version handling.
//
// NLM names Prescribable Content archives
// `RxNorm_full_prescribe_MMDDYYYY.zip`; the MMDDYYYY token is the
// release's identity and the only ordering information there is.
// Parsed ONCE at ingestion into a real date (`rxnorm_release.releasedOn`)
// so "is this release older than what is live?" is a comparison at the
// swap site rather than a string parse everywhere.

export interface ParsedRxnormVersion {
  /** The token as NLM writes it, e.g. "07072026". */
  readonly version: string;
  /** The same token as a UTC date. */
  readonly releasedOn: Date;
}

const VERSION_PATTERN = /^(\d{2})(\d{2})(\d{4})$/;

/**
 * Parse an MMDDYYYY version token. Returns `null` for anything that
 * is not a real calendar date — a mistyped version must fail the
 * ingestion loudly rather than load under a garbage identity that
 * every finding then stamps.
 */
export function parseRxnormVersion(raw: string): ParsedRxnormVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const releasedOn = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls an invalid day/month over (Feb 30 → Mar
  // 2); reject anything that did not round-trip.
  if (
    releasedOn.getUTCFullYear() !== year ||
    releasedOn.getUTCMonth() !== month - 1 ||
    releasedOn.getUTCDate() !== day
  ) {
    return null;
  }
  return { version: match[0], releasedOn };
}

/**
 * Extract the version token from an NLM archive or directory name
 * (`RxNorm_full_prescribe_07072026.zip`, `RxNorm_full_prescribe_07072026`).
 * A convenience for the CLI; an explicit `--version` always wins.
 */
export function rxnormVersionFromArchiveName(name: string): ParsedRxnormVersion | null {
  const match = /(\d{8})(?:\.zip)?$/i.exec(name.trim());
  if (match === null || match[1] === undefined) return null;
  return parseRxnormVersion(match[1]);
}
