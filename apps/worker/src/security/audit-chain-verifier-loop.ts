// Daily audit-chain verifier loop (ADR-0006 + SOC 2 CC7.2).
//
// Walks every organization's audit chain via `verifyChain` and asserts
// per-row invariants:
//
//   1. seq monotonicity: each row's seq is the previous seq + 1.
//   2. prevHash linkage: each row's prevHash is the previous row's
//      entryHash (or NULL on the genesis row).
//   3. tamper-evidence: the recomputed entryHash byte-matches the
//      stored one — proves the row content has not been edited since
//      it was written.
//
// On any inconsistency the verifier throws AUDIT_CHAIN_BROKEN
// pointing at the offending seq AND increments the
// `pharmax_audit_verifier_failures_total` counter (declared inside
// `@pharmax/audit`). Production paging is wired off that counter via
// the AuditChainVerifierFailing alert in
// `observability/prometheus/rules/alert-rules.yaml`.
//
// SCHEDULING RATIONALE — fires at 01:30 UTC, BEFORE the 02:00 UTC
// Merkle root signing job. A break detected at 01:30 UTC gives the
// operator the morning to investigate while the day's signed manifest
// reflects yesterday's chain tip — not the signed result of a
// tamper. If the verifier fired AFTER the Merkle job, a same-day
// break would be signed into the audit-archive Object Lock bucket
// with COMPLIANCE retention before anyone noticed.
//
// PER-ORG ISOLATION — one org's broken chain MUST NOT stop the
// loop from verifying the next org. Each per-org failure is logged
// + counted; the run-level tally reports total failures so the
// digest can include "X orgs with broken chains today" without
// requiring a cross-loop join.
//
// VS THE MERKLE LOOP — the Merkle loop ALSO walks each chain (to
// compute the daily root hash), so a tamper would surface there as
// well. We keep the verifier separate because:
//   - It runs earlier and a failure here halts the morning's Merkle
//     sign for the affected org (the Merkle loop checks the verifier
//     counter on its preflight). The Merkle loop's failure mode
//     would otherwise be "produce a signed manifest of a tampered
//     chain" — worse than no manifest at all.
//   - The verifier produces a structured per-org outcome row that
//     SOC 2 evidence pulls can iterate directly; the Merkle loop's
//     output is the signed manifest, which is a different artifact.
//   - The auditor's question "did you check your audit chain every
//     day this quarter" is answered by the verifier's structured
//     log line + counter, not by inferring it from the Merkle log.

import { verifyChain, type ChainSource } from "@pharmax/audit";
import type { PrismaClient } from "@pharmax/database";
import { errors, type logger as loggerContract } from "@pharmax/platform-core";
import { createPrismaAuditChainSource } from "@pharmax/security";
import { getMeter } from "@pharmax/telemetry";
import { withSystemContext } from "@pharmax/tenancy";

import { createDailyUtcScheduler, type DailyUtcScheduler } from "./daily-utc-scheduler.js";

type Logger = loggerContract.Logger;

const meter = getMeter("@pharmax/worker.security");

const auditChainVerifierRunsCounter = meter.createCounter(
  "pharmax_audit_chain_verifier_runs_total",
  {
    description:
      "Daily audit-chain verifier completions, labelled by per-org outcome (verified | failed). Paired with pharmax_audit_verifier_failures_total (incremented from @pharmax/audit) — that counter increments on EACH detected break, this one increments once per (org, run, outcome).",
  }
);

/**
 * Structured tally produced by `runOnce()` and emitted as the
 * `audit_chain_verifier.run.complete` log line.
 *
 * The digest probe + SOC 2 evidence pull both read these counters
 * directly from the structured log. `errorsByCode` is keyed by the
 * stable PharmaxError code (AUDIT_CHAIN_BROKEN is the dominant case;
 * AUDIT_VERIFIER_UNKNOWN is the fallthrough for non-PharmaxError
 * throws that should never happen in production but must not silently
 * vanish).
 */
export interface DailyAuditChainVerifierRunSummary {
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly organizationCount: number;
  /** Org's chain replayed cleanly from genesis to the current tip. */
  readonly orgsVerified: number;
  /** Org's chain replay threw — counted; logged; the loop continued. */
  readonly orgsFailed: number;
  /** Per-error-code count for the loop's structured log + downstream metrics. */
  readonly errorsByCode: Readonly<Record<string, number>>;
}

export interface DailyAuditChainVerifierLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Default 01:30 UTC — BEFORE the Merkle loop (02:00 UTC). */
  readonly utcHour?: number;
  readonly utcMinute?: number;
  /**
   * Inject a fake `ChainSource` for tests so the loop can run against
   * in-memory rows. Production omits this and the loop builds a
   * `createPrismaAuditChainSource(prisma)`.
   */
  readonly source?: ChainSource;
  /** Override the clock; tests use a fake. */
  readonly now?: () => Date;
}

export interface DailyAuditChainVerifierLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests + manual back-fill invocations. */
  runOnce(at?: Date): Promise<DailyAuditChainVerifierRunSummary>;
}

/** Stable bucket for non-`PharmaxError` throws. Should never appear in production. */
export const AUDIT_VERIFIER_UNKNOWN = "AUDIT_VERIFIER_UNKNOWN" as const;

function classifyError(cause: unknown): { readonly code: string; readonly message: string } {
  if (cause instanceof errors.PharmaxError) {
    return { code: cause.code, message: `${cause.name}: ${cause.message}` };
  }
  if (cause instanceof Error) {
    return { code: AUDIT_VERIFIER_UNKNOWN, message: `${cause.name}: ${cause.message}` };
  }
  return { code: AUDIT_VERIFIER_UNKNOWN, message: "unknown" };
}

export function createDailyAuditChainVerifierLoop(
  options: DailyAuditChainVerifierLoopOptions
): DailyAuditChainVerifierLoop {
  const log = options.logger.child({ component: "audit-chain-verifier" });
  const utcHour = options.utcHour ?? 1;
  const utcMinute = options.utcMinute ?? 30;
  const clock = options.now ?? (() => new Date());

  // Single shared ChainSource for the run — paginates internally and
  // is safe to reuse across orgs because each iteration passes its
  // own `organizationId`.
  const source = options.source ?? createPrismaAuditChainSource(options.prisma);

  let stopRequested = false;

  async function runForOrg(args: {
    readonly organizationId: string;
    readonly slug: string;
  }): Promise<{
    readonly outcome: "verified" | "failed";
    readonly code?: string;
    readonly verifiedRows: number;
    readonly lastSeq: bigint | null;
  }> {
    const { organizationId, slug } = args;
    try {
      const result = await withSystemContext("security:verify-audit-chain", () =>
        verifyChain(source, { organizationId })
      );
      auditChainVerifierRunsCounter.add(1, {
        organization_id: organizationId,
        outcome: "verified",
      });
      log.info("audit_chain_verifier.run.org.verified", {
        organizationId,
        slug,
        verifiedRows: result.verifiedRows,
        firstSeq: result.firstSeq?.toString() ?? null,
        lastSeq: result.lastSeq?.toString() ?? null,
      });
      return {
        outcome: "verified",
        verifiedRows: result.verifiedRows,
        lastSeq: result.lastSeq,
      };
    } catch (cause) {
      const { code, message } = classifyError(cause);
      auditChainVerifierRunsCounter.add(1, {
        organization_id: organizationId,
        outcome: "failed",
      });
      log.error("audit_chain_verifier.run.org.failed", {
        organizationId,
        slug,
        code,
        errorMessage: message,
      });
      return { outcome: "failed", code, verifiedRows: 0, lastSeq: null };
    }
  }

  async function runOnce(at?: Date): Promise<DailyAuditChainVerifierRunSummary> {
    const startedAt = at ?? clock();
    const orgs = await withSystemContext("security:list-orgs-for-verifier", () =>
      options.prisma.organization.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      })
    );
    log.info("audit_chain_verifier.run.start", {
      organizationCount: orgs.length,
      startedAt: startedAt.toISOString(),
    });

    let orgsVerified = 0;
    let orgsFailed = 0;
    const errorsByCode: Record<string, number> = {};

    for (const org of orgs) {
      if (stopRequested) {
        log.warn("audit_chain_verifier.run.stop_requested_mid_batch", {
          remaining: orgs.length - (orgsVerified + orgsFailed),
        });
        break;
      }
      const result = await runForOrg({ organizationId: org.id, slug: org.slug });
      if (result.outcome === "verified") {
        orgsVerified += 1;
      } else {
        orgsFailed += 1;
        const code = result.code ?? AUDIT_VERIFIER_UNKNOWN;
        errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
      }
    }

    const summary: DailyAuditChainVerifierRunSummary = {
      startedAt,
      completedAt: clock(),
      organizationCount: orgs.length,
      orgsVerified,
      orgsFailed,
      errorsByCode: Object.freeze({ ...errorsByCode }),
    };

    log.info("audit_chain_verifier.run.complete", {
      startedAt: summary.startedAt.toISOString(),
      completedAt: summary.completedAt.toISOString(),
      organizationCount: summary.organizationCount,
      orgsVerified: summary.orgsVerified,
      orgsFailed: summary.orgsFailed,
      errorsByCode: summary.errorsByCode,
    });

    return summary;
  }

  const scheduler = createDailyUtcScheduler({
    name: "audit-chain-verifier",
    utcHour,
    utcMinute,
    runJob: async () => {
      await runOnce();
    },
    logger: options.logger,
  });

  return {
    scheduler,
    start(): void {
      scheduler.start();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      await scheduler.stop();
    },
    runOnce,
  };
}
