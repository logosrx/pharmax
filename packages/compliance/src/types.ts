// Core contracts for the compliance control plane.
//
// The shape here encodes three decisions that are load-bearing for
// whether an auditor can trust the output. Each is worth stating
// explicitly, because the cheap version of this module gets all three
// wrong.
//
//   1. A probe reports OBSERVATIONS, never verdicts about itself.
//      `evaluate` returns PASS / FAIL / NOT_APPLICABLE. It cannot
//      return ERROR — the runner produces ERROR when `evaluate`
//      throws. That split is what keeps an AWS timeout from being
//      recorded as a control failure and, more importantly, keeps a
//      broken probe from being recorded as a control PASS.
//
//   2. `evaluate` always returns an ARRAY of verdicts. Platform-wide
//      probes return one; per-tenant probes (audit-chain
//      verification) return one per organization. A single uniform
//      shape means the runner, the persistence layer, and the
//      dashboard never branch on "is this the per-org kind".
//
//   3. Probe logic lives in CODE, keyed by `code`, and is never
//      loaded from the database. A probe is executable logic that
//      decides whether a security control is holding; it must be
//      code-reviewed, unit-tested, and versioned in git. A
//      `compliance_check` row whose code has no registered
//      implementation is surfaced as a configuration error rather
//      than silently skipped, because a check that quietly stops
//      running is worse than one that fails loudly.
//
// PHI invariant: `summary`, `findings[].subject`,
// `findings[].detail`, and `details` are asserted PHI-free by every
// probe. They are rendered into digest emails and evidence exports
// that leave the tenant boundary. Probes report structural facts,
// counts, and opaque uuids — never a patient column. No probe is
// permitted to select one.

import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import type { PrismaClient } from "@pharmax/database";

type Clock = clockContract.Clock;
type Logger = loggerContract.Logger;

/**
 * JSON values a probe may place in `details`. Deliberately narrower
 * than `unknown`: the value is persisted to JSONB, digested with a
 * canonical stringifier, and re-read by verifiers, so a Date or a
 * BigInt sneaking in would produce a digest that cannot be
 * recomputed from the exported file.
 */
export type ComplianceJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ComplianceJsonValue[]
  | { readonly [key: string]: ComplianceJsonValue };

/** Blast radius if the checked condition is not holding. */
export type ComplianceCheckSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Expected run frequency. Mirrors the Prisma `ComplianceCadence` enum. */
export type ComplianceCadence =
  | "CONTINUOUS"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUAL"
  | "ON_CHANGE"
  | "PER_EVENT";

/**
 * What a probe is allowed to conclude. ERROR is absent on purpose —
 * see decision (1) in the module header.
 */
export type ComplianceProbeOutcome = "PASS" | "FAIL" | "NOT_APPLICABLE";

/**
 * Persisted outcome, which adds the runner-owned ERROR state.
 * Mirrors the Prisma `ComplianceCheckOutcome` enum.
 */
export type ComplianceCheckOutcome = ComplianceProbeOutcome | "ERROR";

/**
 * One specific thing that is wrong. Present so a FAIL is actionable
 * without reading the raw `details` JSON: the digest email lists
 * subjects, and the remediation task quotes them.
 */
export interface ComplianceFinding {
  /**
   * PHI-free identifier of the offending thing — a table name, a
   * role code, an opaque uuid, an AWS resource id.
   */
  readonly subject: string;
  /** One sentence on what is wrong with it. */
  readonly detail: string;
}

/** One probe conclusion, about the platform or about one tenant. */
export interface ComplianceVerdict {
  readonly outcome: ComplianceProbeOutcome;
  /**
   * One-line, PHI-free, safe to paste into an email. Write it so a
   * reader who has never seen the probe understands the state:
   * "12 of 12 tenant tables have RLS enabled", not "ok".
   */
  readonly summary: string;
  /**
   * Empty for PASS. For FAIL, one entry per offending subject —
   * `findingCount` on the persisted run is this array's length.
   */
  readonly findings: readonly ComplianceFinding[];
  /**
   * Structured evidence behind the verdict, persisted to JSONB and
   * digested. Include the numbers that justify the summary so a
   * reviewer can re-derive the conclusion without re-running the
   * probe months later.
   */
  readonly details: Readonly<Record<string, ComplianceJsonValue>>;
  /**
   * Set only by per-tenant probes. Null for platform-wide verdicts.
   * A soft reference, matching the unlinked column on
   * `compliance_check_run`.
   */
  readonly subjectOrganizationId: string | null;
}

/**
 * Everything a probe is given. Deliberately small: a Prisma client
 * for reads, a clock, and a logger.
 *
 * Probes that need an external system (AWS, GitHub) receive it
 * through their own narrow port rather than having it added here, so
 * that a database-only probe stays trivially unit-testable and no
 * probe acquires an ambient dependency it does not use.
 */
export interface ComplianceCheckContext {
  /**
   * Read-only by convention. Probes MUST run inside
   * `withSystemContext` — they are cross-tenant by construction and
   * the tenancy extension would otherwise fail closed.
   */
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * A registered probe.
 *
 * `controlCodes` is the link back to `compliance_control.code`. It
 * lives in code next to the probe rather than only in the database
 * so that deleting a control's last probe is a visible diff in a
 * pull request, not a silent row change.
 */
export interface ComplianceCheckDefinition {
  /**
   * Stable registry key, dotted and namespaced by subsystem
   * ("db.rls.tenant_table_coverage"). Persisted onto every run, so
   * renaming one is a data migration, not a refactor.
   */
  readonly code: string;
  readonly title: string;
  /**
   * What the probe actually inspects and why that evidences the
   * control. Rendered in the auditor-facing UI, so write it for a
   * reader who does not read TypeScript.
   */
  readonly description: string;
  readonly severity: ComplianceCheckSeverity;
  readonly cadence: ComplianceCadence;
  /**
   * Scheduler interval. Null only for cadences the scheduler does
   * not drive (PER_EVENT, ON_CHANGE).
   */
  readonly intervalMinutes: number | null;
  /** Controls this probe produces evidence for. At least one. */
  readonly controlCodes: readonly string[];
  readonly evaluate: (ctx: ComplianceCheckContext) => Promise<readonly ComplianceVerdict[]>;
}

/**
 * Result of running one probe: the verdicts it produced, plus the
 * runner-owned metadata that becomes a `compliance_check_run` row.
 *
 * Returned rather than written so the run logic stays pure and
 * unit-testable; the worker owns persistence.
 */
export interface ComplianceCheckRunRecord {
  readonly checkCode: string;
  readonly outcome: ComplianceCheckOutcome;
  readonly severityAtRun: ComplianceCheckSeverity;
  readonly subjectOrganizationId: string | null;
  readonly summary: string;
  readonly details: Readonly<Record<string, ComplianceJsonValue>>;
  readonly detailsVersion: number;
  readonly digestSha256: string;
  readonly findingCount: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly observedAt: Date;
  readonly durationMs: number;
}
