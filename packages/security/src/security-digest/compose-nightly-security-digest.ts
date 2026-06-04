// Nightly security digest composer.
//
// Transport-agnostic by design: this module produces a structured
// `SecurityDigest` plus a `renderAsText()` helper. The production
// `DigestPublisher` (Resend → SECURITY_DIGEST_DAILY_V1 template) is
// wired at the worker boundary in
// `apps/worker/src/security/notification-channel-digest-publisher.ts`,
// and the script `scripts/security/send-nightly-security-digest.ts`
// prints the rendered body to stdout for manual operator use.
// Slack / Teams adapters can be added as sibling `DigestPublisher`
// implementations without touching this composer.
//
// Sections (one per concern, all opt-out via empty arrays):
//
//   1. Audit chain integrity status per org. Calls into the
//      configured verifier port.
//   2. Break-glass sessions opened in the last 24h. Pulls from the
//      `break_glass_session` table (via the BreakGlassClient port,
//      which currently still depends on the SCHEMA.md migration).
//   3. Failed login spike (placeholder). Wired against a Clerk events
//      port that returns an aggregate count per org; production
//      adapter lands with the Clerk webhook handler.
//   4. Outbox status — count of `OutboxStatus = "DEAD"` rows added
//      in the last 24h, per org.
//   5. Sentry error volume (placeholder). Wired against a future
//      Sentry-API adapter; the stub returns 0.
//   6. Pending access reviews due in the next 14 days — derived from
//      the date convention `evidence/access-reviews/<YYYY-Q#>/` and
//      the current quarter boundary.
//
// PHI invariant: the digest is non-PHI by construction. Each section
// produces counts + ids, never the underlying domain rows.

import type { Logger } from "../types/logger.js";

export type AuditChainStatus =
  | {
      readonly organizationId: string;
      readonly valid: true;
      readonly verifiedRows: number;
      readonly lastSeq: string | null;
    }
  | {
      readonly organizationId: string;
      readonly valid: false;
      readonly reason: string;
      readonly seq: string | null;
    };

export interface BreakGlassSessionEntry {
  readonly sessionId: string;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly ticketUrl: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly actionCount: number;
}

export interface FailedLoginSpikeEntry {
  readonly organizationId: string;
  readonly windowHours: number;
  readonly failedLoginCount: number;
  readonly threshold: number;
}

export interface OutboxStatusEntry {
  readonly organizationId: string;
  readonly deadCount: number;
}

export interface SentryStatusEntry {
  readonly project: string;
  readonly errorCount: number;
  readonly windowHours: number;
}

export interface AccessReviewDueEntry {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly quarterLabel: string;
  readonly dueAt: string;
  readonly daysUntilDue: number;
}

export interface SecurityDigest {
  readonly generatedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly auditChainStatuses: ReadonlyArray<AuditChainStatus>;
  readonly breakGlassSessions: ReadonlyArray<BreakGlassSessionEntry>;
  readonly failedLoginSpikes: ReadonlyArray<FailedLoginSpikeEntry>;
  readonly outboxStatuses: ReadonlyArray<OutboxStatusEntry>;
  readonly sentryStatus: SentryStatusEntry;
  readonly accessReviewsDue: ReadonlyArray<AccessReviewDueEntry>;
}

export interface AuditChainStatusProbe {
  /** Verify each organization's audit chain. Implementations short-circuit on first break per org. */
  verifyAllOrgs(args: { readonly logger: Logger }): Promise<ReadonlyArray<AuditChainStatus>>;
}

export interface BreakGlassSessionProbe {
  listOpenedInWindow(args: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<ReadonlyArray<BreakGlassSessionEntry>>;
}

export interface FailedLoginProbe {
  listSpikes(args: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<ReadonlyArray<FailedLoginSpikeEntry>>;
}

export interface OutboxStatusProbe {
  listDeadCounts(args: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<ReadonlyArray<OutboxStatusEntry>>;
}

export interface SentryStatusProbe {
  fetchErrorVolume(args: {
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<SentryStatusEntry>;
}

export interface AccessReviewCalendarProbe {
  listDueWithinDays(args: {
    readonly now: Date;
    readonly horizonDays: number;
  }): Promise<ReadonlyArray<AccessReviewDueEntry>>;
}

export interface DigestPublisher {
  publish(digest: SecurityDigest, rendered: string): Promise<{ readonly transportId: string }>;
}

export class InMemoryDigestPublisher implements DigestPublisher {
  public readonly published: Array<{ readonly digest: SecurityDigest; readonly rendered: string }> =
    [];

  public async publish(
    digest: SecurityDigest,
    rendered: string
  ): Promise<{ readonly transportId: string }> {
    this.published.push({ digest, rendered });
    return { transportId: `memory-${this.published.length}` };
  }
}

export interface ComposeDigestInput {
  readonly logger: Logger;
  readonly now: Date;
  readonly windowHours: number;
  readonly probes: {
    readonly auditChain: AuditChainStatusProbe;
    readonly breakGlass: BreakGlassSessionProbe;
    readonly failedLogins: FailedLoginProbe;
    readonly outbox: OutboxStatusProbe;
    readonly sentry: SentryStatusProbe;
    readonly accessReviewCalendar: AccessReviewCalendarProbe;
  };
  /** Look-ahead window for "access reviews due soon". Defaults to 14 days. */
  readonly accessReviewHorizonDays?: number;
}

export async function composeNightlySecurityDigest(
  input: ComposeDigestInput
): Promise<SecurityDigest> {
  const windowEnd = input.now;
  const windowStart = new Date(windowEnd.getTime() - input.windowHours * 60 * 60 * 1000);
  const horizonDays = input.accessReviewHorizonDays ?? 14;
  const log = input.logger.child({ component: "security-digest" });

  const [
    auditChainStatuses,
    breakGlassSessions,
    failedLoginSpikes,
    outboxStatuses,
    sentryStatus,
    accessReviewsDue,
  ] = await Promise.all([
    input.probes.auditChain.verifyAllOrgs({ logger: log }),
    input.probes.breakGlass.listOpenedInWindow({ windowStart, windowEnd }),
    input.probes.failedLogins.listSpikes({ windowStart, windowEnd }),
    input.probes.outbox.listDeadCounts({ windowStart, windowEnd }),
    input.probes.sentry.fetchErrorVolume({ windowStart, windowEnd }),
    input.probes.accessReviewCalendar.listDueWithinDays({
      now: windowEnd,
      horizonDays,
    }),
  ]);

  return {
    generatedAt: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    auditChainStatuses,
    breakGlassSessions,
    failedLoginSpikes,
    outboxStatuses,
    sentryStatus,
    accessReviewsDue,
  };
}

/**
 * Render the digest as a plain-text email body. Stable line order so
 * a reviewer can diff yesterday's digest against today's.
 */
export function renderDigestAsText(digest: SecurityDigest): string {
  const lines: string[] = [];
  lines.push(`Pharmax Nightly Security Digest`);
  lines.push(`Window: ${digest.windowStart} → ${digest.windowEnd}`);
  lines.push(`Generated: ${digest.generatedAt}`);
  lines.push("");

  lines.push(`-- Audit chain integrity (${digest.auditChainStatuses.length} orgs) --`);
  const broken = digest.auditChainStatuses.filter((s) => !s.valid);
  if (broken.length === 0) {
    lines.push(`  All chains verified clean.`);
  } else {
    for (const status of broken) {
      if (!status.valid) {
        lines.push(
          `  BROKEN org=${status.organizationId} seq=${status.seq ?? "<unknown>"} reason="${status.reason}"`
        );
      }
    }
  }
  lines.push("");

  lines.push(`-- Break-glass sessions opened (${digest.breakGlassSessions.length}) --`);
  if (digest.breakGlassSessions.length === 0) {
    lines.push(`  None.`);
  } else {
    for (const s of digest.breakGlassSessions) {
      lines.push(
        `  sessionId=${s.sessionId} requestedBy=${s.requestedByUserId} approvedBy=${s.approvedByUserId ?? "<none>"} actions=${s.actionCount} ticket=${s.ticketUrl}`
      );
    }
  }
  lines.push("");

  lines.push(`-- Failed-login spikes (${digest.failedLoginSpikes.length}) --`);
  if (digest.failedLoginSpikes.length === 0) {
    lines.push(`  None observed.`);
  } else {
    for (const s of digest.failedLoginSpikes) {
      lines.push(
        `  org=${s.organizationId} failed=${s.failedLoginCount} threshold=${s.threshold} window=${s.windowHours}h`
      );
    }
  }
  lines.push("");

  lines.push(`-- Outbox DEAD-row counts (${digest.outboxStatuses.length}) --`);
  if (digest.outboxStatuses.length === 0) {
    lines.push(`  No dead rows.`);
  } else {
    for (const s of digest.outboxStatuses) {
      lines.push(`  org=${s.organizationId} dead=${s.deadCount}`);
    }
  }
  lines.push("");

  lines.push(`-- Sentry --`);
  lines.push(
    `  project=${digest.sentryStatus.project} errors=${digest.sentryStatus.errorCount} window=${digest.sentryStatus.windowHours}h`
  );
  lines.push("");

  lines.push(`-- Access reviews due (${digest.accessReviewsDue.length}) --`);
  if (digest.accessReviewsDue.length === 0) {
    lines.push(`  None within horizon.`);
  } else {
    for (const r of digest.accessReviewsDue) {
      lines.push(
        `  org=${r.organizationSlug}/${r.organizationId} quarter=${r.quarterLabel} dueAt=${r.dueAt} daysUntilDue=${r.daysUntilDue}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export const SECURITY_DIGEST_RENDER_HELPER = renderDigestAsText;
