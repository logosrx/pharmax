// Probe: no command has been left mid-flight.
//
// The bus writes command_log with status RUNNING, executes the
// transaction, then updates to SUCCEEDED or FAILED. A row still
// RUNNING long afterwards means the process died between those two
// writes — a deploy mid-command, an OOM kill, a lost connection.
//
// Why that is a compliance finding and not just an ops curiosity:
// the workflow rules require that every critical transition writes
// command_log, order_event, audit_log, and event_outbox. A row stuck
// in RUNNING is a transition whose completeness nobody has
// established. Either it committed (and the log now misrepresents
// it) or it rolled back (and the log records an attempt that never
// happened). Both need a human to resolve, and neither resolves
// itself.
//
// The threshold is generous on purpose. Commands are interactive and
// finish in milliseconds; anything still RUNNING after 30 minutes is
// not slow, it is orphaned. A tighter bound would flag the deploy
// window and train the team to ignore the alert.

import { defineCheck } from "../define-check.js";
import { forEachActiveOrganization } from "../per-organization.js";
import type { ComplianceFinding } from "../../types.js";

export const STUCK_COMMAND_THRESHOLD_MINUTES = 30;

const MAX_ENUMERATED_FINDINGS = 25;

export const commandLogStuckRunningCheck = defineCheck({
  code: "integrity.command_log.stuck_running",
  title: "No commands orphaned in RUNNING",
  description:
    `For each active organization, no command_log row may remain in status RUNNING ` +
    `for more than ${STUCK_COMMAND_THRESHOLD_MINUTES} minutes. Such a row means the ` +
    `process died between the RUNNING write and the terminal write, leaving a ` +
    `workflow transition whose completeness has never been established.`,
  severity: "MEDIUM",
  cadence: "CONTINUOUS",
  intervalMinutes: 60,
  controlCodes: ["PI1.3-1"],
  evaluate: async (ctx) =>
    forEachActiveOrganization(ctx, async (org) => {
      const cutoff = new Date(ctx.clock.now().getTime() - STUCK_COMMAND_THRESHOLD_MINUTES * 60_000);

      const where = {
        organizationId: org.id,
        status: "RUNNING" as const,
        startedAt: { lt: cutoff },
      };

      const [stuckCount, sample] = await Promise.all([
        ctx.prisma.commandLog.count({ where }),
        ctx.prisma.commandLog.findMany({
          where,
          // requestPayload is never selected: it is redacted for logs
          // but still describes a real operation, and this row is
          // exported as evidence.
          select: { id: true, commandName: true, startedAt: true },
          orderBy: { startedAt: "asc" },
          take: MAX_ENUMERATED_FINDINGS,
        }),
      ]);

      const now = ctx.clock.now();
      const findings: ComplianceFinding[] = sample.map((row) => ({
        subject: `command_log:${row.id}`,
        detail:
          `${row.commandName} has been RUNNING for ` +
          `${Math.floor((now.getTime() - row.startedAt.getTime()) / 60_000)} minute(s).`,
      }));

      return {
        outcome: stuckCount === 0 ? "PASS" : "FAIL",
        summary:
          `${org.slug}: ${stuckCount} command(s) stuck in RUNNING beyond ` +
          `${STUCK_COMMAND_THRESHOLD_MINUTES} minutes.`,
        findings,
        details: {
          organizationSlug: org.slug,
          stuckCommandCount: stuckCount,
          enumeratedFindingCount: findings.length,
          findingsTruncated: stuckCount > findings.length,
          thresholdMinutes: STUCK_COMMAND_THRESHOLD_MINUTES,
          cutoffAt: cutoff.toISOString(),
        },
      };
    }),
});
