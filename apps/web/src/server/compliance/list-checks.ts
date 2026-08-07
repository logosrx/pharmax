// Automated check inventory for /ops/admin/compliance/checks.
//
// The filter vocabulary here is not just the outcome enum. "Disabled"
// and "never run" are their own states, because both are ways a check
// can stop producing evidence while the outcome column still reads
// PASS from whenever it last ran. A checks page that only filters by
// outcome hides exactly the two failure modes an auditor would ask
// about.

import "server-only";

import type {
  ComplianceCadence,
  ComplianceCheckOutcome,
  ComplianceCheckSeverity,
} from "@pharmax/database";

import { readCompliance } from "./read-context.js";

/** Filter vocabulary for the checks list, wider than the outcome enum. */
export type CheckListFilter =
  "ALL" | "ATTENTION" | "PASS" | "FAIL" | "ERROR" | "NEVER_RUN" | "DISABLED";

export const CHECK_LIST_FILTERS: ReadonlyArray<CheckListFilter> = [
  "ALL",
  "ATTENTION",
  "PASS",
  "FAIL",
  "ERROR",
  "NEVER_RUN",
  "DISABLED",
];

export function isCheckListFilter(value: string): value is CheckListFilter {
  return (CHECK_LIST_FILTERS as ReadonlyArray<string>).includes(value);
}

export interface CheckListRow {
  readonly checkId: string;
  readonly code: string;
  readonly title: string;
  readonly severity: ComplianceCheckSeverity;
  readonly cadence: ComplianceCadence;
  readonly enabled: boolean;
  readonly automated: boolean;
  readonly lastOutcome: ComplianceCheckOutcome | null;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date | null;
  readonly consecutiveFailureCount: number;
  readonly controlCodes: ReadonlyArray<string>;
  /** Non-null when an unexpired, unrevoked exception covers this. */
  readonly exceptionExpiresAt: Date | null;
}

export interface ListChecksResult {
  readonly rows: ReadonlyArray<CheckListRow>;
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function whereForFilter(filter: CheckListFilter): Record<string, unknown> {
  switch (filter) {
    case "ALL":
      return {};
    case "ATTENTION":
      return { enabled: true, lastOutcome: { in: ["FAIL", "ERROR"] } };
    case "PASS":
      return { enabled: true, lastOutcome: "PASS" };
    case "FAIL":
      return { enabled: true, lastOutcome: "FAIL" };
    case "ERROR":
      return { enabled: true, lastOutcome: "ERROR" };
    case "NEVER_RUN":
      return { enabled: true, lastRunAt: null };
    case "DISABLED":
      return { enabled: false };
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

export async function listComplianceChecks(options: {
  readonly filter?: CheckListFilter;
  readonly now: Date;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<ListChecksResult> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filter = options.filter ?? "ALL";

  return readCompliance("list-checks", async (tx) => {
    const rows = await tx.complianceCheck.findMany({
      where: whereForFilter(filter),
      select: {
        id: true,
        code: true,
        title: true,
        severity: true,
        cadence: true,
        enabled: true,
        automated: true,
        lastOutcome: true,
        lastRunAt: true,
        nextRunAt: true,
        consecutiveFailureCount: true,
        controls: { select: { control: { select: { code: true } } } },
        exceptions: {
          where: { revokedAt: null, expiresAt: { gt: options.now } },
          select: { expiresAt: true },
          orderBy: { expiresAt: "desc" },
          take: 1,
        },
      },
      orderBy: { code: "asc" },
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { code: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          checkId: r.id,
          code: r.code,
          title: r.title,
          severity: r.severity,
          cadence: r.cadence,
          enabled: r.enabled,
          automated: r.automated,
          lastOutcome: r.lastOutcome,
          lastRunAt: r.lastRunAt,
          nextRunAt: r.nextRunAt,
          consecutiveFailureCount: r.consecutiveFailureCount,
          controlCodes: Object.freeze(
            r.controls.map((c) => c.control.code).sort((a, b) => a.localeCompare(b))
          ),
          exceptionExpiresAt: r.exceptions[0]?.expiresAt ?? null,
        })
      ),
      nextCursor: hasMore ? (sliced[sliced.length - 1]?.code ?? null) : null,
    });
  });
}
