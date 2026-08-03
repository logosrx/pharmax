// Compliance check scheduler — the loop that makes the control plane
// "continuous" rather than "documented".
//
// Each tick: find every enabled check whose nextRunAt has come due,
// resolve its probe from the code registry, run it, and persist the
// results atomically with the check's scheduler state and any
// remediation task the failure warrants.
//
// Four behaviours here are deliberate and each prevents a specific
// silent failure:
//
//   1. A check row whose `code` has no registered probe records an
//      ERROR run rather than being skipped. A skipped check keeps its
//      green history and its place on the dashboard while doing
//      nothing — the worst possible state for a monitoring system,
//      because it looks exactly like success.
//
//   2. One check's failure never aborts the tick. Each check is
//      isolated, so a probe that throws still lets the other twenty
//      run. Compliance coverage that collapses to zero because one
//      probe hit a bad row is not coverage.
//
//   3. `nextRunAt` advances even when a check fails or errors.
//      Otherwise a permanently-failing probe would be retried every
//      tick, and a probe that throws before its first success would
//      never get a next run at all.
//
//   4. Evidence is recorded unconditionally; only the RESPONSE is
//      suppressed by an active exception. An excepted check still
//      writes its failing run, because the audit question is "was
//      this condition true during the period", and an exception is an
//      answer to "and what did you do about it" — not permission to
//      stop looking.
//
// Runs are written directly here rather than through the command bus.
// The bus requires an organizationId for `command_log` and
// `audit_log`, and a platform-wide probe has none — the same
// constraint break-glass documents in packages/security/src/
// break-glass/SCHEMA.md. The evidence tables are themselves the
// append-only ledger (INSERT-only at the grant layer), so the
// integrity guarantee does not depend on the bus. Human-initiated
// mutations of this data (SignOffControl, AcceptCheckException) DO go
// through the bus, because there the actor has a real tenancy.

import {
  runComplianceCheck,
  resolveCheck,
  COMPLIANCE_DETAILS_VERSION,
  computeComplianceDigest,
  type ComplianceCheckDefinition,
  type ComplianceCheckRunRecord,
} from "@pharmax/compliance";
import type { PrismaClient } from "@pharmax/database";
import type { clock as clockContract, logger as loggerContract } from "@pharmax/platform-core";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

type Logger = loggerContract.Logger;
type Clock = clockContract.Clock;

/** Days from detection to due date, by severity. */
const TASK_DUE_DAYS_BY_SEVERITY: Readonly<Record<string, number>> = Object.freeze({
  CRITICAL: 1,
  HIGH: 3,
  MEDIUM: 7,
  LOW: 30,
});

/**
 * Fallback interval for a check that is somehow due with no
 * `intervalMinutes`. defineCheck rejects that combination for
 * scheduler-driven cadences, so reaching this means a row was edited
 * directly in the database. A day keeps it moving without hammering.
 */
const FALLBACK_INTERVAL_MINUTES = 1440;

/** Max checks processed per tick, so one tick cannot run unbounded. */
const DEFAULT_BATCH_SIZE = 50;

export interface ComplianceCheckSchedulerDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly batchSize?: number;
  /**
   * Probe lookup. Defaults to the real code registry; injectable so
   * tests can exercise the scheduler's own branches (unresolved code,
   * mixed per-tenant verdicts, task dedupe) with purpose-built probes
   * instead of coupling every assertion to whichever real probes
   * happen to be registered today.
   */
  readonly resolveCheckDefinition?: (code: string) => ComplianceCheckDefinition | undefined;
}

export interface ComplianceCheckSchedulerTickSummary {
  readonly dueCount: number;
  readonly ranCount: number;
  readonly unresolvedCount: number;
  readonly runsRecorded: number;
  readonly failedRunCount: number;
  readonly erroredRunCount: number;
  readonly tasksOpened: number;
}

export interface ComplianceCheckScheduler {
  tick: () => Promise<ComplianceCheckSchedulerTickSummary>;
}

export function createComplianceCheckScheduler(
  deps: ComplianceCheckSchedulerDeps
): ComplianceCheckScheduler {
  const log = deps.logger;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const resolve = deps.resolveCheckDefinition ?? resolveCheck;

  async function tick(): Promise<ComplianceCheckSchedulerTickSummary> {
    const now = deps.clock.now();

    const due = await withSystemContext("worker:compliance-scheduler:claim-due", () =>
      deps.prisma.complianceCheck.findMany({
        where: {
          enabled: true,
          automated: true,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        select: {
          id: true,
          code: true,
          severity: true,
          intervalMinutes: true,
          consecutiveFailureCount: true,
        },
        // Null nextRunAt first (never run), then oldest due.
        orderBy: [{ nextRunAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
        take: batchSize,
      })
    );

    if (due.length === 0) {
      log.debug("compliance_scheduler.idle");
      return {
        dueCount: 0,
        ranCount: 0,
        unresolvedCount: 0,
        runsRecorded: 0,
        failedRunCount: 0,
        erroredRunCount: 0,
        tasksOpened: 0,
      };
    }

    log.info("compliance_scheduler.tick.start", { dueCount: due.length });

    let ranCount = 0;
    let unresolvedCount = 0;
    let runsRecorded = 0;
    let failedRunCount = 0;
    let erroredRunCount = 0;
    let tasksOpened = 0;

    for (const row of due) {
      const definition = resolve(row.code);

      let records: readonly ComplianceCheckRunRecord[];
      if (definition === undefined) {
        // Behaviour (1): loud, not skipped.
        unresolvedCount += 1;
        log.error("compliance_scheduler.check.unresolved", { checkCode: row.code });
        records = [buildUnresolvedRecord(row.code, row.severity, deps.clock.now())];
      } else {
        try {
          // Probes are cross-tenant by construction, so the whole
          // evaluation runs in one system-context frame; the tenancy
          // extension would otherwise fail closed on the first read.
          records = await withSystemContext(`worker:compliance-probe:${row.code}`, () =>
            runComplianceCheck(definition, {
              prisma: deps.prisma,
              clock: deps.clock,
              logger: log,
            })
          );
          ranCount += 1;
        } catch (cause) {
          // runComplianceCheck already converts a throwing probe into
          // an ERROR record, so reaching here means the failure was in
          // the system-context frame itself. Behaviour (2): isolate it
          // and keep going.
          unresolvedCount += 1;
          log.error("compliance_scheduler.check.frame_failed", {
            checkCode: row.code,
            errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
          });
          records = [buildFrameFailureRecord(row.code, row.severity, deps.clock.now())];
        }
      }

      try {
        const persisted = await persistRunBatch({
          prisma: deps.prisma,
          check: row,
          records,
          // The row wins over the code default. `intervalMinutes` is
          // a column precisely so cadence can be tuned per
          // environment without a deploy; letting the definition
          // override it would make the column dead weight that reads
          // as configurable but is silently ignored. The definition
          // is the seed value, not the runtime authority.
          intervalMinutes: row.intervalMinutes ?? definition?.intervalMinutes ?? null,
          now: deps.clock.now(),
        });
        runsRecorded += persisted.runsRecorded;
        failedRunCount += persisted.failedRunCount;
        erroredRunCount += persisted.erroredRunCount;
        tasksOpened += persisted.tasksOpened;
      } catch (cause) {
        log.error("compliance_scheduler.persist_failed", {
          checkCode: row.code,
          errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
        });
      }
    }

    const summary: ComplianceCheckSchedulerTickSummary = {
      dueCount: due.length,
      ranCount,
      unresolvedCount,
      runsRecorded,
      failedRunCount,
      erroredRunCount,
      tasksOpened,
    };
    log.info("compliance_scheduler.tick.complete", { ...summary });
    return summary;
  }

  return { tick };
}

interface PersistArgs {
  readonly prisma: PrismaClient;
  readonly check: {
    readonly id: string;
    readonly code: string;
    readonly severity: string;
    readonly consecutiveFailureCount: number;
  };
  readonly records: readonly ComplianceCheckRunRecord[];
  readonly intervalMinutes: number | null;
  readonly now: Date;
}

interface PersistResult {
  readonly runsRecorded: number;
  readonly failedRunCount: number;
  readonly erroredRunCount: number;
  readonly tasksOpened: number;
}

/**
 * Write the run rows, advance the check's scheduler state, and open a
 * remediation task if warranted — all in one transaction, so evidence
 * and scheduler state can never disagree about whether a run happened.
 */
async function persistRunBatch(args: PersistArgs): Promise<PersistResult> {
  const reason = "worker:compliance-scheduler:persist";
  return withSystemContext(reason, () =>
    args.prisma.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);

      await tx.complianceCheckRun.createMany({
        data: args.records.map((record) => ({
          checkId: args.check.id,
          checkCode: record.checkCode,
          outcome: record.outcome,
          severityAtRun: record.severityAtRun,
          subjectOrganizationId: record.subjectOrganizationId,
          summary: record.summary,
          details: record.details as object,
          detailsVersion: record.detailsVersion,
          digestSha256: record.digestSha256,
          findingCount: record.findingCount,
          errorCode: record.errorCode,
          errorMessage: record.errorMessage,
          observedAt: record.observedAt,
          durationMs: record.durationMs,
        })),
      });

      const failedRunCount = args.records.filter((r) => r.outcome === "FAIL").length;
      const erroredRunCount = args.records.filter((r) => r.outcome === "ERROR").length;
      const anyNonPass = failedRunCount + erroredRunCount > 0;

      // The check-level outcome across a per-tenant fan-out is the
      // worst verdict observed. A check that is failing for one tenant
      // is failing, and surfacing it as PASS because most tenants are
      // fine is how a real finding gets lost in an average.
      const worstOutcome = resolveWorstOutcome(args.records.map((r) => r.outcome));

      const intervalMinutes =
        args.intervalMinutes !== null && args.intervalMinutes > 0
          ? args.intervalMinutes
          : FALLBACK_INTERVAL_MINUTES;

      await tx.complianceCheck.update({
        where: { id: args.check.id },
        data: {
          lastRunAt: args.now,
          lastOutcome: worstOutcome,
          // Behaviour (3): always advance, pass or fail.
          nextRunAt: new Date(args.now.getTime() + intervalMinutes * 60_000),
          consecutiveFailureCount: anyNonPass ? args.check.consecutiveFailureCount + 1 : 0,
        },
      });

      let tasksOpened = 0;
      if (anyNonPass) {
        tasksOpened = await openTaskIfWarranted({ tx, args, failedRunCount, erroredRunCount });
      }

      return {
        runsRecorded: args.records.length,
        failedRunCount,
        erroredRunCount,
        tasksOpened,
      };
    })
  );
}

/**
 * Open one remediation task per failing check, not per failing run and
 * not per tick.
 *
 * Deduplicating on an existing OPEN / IN_PROGRESS / BLOCKED task is
 * what keeps an hourly probe from manufacturing 24 identical tasks a
 * day. A task list that grows faster than anyone can close it gets
 * ignored wholesale, which costs more than having no task list.
 */
async function openTaskIfWarranted(input: {
  readonly tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
  readonly args: PersistArgs;
  readonly failedRunCount: number;
  readonly erroredRunCount: number;
}): Promise<number> {
  const { tx, args } = input;

  // Behaviour (4): an active exception suppresses the RESPONSE. The
  // failing run above was already recorded regardless.
  const activeException = await tx.complianceCheckException.findFirst({
    where: {
      checkId: args.check.id,
      revokedAt: null,
      expiresAt: { gt: args.now },
    },
    select: { id: true },
  });
  if (activeException !== null) return 0;

  const openTask = await tx.complianceTask.findFirst({
    where: {
      checkId: args.check.id,
      status: { in: ["OPEN", "IN_PROGRESS", "BLOCKED"] },
    },
    select: { id: true },
  });
  if (openTask !== null) return 0;

  const dueDays = TASK_DUE_DAYS_BY_SEVERITY[args.check.severity] ?? 7;
  const worstRecord =
    args.records.find((r) => r.outcome === "FAIL") ??
    args.records.find((r) => r.outcome === "ERROR");

  await tx.complianceTask.create({
    data: {
      title: `Remediate failing check: ${args.check.code}`,
      description:
        `${args.check.code} reported ` +
        `${input.failedRunCount} failing and ${input.erroredRunCount} errored verdict(s) ` +
        `at ${args.now.toISOString()}.\n\n` +
        `${worstRecord?.summary ?? "See the linked run for details."}`,
      checkId: args.check.id,
      sourceCheckRunId: null,
      severity: args.check.severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      dueAt: new Date(args.now.getTime() + dueDays * 86_400_000),
    },
  });
  return 1;
}

/** Worst-first precedence: FAIL beats ERROR beats PASS beats N/A. */
function resolveWorstOutcome(
  outcomes: readonly string[]
): "FAIL" | "ERROR" | "PASS" | "NOT_APPLICABLE" {
  if (outcomes.includes("FAIL")) return "FAIL";
  if (outcomes.includes("ERROR")) return "ERROR";
  if (outcomes.includes("PASS")) return "PASS";
  return "NOT_APPLICABLE";
}

function buildUnresolvedRecord(
  checkCode: string,
  severity: string,
  observedAt: Date
): ComplianceCheckRunRecord {
  return buildSyntheticErrorRecord({
    checkCode,
    severity,
    observedAt,
    errorCode: "COMPLIANCE_CHECK_NOT_REGISTERED",
    errorMessage: `No probe is registered for check code "${checkCode}".`,
    summary:
      `Configuration error: no probe implementation is registered for ` +
      `"${checkCode}", so this check is not being evaluated. Control status is ` +
      `UNKNOWN, not satisfied.`,
  });
}

function buildFrameFailureRecord(
  checkCode: string,
  severity: string,
  observedAt: Date
): ComplianceCheckRunRecord {
  return buildSyntheticErrorRecord({
    checkCode,
    severity,
    observedAt,
    errorCode: "COMPLIANCE_CHECK_FRAME_FAILED",
    errorMessage: "The system-context frame around the probe failed.",
    summary:
      "Probe could not be executed: the surrounding system-context frame failed. " +
      "Control status is UNKNOWN, not satisfied.",
  });
}

function buildSyntheticErrorRecord(input: {
  readonly checkCode: string;
  readonly severity: string;
  readonly observedAt: Date;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly summary: string;
}): ComplianceCheckRunRecord {
  const details = {
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    findings: [],
  };
  return {
    checkCode: input.checkCode,
    outcome: "ERROR",
    severityAtRun: input.severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
    subjectOrganizationId: null,
    summary: input.summary,
    details,
    detailsVersion: COMPLIANCE_DETAILS_VERSION,
    digestSha256: computeComplianceDigest(details),
    findingCount: 0,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    observedAt: input.observedAt,
    durationMs: 0,
  };
}
