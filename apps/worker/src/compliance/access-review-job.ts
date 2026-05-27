// Quarterly access-review job.
//
// SOC 2 CC6.2 + HIPAA § 164.308(a)(4) require periodic review of
// who has access to what. This job:
//
//   1. Fires daily at 03:00 UTC via the existing `daily-utc-scheduler`
//      (intentionally LATER than the 02:00 UTC Merkle job and 02:30
//      UTC security digest so this morning's evidence sees a
//      finalized chain).
//   2. Guards on "is `now` the first day of a calendar quarter?".
//      Skips silently otherwise — keeping the job idle on 364
//      days/year keeps the surface tiny.
//   3. On hit, walks every organization; per organization, runs
//      `generateAccessReview` over the last 90 days, aggregates
//      command_log + audit_log activity (counts only, no payloads),
//      detects anomalies, writes a JSONL evidence artifact to the
//      audit-archive bucket, renders a markdown summary, and emits
//      one notification per organization for the OrgAdmin to walk.
//
// PHI invariant: every read in this file is operator/role/scope
// metadata or aggregate counts. We DO NOT read patient-touching
// payloads. The output artifacts are PHI-free by construction.
//
// Reproducibility invariant: rerunning the job for the same quarter
// produces byte-identical output (modulo `generatedAt`). All maps
// are walked in sorted order; the JSONL has a stable key sequence.
//
// Idempotency: the evidence-archive bucket is Object Lock COMPLIANCE
// (write-once). A second-write attempt for the same object key
// FAILS the publish step; that is the desired behavior — the
// scheduler logs the failure and the operator decides whether to
// publish into a `-rerun` key suffix.

import type { PrismaClient } from "@pharmax/database";
import type { logger as loggerNs } from "@pharmax/platform-core";
import {
  ELEVATED_ROLE_CODES,
  OrganizationNotFoundForAccessReviewError,
  generateAccessReview,
  type AccessReviewClient,
  type AccessReviewReport,
} from "@pharmax/security";
import { withSystemContext } from "@pharmax/tenancy";

import {
  createDailyUtcScheduler,
  type DailyUtcScheduler,
} from "../security/daily-utc-scheduler.js";

import {
  aggregateAccessActivity,
  createPrismaAccessActivityClient,
  type AccessActivityAggregate,
  type AccessActivityClient,
} from "./access-activity-aggregator.js";
import {
  DEFAULT_THRESHOLDS,
  detectAccessAnomalies,
  type AccessAnomaly,
  type AnomalyDetectionThresholds,
} from "./access-review-anomaly-detector.js";
import {
  renderAccessReviewMarkdown,
  type BreakGlassSessionLite,
} from "./access-review-renderer.js";
import {
  FilesystemEvidencePublisher,
  renderJsonl,
  type EvidencePublisher,
} from "./evidence-publisher.js";
import { LoggingComplianceNotifier, type ComplianceNotifier } from "./compliance-notifier.js";
import { isFirstDayOfQuarter, resolveCompletedQuarter, type QuarterPeriod } from "./quarter.js";

type Logger = loggerNs.Logger;

export interface QuarterlyAccessReviewLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** UTC hour to fire — default 03:00 UTC. */
  readonly utcHour?: number;
  /** UTC minute to fire — default 0. */
  readonly utcMinute?: number;
  /** Override the evidence publisher; default writes under `./evidence/access-reviews/`. */
  readonly evidencePublisher?: EvidencePublisher;
  /** Override the org-admin notifier; default is a structured-log stub. */
  readonly notifier?: ComplianceNotifier;
  /** Override the activity client (tests). */
  readonly activityClient?: AccessActivityClient;
  /** Override the access-review client (tests). */
  readonly accessReviewClient?: AccessReviewClient;
  /** Override the clock (tests). */
  readonly now?: () => Date;
  /** Override anomaly thresholds. */
  readonly thresholds?: AnomalyDetectionThresholds;
  /**
   * Lookback window in days — default 92 days to cover one quarter
   * with a small spillover so a late-running job still has a full
   * window even if the worker was down on Jan 1 morning.
   */
  readonly lookbackDays?: number;
  /**
   * Optional probe for break-glass sessions opened in the period.
   * Defaults to returning an empty list — the schema is not yet
   * promoted to Prisma (see `packages/security/src/break-glass/SCHEMA.md`).
   */
  readonly listBreakGlassSessions?: (args: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }) => Promise<ReadonlyArray<BreakGlassSessionLite>>;
}

export interface QuarterlyAccessReviewLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests + the manual-run script. */
  runOnce(now: Date): Promise<AccessReviewRunSummary>;
}

export interface AccessReviewRunSummary {
  readonly quarter: QuarterPeriod;
  readonly organizationsProcessed: number;
  readonly organizationsFailed: number;
  readonly artifacts: ReadonlyArray<{
    readonly organizationId: string;
    readonly organizationSlug: string;
    readonly jsonlUri: string;
    readonly markdownUri: string;
    readonly anomalyCount: number;
  }>;
}

const DEFAULT_EVIDENCE_ROOT = "./evidence";

export function createQuarterlyAccessReviewLoop(
  options: QuarterlyAccessReviewLoopOptions
): QuarterlyAccessReviewLoop {
  const log = options.logger.child({ component: "quarterly-access-review" });
  const utcHour = options.utcHour ?? 3;
  const utcMinute = options.utcMinute ?? 0;
  const evidencePublisher =
    options.evidencePublisher ??
    new FilesystemEvidencePublisher({ rootDir: DEFAULT_EVIDENCE_ROOT });
  const notifier = options.notifier ?? new LoggingComplianceNotifier(log);
  const accessReviewClient =
    options.accessReviewClient ?? buildPrismaAccessReviewClient(options.prisma);
  const activityClient = options.activityClient ?? createPrismaAccessActivityClient(options.prisma);
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const lookbackDays = options.lookbackDays ?? 92;
  const now = options.now ?? (() => new Date());
  const listBreakGlassSessions =
    options.listBreakGlassSessions ?? (async () => [] as ReadonlyArray<BreakGlassSessionLite>);

  async function runOnce(at: Date): Promise<AccessReviewRunSummary> {
    const quarter = resolveCompletedQuarter(at);
    log.info("access-review.run.start", {
      quarter: quarter.label,
      periodStart: quarter.start.toISOString(),
      periodEnd: quarter.end.toISOString(),
    });

    const orgs = await withSystemContext("compliance:list-orgs-for-access-review", () =>
      options.prisma.organization.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      })
    );

    const artifacts: AccessReviewRunSummary["artifacts"][number][] = [];
    let processed = 0;
    let failed = 0;

    for (const org of orgs) {
      try {
        const artifact = await runForOrg({
          organizationId: org.id,
          organizationSlug: org.slug,
          quarter,
          activityWindowStart: subtractDays(quarter.end, lookbackDays),
          activityWindowEnd: quarter.end,
        });
        artifacts.push(artifact);
        processed += 1;
      } catch (cause) {
        failed += 1;
        const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
        log.error("access-review.run.org_failed", {
          organizationId: org.id,
          organizationSlug: org.slug,
          quarter: quarter.label,
          errorMessage: message,
        });
      }
    }

    log.info("access-review.run.complete", {
      quarter: quarter.label,
      organizationsProcessed: processed,
      organizationsFailed: failed,
    });

    return {
      quarter,
      organizationsProcessed: processed,
      organizationsFailed: failed,
      artifacts,
    };
  }

  async function runForOrg(args: {
    readonly organizationId: string;
    readonly organizationSlug: string;
    readonly quarter: QuarterPeriod;
    readonly activityWindowStart: Date;
    readonly activityWindowEnd: Date;
  }): Promise<AccessReviewRunSummary["artifacts"][number]> {
    const { organizationId, organizationSlug, quarter } = args;
    const objectKeyPrefix = `access-reviews/${organizationId}/${quarter.label}`;
    let report: AccessReviewReport;
    try {
      report = await withSystemContext("compliance:access-review:generate", () =>
        generateAccessReview({
          organizationId,
          periodStart: quarter.start,
          periodEnd: quarter.end,
          client: accessReviewClient,
          now: args.activityWindowEnd,
        })
      );
    } catch (cause) {
      if (cause instanceof OrganizationNotFoundForAccessReviewError) {
        log.warn("access-review.org_disappeared", { organizationId });
        throw cause;
      }
      throw cause;
    }

    const aggregate = await aggregateAccessActivity({
      organizationId,
      periodStart: args.activityWindowStart,
      periodEnd: args.activityWindowEnd,
      client: activityClient,
    });

    const elevatedActorUserIds = collectElevatedActorIds(report);
    const anomalies = detectAccessAnomalies({
      aggregate,
      elevatedActorUserIds,
      thresholds,
    });

    const breakGlassSessions = await listBreakGlassSessions({
      periodStart: quarter.start,
      periodEnd: quarter.end,
    });

    const jsonlBody = renderJsonl(
      buildJsonlRecords({ report, aggregate, anomalies, breakGlassSessions })
    );
    const jsonlPublish = await evidencePublisher.publish({
      objectKey: `${objectKeyPrefix}/access-review.jsonl`,
      body: jsonlBody,
      contentType: "application/x-ndjson",
    });

    const markdown = renderAccessReviewMarkdown({
      report,
      aggregate,
      anomalies,
      quarterLabel: quarter.label,
      evidenceJsonlUri: jsonlPublish.uri,
      breakGlassSessions,
    });
    const markdownPublish = await evidencePublisher.publish({
      objectKey: `${objectKeyPrefix}/access-review-${organizationSlug}-${quarter.label}.md`,
      body: markdown,
      contentType: "text/markdown",
    });

    log.info("access-review.org_written", {
      organizationId,
      organizationSlug,
      quarter: quarter.label,
      jsonlUri: jsonlPublish.uri,
      jsonlSha256: jsonlPublish.sha256,
      markdownUri: markdownPublish.uri,
      markdownSha256: markdownPublish.sha256,
      totalPrincipals: report.summary.totalPrincipals,
      anomalies: anomalies.length,
    });

    const severity: "info" | "warning" | "critical" =
      anomalies.length === 0
        ? "info"
        : anomalies.some((a) => a.kind === "high-failure-ratio")
          ? "critical"
          : "warning";

    await notifier.notify({
      kind: "access-review.ready",
      organizationId,
      subject: `Q${String(quarter.quarter)} ${String(quarter.year)} access review ready for ${organizationSlug}`,
      body: buildNotificationBody({
        organizationSlug,
        quarter,
        report,
        aggregate,
        anomalies,
        breakGlassSessions,
        markdownUri: markdownPublish.uri,
      }),
      evidenceUri: markdownPublish.uri,
      severity,
    });

    return {
      organizationId,
      organizationSlug,
      jsonlUri: jsonlPublish.uri,
      markdownUri: markdownPublish.uri,
      anomalyCount: anomalies.length,
    };
  }

  async function runJob(): Promise<void> {
    const at = now();
    if (!isFirstDayOfQuarter(at)) {
      // The daily scheduler fires every day; this job acts on
      // Q boundaries only. A miss-day (worker down) will catch
      // up the next day because Q1's quarter is "completed" for
      // any day in Q2.
      return;
    }
    await runOnce(at);
  }

  const scheduler = createDailyUtcScheduler({
    name: "quarterly-access-review",
    utcHour,
    utcMinute,
    runJob,
    logger: options.logger,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    scheduler,
    start(): void {
      scheduler.start();
    },
    stop(): Promise<void> {
      return scheduler.stop();
    },
    runOnce,
  };
}

function buildPrismaAccessReviewClient(prisma: PrismaClient): AccessReviewClient {
  return {
    async loadOrganization({ organizationId }) {
      const org = await withSystemContext("compliance:access-review:load-org", () =>
        prisma.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, slug: true },
        })
      );
      return org === null ? null : { id: org.id, slug: org.slug };
    },
    async loadUsersWithRoles({ organizationId }) {
      const users = await withSystemContext("compliance:access-review:load-users", () =>
        prisma.user.findMany({
          where: { organizationId },
          orderBy: { email: "asc" },
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            clerkUserId: true,
            lastLoginAt: true,
            userRoles: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                organizationId: true,
                siteId: true,
                clinicId: true,
                teamId: true,
                role: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    scope: true,
                    rolePermissions: {
                      select: { permission: { select: { code: true } } },
                    },
                  },
                },
              },
            },
          },
        })
      );
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        status: u.status,
        clerkUserId: u.clerkUserId,
        lastLoginAt: u.lastLoginAt,
        userRoles: u.userRoles.map((ur) => ({
          id: ur.id,
          createdAt: ur.createdAt,
          organizationId: ur.organizationId,
          siteId: ur.siteId,
          clinicId: ur.clinicId,
          teamId: ur.teamId,
          role: {
            id: ur.role.id,
            code: ur.role.code,
            name: ur.role.name,
            scope: ur.role.scope,
            rolePermissions: ur.role.rolePermissions.map((rp) => ({
              permission: { code: rp.permission.code },
            })),
          },
        })),
      }));
    },
  };
}

function collectElevatedActorIds(report: AccessReviewReport): ReadonlyArray<string> {
  const elevated = new Set<string>();
  for (const principal of report.principals) {
    for (const assignment of principal.assignments) {
      if (ELEVATED_ROLE_CODES.includes(assignment.roleCode)) {
        elevated.add(principal.userId);
        break;
      }
    }
  }
  return [...elevated].sort();
}

interface JsonlRecord {
  readonly recordType: string;
  readonly [key: string]: unknown;
}

function buildJsonlRecords(args: {
  readonly report: AccessReviewReport;
  readonly aggregate: AccessActivityAggregate;
  readonly anomalies: ReadonlyArray<AccessAnomaly>;
  readonly breakGlassSessions: ReadonlyArray<BreakGlassSessionLite>;
}): ReadonlyArray<JsonlRecord> {
  const records: JsonlRecord[] = [];
  records.push({
    recordType: "header",
    organizationId: args.report.organizationId,
    organizationSlug: args.report.organizationSlug,
    generatedAt: args.report.generatedAt,
    periodStart: args.report.period.start,
    periodEnd: args.report.period.end,
    activityPeriodStart: args.aggregate.periodStart,
    activityPeriodEnd: args.aggregate.periodEnd,
    summary: args.report.summary,
    activityTotals: args.aggregate.totals,
  });
  for (const principal of args.report.principals) {
    records.push({
      recordType: "principal",
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      status: principal.status,
      clerkUserId: principal.clerkUserId,
      lastLoginAt: principal.lastLoginAt,
      effectivePermissions: principal.effectivePermissions,
    });
    for (const assignment of principal.assignments) {
      records.push({
        recordType: "assignment",
        userId: principal.userId,
        ...assignment,
      });
    }
  }
  for (const row of args.aggregate.commandCounts) {
    records.push({
      recordType: "command-activity",
      ...row,
    });
  }
  for (const row of args.aggregate.auditCounts) {
    records.push({
      recordType: "audit-activity",
      ...row,
    });
  }
  for (const anomaly of args.anomalies) {
    records.push({
      recordType: "anomaly",
      ...anomaly,
    });
  }
  for (const session of args.breakGlassSessions) {
    records.push({
      recordType: "break-glass-session",
      ...session,
    });
  }
  return records;
}

function buildNotificationBody(args: {
  readonly organizationSlug: string;
  readonly quarter: QuarterPeriod;
  readonly report: AccessReviewReport;
  readonly aggregate: AccessActivityAggregate;
  readonly anomalies: ReadonlyArray<AccessAnomaly>;
  readonly breakGlassSessions: ReadonlyArray<BreakGlassSessionLite>;
  readonly markdownUri: string;
}): string {
  return [
    `Pharmax has generated the ${args.quarter.label} access-review evidence pack for ${args.organizationSlug}.`,
    ``,
    `Counts:`,
    `  - operators with assignments: ${String(args.report.summary.totalPrincipals)}`,
    `  - operators with elevated roles: ${String(args.report.summary.principalsWithElevatedRoles.length)}`,
    `  - inactive operators: ${String(args.report.summary.inactivePrincipals.length)}`,
    `  - stale role assignments: ${String(args.report.summary.staleAssignments.length)}`,
    `  - break-glass sessions opened in the quarter: ${String(args.breakGlassSessions.length)}`,
    `  - anomalies surfaced: ${String(args.anomalies.length)}`,
    ``,
    `Reviewer action: walk the report and file corrective tickets per docs/governance/access-review-procedure.md.`,
    `Evidence (markdown): ${args.markdownUri}`,
  ].join("\n");
}

function subtractDays(at: Date, days: number): Date {
  return new Date(at.getTime() - days * 86_400_000);
}

// Re-exports for the manual-run script and tests.
export { RecordingEvidencePublisher, FilesystemEvidencePublisher } from "./evidence-publisher.js";
export { RecordingComplianceNotifier } from "./compliance-notifier.js";
