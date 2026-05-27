// Access-activity aggregator.
//
// Walks `command_log` and `audit_log` for one org over one quarter
// and emits aggregate (count-only) records suitable for the
// access-review JSONL evidence artifact. The aggregates feed
// anomaly detection ("a Pharmacist who suddenly approved 50
// invoices") without exposing per-row payloads.
//
// PHI invariant: every read here is aggregate-only. We never
// SELECT the JSON payloads of command_log / audit_log; we
// SELECT name + actor + status and run `COUNT(*) GROUP BY`. The
// PHI-redaction guarantees of those tables are belt-and-braces;
// this layer is the second belt.
//
// Tenancy: every query is wrapped in `withSystemContext` because
// the access review is a cross-org administrative function.
// `withSystemContext` is the standard escape hatch for non-
// tenant-scoped reads against tenant-scoped tables and is itself
// logged by `@pharmax/tenancy` for the auditor's trail.

import type { PrismaClient } from "@pharmax/database";
import { withSystemContext } from "@pharmax/tenancy";

/** One row of `(command_name, actor_user_id, count)` for the period. */
export interface CommandCountByActor {
  readonly commandName: string;
  readonly actorUserId: string | null;
  readonly count: number;
  readonly successes: number;
  readonly failures: number;
}

/** One row of `(action, actor_user_id, count)`. */
export interface AuditCountByActor {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly count: number;
}

export interface AccessActivityAggregate {
  readonly organizationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly commandCounts: ReadonlyArray<CommandCountByActor>;
  readonly auditCounts: ReadonlyArray<AuditCountByActor>;
  readonly totals: {
    readonly commandRows: number;
    readonly auditRows: number;
    readonly distinctOperators: number;
  };
}

export interface AccessActivityClient {
  groupCommandLogByActor(args: {
    readonly organizationId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<ReadonlyArray<CommandCountByActor>>;

  groupAuditLogByActor(args: {
    readonly organizationId: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  }): Promise<ReadonlyArray<AuditCountByActor>>;
}

/**
 * Production client: Prisma-backed, wrapped in `withSystemContext`
 * because the review is system-level by definition. Uses
 * `groupBy` so we never materialize per-row payloads in memory.
 */
export function createPrismaAccessActivityClient(prisma: PrismaClient): AccessActivityClient {
  return {
    async groupCommandLogByActor({ organizationId, periodStart, periodEnd }) {
      const rows = await withSystemContext("compliance:access-review:groupCommandLog", () =>
        prisma.commandLog.groupBy({
          by: ["commandName", "actorUserId", "status"],
          where: {
            organizationId,
            startedAt: { gte: periodStart, lt: periodEnd },
          },
          _count: { _all: true },
        })
      );
      // Collapse the (commandName, actorUserId) bucket across
      // statuses so the output is one row per (command, actor)
      // plus a breakdown of successes/failures. The public type's
      // counters are readonly; we accumulate into a mutable shape and
      // emit immutable snapshots in the return.
      interface MutableCommandCount {
        commandName: string;
        actorUserId: string | null;
        count: number;
        successes: number;
        failures: number;
      }
      const map = new Map<string, MutableCommandCount>();
      for (const row of rows) {
        const key = `${row.commandName}::${row.actorUserId ?? "<null>"}`;
        const prev = map.get(key) ?? {
          commandName: row.commandName,
          actorUserId: row.actorUserId,
          count: 0,
          successes: 0,
          failures: 0,
        };
        const n = row._count._all;
        prev.count += n;
        if (row.status === "SUCCEEDED") {
          prev.successes += n;
        } else if (row.status === "FAILED") {
          prev.failures += n;
        }
        map.set(key, prev);
      }
      const snapshots: CommandCountByActor[] = [...map.values()].map((m) => ({
        commandName: m.commandName,
        actorUserId: m.actorUserId,
        count: m.count,
        successes: m.successes,
        failures: m.failures,
      }));
      return snapshots.sort(sortByCommandAndActor);
    },
    async groupAuditLogByActor({ organizationId, periodStart, periodEnd }) {
      const rows = await withSystemContext("compliance:access-review:groupAuditLog", () =>
        prisma.auditLog.groupBy({
          by: ["action", "actorUserId"],
          where: {
            organizationId,
            occurredAt: { gte: periodStart, lt: periodEnd },
          },
          _count: { _all: true },
        })
      );
      return rows
        .map((row) => ({
          action: row.action,
          actorUserId: row.actorUserId,
          count: row._count._all,
        }))
        .sort(sortByActionAndActor);
    },
  };
}

export async function aggregateAccessActivity(args: {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly client: AccessActivityClient;
}): Promise<AccessActivityAggregate> {
  const [commandCounts, auditCounts] = await Promise.all([
    args.client.groupCommandLogByActor(args),
    args.client.groupAuditLogByActor(args),
  ]);
  const actorSet = new Set<string>();
  let commandRows = 0;
  for (const c of commandCounts) {
    commandRows += c.count;
    if (c.actorUserId !== null) actorSet.add(c.actorUserId);
  }
  let auditRows = 0;
  for (const a of auditCounts) {
    auditRows += a.count;
    if (a.actorUserId !== null) actorSet.add(a.actorUserId);
  }
  return {
    organizationId: args.organizationId,
    periodStart: args.periodStart.toISOString(),
    periodEnd: args.periodEnd.toISOString(),
    commandCounts,
    auditCounts,
    totals: {
      commandRows,
      auditRows,
      distinctOperators: actorSet.size,
    },
  };
}

function sortByCommandAndActor(a: CommandCountByActor, b: CommandCountByActor): number {
  if (a.commandName !== b.commandName) return a.commandName.localeCompare(b.commandName);
  return (a.actorUserId ?? "").localeCompare(b.actorUserId ?? "");
}

function sortByActionAndActor(a: AuditCountByActor, b: AuditCountByActor): number {
  if (a.action !== b.action) return a.action.localeCompare(b.action);
  return (a.actorUserId ?? "").localeCompare(b.actorUserId ?? "");
}
