// Probe: no events have been abandoned in the outbox.
//
// The outbox is how a committed transaction's side effects actually
// happen — shipment notifications, billing events, tracking updates.
// A DEAD row is an effect the platform promised and never delivered.
// Because the promise was kept in the database (the order shipped),
// nothing in the operational UI looks wrong; the clinic simply never
// gets the notification and the invoice line never appears.
//
// This is a processing-integrity control, and it is the reason ANY
// dead letter fails rather than some tolerance above zero. A
// threshold would mean choosing a number of silently dropped
// side effects that is acceptable, and there isn't one. Volume still
// matters for triage, so the count and the affected event types both
// land in `details`.
//
// FAILED (retryable, will be picked up again) is not a finding —
// only DEAD, which the drain has given up on.

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";
import type { ComplianceFinding } from "../../types.js";

/** Cap on findings enumerated per tenant, so one bad deploy cannot
 *  write a multi-megabyte JSONB row. The true count is always in
 *  `details.deadEventCount`. */
const MAX_ENUMERATED_FINDINGS = 25;

export const outboxDeadLetterBacklogCheck = defineCheck({
  code: "integrity.outbox.dead_letter_backlog",
  title: "No abandoned outbox events",
  description:
    "For each active organization, event_outbox must hold no rows in status DEAD. " +
    "A dead letter is a side effect the platform committed to and never delivered, " +
    "invisible in the operational UI because the transaction itself succeeded. " +
    "FAILED rows are excluded — those are still retryable.",
  severity: "HIGH",
  cadence: "CONTINUOUS",
  intervalMinutes: 60,
  controlCodes: ["PI1.4-1"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const [deadCount, sample] = await Promise.all([
        ctx.prisma.eventOutbox.count({
          where: { organizationId: org.id, status: "DEAD" },
        }),
        ctx.prisma.eventOutbox.findMany({
          where: { organizationId: org.id, status: "DEAD" },
          select: { id: true, eventType: true, attempts: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take: MAX_ENUMERATED_FINDINGS,
        }),
      ]);

      // `lastError` is deliberately not selected. It is free text
      // produced by arbitrary handlers, and a handler that
      // interpolated an order or patient identifier into its message
      // would leak it into an evidence row that leaves the tenant
      // boundary in digest emails.
      const findings: ComplianceFinding[] = sample.map((row) => ({
        subject: `event_outbox:${row.id}`,
        detail:
          `${row.eventType} abandoned after ${row.attempts} attempt(s); ` +
          `enqueued ${row.createdAt.toISOString()}.`,
      }));

      const eventTypeCounts = sample.reduce<Record<string, number>>((acc, row) => {
        acc[row.eventType] = (acc[row.eventType] ?? 0) + 1;
        return acc;
      }, {});

      return {
        outcome: deadCount === 0 ? "PASS" : "FAIL",
        summary: `${org.slug}: ${deadCount} abandoned (DEAD) outbox event(s).`,
        findings,
        details: {
          organizationSlug: org.slug,
          deadEventCount: deadCount,
          enumeratedFindingCount: findings.length,
          findingsTruncated: deadCount > findings.length,
          sampledEventTypeCounts: eventTypeCounts,
        },
      };
    }),
});
