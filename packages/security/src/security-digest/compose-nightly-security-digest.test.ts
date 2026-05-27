import { describe, expect, it } from "vitest";

import type { Logger } from "../types/logger.js";

import {
  InMemoryDigestPublisher,
  composeNightlySecurityDigest,
  renderDigestAsText,
  type AccessReviewDueEntry,
  type AuditChainStatus,
  type BreakGlassSessionEntry,
  type ComposeDigestInput,
  type FailedLoginSpikeEntry,
  type OutboxStatusEntry,
  type SentryStatusEntry,
} from "./compose-nightly-security-digest.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const NOW = new Date("2026-05-25T02:00:00.000Z");

function buildProbes(opts: {
  auditChainStatuses?: ReadonlyArray<AuditChainStatus>;
  breakGlassSessions?: ReadonlyArray<BreakGlassSessionEntry>;
  failedLoginSpikes?: ReadonlyArray<FailedLoginSpikeEntry>;
  outboxStatuses?: ReadonlyArray<OutboxStatusEntry>;
  sentryStatus?: SentryStatusEntry;
  accessReviewsDue?: ReadonlyArray<AccessReviewDueEntry>;
}): ComposeDigestInput["probes"] {
  return {
    auditChain: {
      async verifyAllOrgs() {
        return opts.auditChainStatuses ?? [];
      },
    },
    breakGlass: {
      async listOpenedInWindow() {
        return opts.breakGlassSessions ?? [];
      },
    },
    failedLogins: {
      async listSpikes() {
        return opts.failedLoginSpikes ?? [];
      },
    },
    outbox: {
      async listDeadCounts() {
        return opts.outboxStatuses ?? [];
      },
    },
    sentry: {
      async fetchErrorVolume() {
        return (
          opts.sentryStatus ?? {
            project: "pharmacy-os",
            errorCount: 0,
            windowHours: 24,
          }
        );
      },
    },
    accessReviewCalendar: {
      async listDueWithinDays() {
        return opts.accessReviewsDue ?? [];
      },
    },
  };
}

describe("composeNightlySecurityDigest", () => {
  it("returns a clean digest when nothing of interest happened in the window", async () => {
    const digest = await composeNightlySecurityDigest({
      logger: noopLogger,
      now: NOW,
      windowHours: 24,
      probes: buildProbes({}),
    });
    expect(digest.windowEnd).toBe(NOW.toISOString());
    expect(digest.windowStart).toBe(new Date(NOW.getTime() - 86_400_000).toISOString());
    expect(digest.auditChainStatuses).toHaveLength(0);
    expect(digest.breakGlassSessions).toHaveLength(0);
    expect(digest.sentryStatus.errorCount).toBe(0);
  });

  it("aggregates findings from every probe in parallel", async () => {
    const digest = await composeNightlySecurityDigest({
      logger: noopLogger,
      now: NOW,
      windowHours: 24,
      probes: buildProbes({
        auditChainStatuses: [
          { organizationId: "org-a", valid: true, verifiedRows: 12, lastSeq: "12" },
          {
            organizationId: "org-b",
            valid: false,
            reason: "entryHash mismatch",
            seq: "47",
          },
        ],
        breakGlassSessions: [
          {
            sessionId: "s-1",
            requestedByUserId: "u-1",
            approvedByUserId: "u-2",
            ticketUrl: "https://tickets/INC-1",
            openedAt: NOW.toISOString(),
            closedAt: null,
            actionCount: 3,
          },
        ],
        outboxStatuses: [{ organizationId: "org-a", deadCount: 2 }],
      }),
    });

    expect(digest.auditChainStatuses).toHaveLength(2);
    expect(digest.breakGlassSessions).toHaveLength(1);
    expect(digest.outboxStatuses[0]?.deadCount).toBe(2);
  });

  it("renderDigestAsText produces a stable, line-oriented body", async () => {
    const digest = await composeNightlySecurityDigest({
      logger: noopLogger,
      now: NOW,
      windowHours: 24,
      probes: buildProbes({
        auditChainStatuses: [
          {
            organizationId: "org-b",
            valid: false,
            reason: "entryHash mismatch",
            seq: "47",
          },
        ],
        breakGlassSessions: [
          {
            sessionId: "s-1",
            requestedByUserId: "u-1",
            approvedByUserId: "u-2",
            ticketUrl: "https://tickets/INC-1",
            openedAt: NOW.toISOString(),
            closedAt: null,
            actionCount: 3,
          },
        ],
        outboxStatuses: [{ organizationId: "org-a", deadCount: 2 }],
      }),
    });
    const text = renderDigestAsText(digest);
    expect(text).toContain("Pharmax Nightly Security Digest");
    expect(text).toContain("BROKEN org=org-b seq=47");
    expect(text).toContain("sessionId=s-1 requestedBy=u-1");
    expect(text).toContain("org=org-a dead=2");
  });
});

describe("InMemoryDigestPublisher", () => {
  it("captures every published digest for inspection in tests", async () => {
    const publisher = new InMemoryDigestPublisher();
    const digest = await composeNightlySecurityDigest({
      logger: noopLogger,
      now: NOW,
      windowHours: 24,
      probes: buildProbes({}),
    });
    const rendered = renderDigestAsText(digest);
    const { transportId } = await publisher.publish(digest, rendered);
    expect(transportId).toBe("memory-1");
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.rendered).toBe(rendered);
  });
});
