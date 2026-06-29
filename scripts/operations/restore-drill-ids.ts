// scripts/operations/restore-drill-ids.ts
//
// Pure deterministic helpers for the quarterly Aurora restore drill
// (`docs/operations/restore-drill.md`). Extracted from the CLI entry
// point so we can unit-test the naming + bounds-check logic without
// touching AWS or the database.
//
// Naming convention (matches the runbook §1):
//
//   new cluster  = "<source>-drill-<YYYYMMDD>"
//   new instance = "<new-cluster>-0"
//
// The `YYYYMMDD` suffix uses the UTC date of when the drill is
// initiated. The deterministic suffix is what makes resumable
// multi-phase runs work — `--phase=preflight` and `--phase=teardown-commands`
// both compute the same cluster id from the same source id + the same
// drill date so an operator who runs them across multiple terminals
// or hours of elapsed time still gets the matching pair.

const AWS_DB_CLUSTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class InvalidDrillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDrillInputError";
  }
}

/** Quarter label per the SOC 2 evidence-pack convention (`2026-Q2`). */
export function currentQuarterLabel(now: Date): string {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** `YYYYMMDD` from the UTC components of `now`. */
export function utcDateStamp(now: Date): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Assert that `id` is a syntactically valid Aurora DB cluster
 * identifier. Documented constraints (see AWS RDS docs):
 *   - 1–63 chars
 *   - first char must be a letter
 *   - all chars: lowercase letter, digit, or hyphen
 *   - no two consecutive hyphens
 *   - cannot end with a hyphen
 *
 * The deeper rules around case + trailing hyphens matter because
 * `restore-db-cluster-to-point-in-time` accepts the request but the
 * cluster never becomes available — the kind of silent failure mode
 * we want to catch at CLI-arg-parse time, not at AWS-API time.
 */
export function assertValidDbClusterId(id: string): void {
  if (!AWS_DB_CLUSTER_ID_PATTERN.test(id)) {
    throw new InvalidDrillInputError(
      `Invalid DB cluster id "${id}". Must be 1–63 chars, start with a letter, ` +
        `lowercase + digits + hyphens only.`
    );
  }
  if (id.includes("--")) {
    throw new InvalidDrillInputError(
      `Invalid DB cluster id "${id}". Cannot contain consecutive hyphens.`
    );
  }
  if (id.endsWith("-")) {
    throw new InvalidDrillInputError(`Invalid DB cluster id "${id}". Cannot end with a hyphen.`);
  }
}

/**
 * Compute the drill cluster id from the source cluster id and the
 * UTC date of the drill. Asserts the result is a valid Aurora cluster
 * identifier (the source id might already be at 50+ chars, leaving
 * < 13 for the `-drill-YYYYMMDD` suffix — fail loud rather than have
 * AWS truncate or reject the request).
 */
export function drillClusterId(args: {
  readonly sourceClusterId: string;
  readonly now: Date;
}): string {
  assertValidDbClusterId(args.sourceClusterId);
  const candidate = `${args.sourceClusterId}-drill-${utcDateStamp(args.now)}`;
  assertValidDbClusterId(candidate);
  return candidate;
}

/** First (and only) instance attached to the drill cluster. Suffix is `-0`. */
export function drillInstanceId(args: {
  readonly sourceClusterId: string;
  readonly now: Date;
}): string {
  const cluster = drillClusterId(args);
  const candidate = `${cluster}-0`;
  assertValidDbClusterId(candidate);
  return candidate;
}

/**
 * Parse the operator-supplied `--restore-time=<iso>` arg and assert
 * it falls inside the retention window. Aurora PITR granularity is
 * 1 second; we require fully-qualified ISO 8601 with explicit UTC
 * (`Z` suffix) rather than accepting a naive datetime — the
 * runbook's RESTORE_TIME comparisons against `LatestRestorableTime`
 * are unambiguously UTC, and a parsing surprise on a drill day is
 * the wrong time to debug timezone semantics.
 *
 * `now` is taken as the upper bound (drill clusters can't be
 * restored to a future point — the API rejects but the rejection
 * is at provision time, well after we've already locked the operator
 * into the wrong drill cluster id).
 */
export function parseRestoreTime(args: {
  readonly raw: string;
  readonly now: Date;
  readonly retentionDays: number;
}): Date {
  if (!ISO_INSTANT_PATTERN.test(args.raw)) {
    throw new InvalidDrillInputError(
      `Invalid --restore-time "${args.raw}". Required: full ISO 8601 UTC, e.g. "2026-04-12T14:31:00Z".`
    );
  }
  const parsed = new Date(args.raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidDrillInputError(
      `Invalid --restore-time "${args.raw}". Not a parseable instant.`
    );
  }
  if (parsed.getTime() >= args.now.getTime()) {
    throw new InvalidDrillInputError(
      `--restore-time "${args.raw}" is at or after now. Restore time must be in the past.`
    );
  }
  if (!Number.isInteger(args.retentionDays) || args.retentionDays <= 0) {
    throw new InvalidDrillInputError(
      `Invalid retentionDays ${args.retentionDays}. Must be a positive integer.`
    );
  }
  const oldestRestorable = new Date(args.now.getTime() - args.retentionDays * 86_400_000);
  if (parsed.getTime() < oldestRestorable.getTime()) {
    throw new InvalidDrillInputError(
      `--restore-time "${args.raw}" is older than the retention window ` +
        `(${args.retentionDays} days; oldest restorable = ${oldestRestorable.toISOString()}).`
    );
  }
  return parsed;
}
