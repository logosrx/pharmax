// Nightly security digest loop, scheduled for 02:30 UTC (after the
// daily Merkle root signing job). Produces a structured `SecurityDigest`
// using the configured probes and renders it. Today the rendered body
// is logged at INFO; the production wiring will pass it to a real
// `DigestPublisher` (Resend/SES/Slack) — see `README.md` in this
// folder.

import type { PrismaClient } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import {
  InMemoryDigestPublisher,
  composeNightlySecurityDigest,
  renderDigestAsText,
  type AccessReviewCalendarProbe,
  type AuditChainStatusProbe,
  type BreakGlassSessionProbe,
  type DigestPublisher,
  type FailedLoginProbe,
  type OutboxStatusProbe,
  type SecurityDigest,
  type SentryStatusProbe,
} from "@pharmax/security";

import { createDailyUtcScheduler, type DailyUtcScheduler } from "./daily-utc-scheduler.js";
import { createWorkerDigestProbes } from "./digest-probes.js";

type Logger = loggerContract.Logger;

export interface NightlySecurityDigestLoopOptions {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Default 02:30 UTC. */
  readonly utcHour?: number;
  readonly utcMinute?: number;
  /** Override the publisher; default is in-memory + INFO log. */
  readonly publisher?: DigestPublisher;
  /** Override individual probes for tests. */
  readonly probes?: {
    readonly auditChain?: AuditChainStatusProbe;
    readonly breakGlass?: BreakGlassSessionProbe;
    readonly failedLogins?: FailedLoginProbe;
    readonly outbox?: OutboxStatusProbe;
    readonly sentry?: SentryStatusProbe;
    readonly accessReviewCalendar?: AccessReviewCalendarProbe;
  };
  /** Window length in hours. Defaults to 24. */
  readonly windowHours?: number;
}

export interface NightlySecurityDigestLoop {
  readonly scheduler: DailyUtcScheduler;
  start(): void;
  stop(): Promise<void>;
}

export function createNightlySecurityDigestLoop(
  options: NightlySecurityDigestLoopOptions
): NightlySecurityDigestLoop {
  const log = options.logger.child({ component: "nightly-security-digest" });
  const utcHour = options.utcHour ?? 2;
  const utcMinute = options.utcMinute ?? 30;
  const windowHours = options.windowHours ?? 24;
  const defaultProbes = createWorkerDigestProbes({ prisma: options.prisma });
  const probes = {
    auditChain: options.probes?.auditChain ?? defaultProbes.auditChain,
    breakGlass: options.probes?.breakGlass ?? defaultProbes.breakGlass,
    failedLogins: options.probes?.failedLogins ?? defaultProbes.failedLogins,
    outbox: options.probes?.outbox ?? defaultProbes.outbox,
    sentry: options.probes?.sentry ?? defaultProbes.sentry,
    accessReviewCalendar:
      options.probes?.accessReviewCalendar ?? defaultProbes.accessReviewCalendar,
  };
  const publisher: DigestPublisher = options.publisher ?? new InMemoryDigestPublisher();

  async function runJob(): Promise<void> {
    const digest: SecurityDigest = await composeNightlySecurityDigest({
      logger: log,
      now: new Date(),
      windowHours,
      probes,
    });
    const rendered = renderDigestAsText(digest);
    const result = await publisher.publish(digest, rendered);
    log.info("digest.published", {
      transportId: result.transportId,
      auditOrgs: digest.auditChainStatuses.length,
      brokenChains: digest.auditChainStatuses.filter((s) => !s.valid).length,
      breakGlassSessions: digest.breakGlassSessions.length,
      deadOutboxOrgs: digest.outboxStatuses.length,
    });
  }

  const scheduler = createDailyUtcScheduler({
    name: "nightly-security-digest",
    utcHour,
    utcMinute,
    runJob,
    logger: options.logger,
  });

  return {
    scheduler,
    start(): void {
      scheduler.start();
    },
    stop(): Promise<void> {
      return scheduler.stop();
    },
  };
}
