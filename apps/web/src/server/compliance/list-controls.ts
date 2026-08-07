// Control inventory list for /ops/admin/compliance/controls.
//
// Ordered and paginated by `code` rather than `createdAt`: the code is
// unique, it is the identifier auditors and engineers both use, and
// ordering by it groups a criterion family together (every CC6.x lands
// beside its siblings) instead of scattering controls by insert order.
// That also makes the cursor stable across re-seeds, which reordering
// by a timestamp would not be.

import "server-only";

import type {
  ComplianceCadence,
  ComplianceCheckOutcome,
  ComplianceControlStatus,
} from "@pharmax/database";

import { readCompliance } from "./read-context.js";

export interface ControlListRow {
  readonly controlId: string;
  readonly code: string;
  readonly title: string;
  readonly ownerRole: string;
  readonly status: ComplianceControlStatus;
  readonly cadence: ComplianceCadence;
  readonly criterionCount: number;
  readonly checkCount: number;
  /**
   * Worst outcome across the control's checks, or null when it has
   * none. "No check" and "all checks pass" are different claims and
   * the list must not render them identically — an unevidenced
   * control that looks green is the single most misleading thing a
   * compliance dashboard can show.
   */
  readonly worstCheckOutcome: ComplianceCheckOutcome | null;
  readonly openTaskCount: number;
  readonly lastSignedOffAt: Date | null;
}

export interface ListControlsResult {
  readonly rows: ReadonlyArray<ControlListRow>;
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Worst-first, so a single FAIL dominates a control's summary. */
const OUTCOME_RANK: Readonly<Record<ComplianceCheckOutcome, number>> = {
  FAIL: 0,
  ERROR: 1,
  NOT_APPLICABLE: 2,
  PASS: 3,
};

function worstOutcome(
  outcomes: ReadonlyArray<ComplianceCheckOutcome | null>
): ComplianceCheckOutcome | null {
  let worst: ComplianceCheckOutcome | null = null;
  for (const outcome of outcomes) {
    if (outcome === null) continue;
    if (worst === null || OUTCOME_RANK[outcome] < OUTCOME_RANK[worst]) worst = outcome;
  }
  return worst;
}

export async function listComplianceControls(options: {
  readonly status?: ComplianceControlStatus;
  readonly ownerRole?: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<ListControlsResult> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  return readCompliance("list-controls", async (tx) => {
    const rows = await tx.complianceControl.findMany({
      where: {
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.ownerRole !== undefined ? { ownerRole: options.ownerRole } : {}),
      },
      select: {
        id: true,
        code: true,
        title: true,
        ownerRole: true,
        status: true,
        cadence: true,
        lastSignedOffAt: true,
        _count: { select: { criteria: true } },
        checks: { select: { check: { select: { lastOutcome: true, enabled: true } } } },
        tasks: {
          where: { status: { in: ["OPEN", "IN_PROGRESS", "BLOCKED"] } },
          select: { id: true },
        },
      },
      orderBy: { code: "asc" },
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { code: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;

    return Object.freeze({
      rows: sliced.map((r) => {
        // Disabled checks are excluded from the rollup: a check an
        // operator switched off evidences nothing, and letting its
        // last PASS keep a control green is exactly how a kill-switch
        // becomes a way to fake compliance.
        const live = r.checks.filter((c) => c.check.enabled);
        return Object.freeze({
          controlId: r.id,
          code: r.code,
          title: r.title,
          ownerRole: r.ownerRole,
          status: r.status,
          cadence: r.cadence,
          criterionCount: r._count.criteria,
          checkCount: live.length,
          worstCheckOutcome: worstOutcome(live.map((c) => c.check.lastOutcome)),
          openTaskCount: r.tasks.length,
          lastSignedOffAt: r.lastSignedOffAt,
        });
      }),
      nextCursor: hasMore ? (sliced[sliced.length - 1]?.code ?? null) : null,
    });
  });
}

/** Distinct owner roles, for the list's filter control. */
export async function listControlOwnerRoles(): Promise<ReadonlyArray<string>> {
  return readCompliance("list-control-owner-roles", async (tx) => {
    const rows = await tx.complianceControl.findMany({
      distinct: ["ownerRole"],
      select: { ownerRole: true },
      orderBy: { ownerRole: "asc" },
    });
    return Object.freeze(rows.map((r) => r.ownerRole));
  });
}
