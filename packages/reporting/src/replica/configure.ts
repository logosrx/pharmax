// Report read-scope routing.
//
// `RunReport` reads a report's row set then writes a `report_run`
// row + audit + outbox. Those WRITES must stay on the command's
// primary transaction (atomic with the audit chain). The READ,
// however, can be offloaded to a replica so heavy analytical scans
// don't compete with live workflow transactions on the primary.
//
// This module is the seam: a configurable `ReportReadScope` that,
// when wired (app boot), runs the report read on a dedicated
// tenant-scoped connection (a `@pharmax/database` replica-backed
// scope). When NOT wired, `RunReport` falls back to reading on the
// command transaction `tx` — identical to the pre-replica behavior,
// so the no-replica path (and every existing test) is unchanged.
//
// Why a port here instead of importing `@pharmax/database`'s
// `readReportingInOrgScope` directly: keeps `@pharmax/reporting`
// free of a hard binding to the replica machinery (tests inject a
// trivial scope; the apps wire the real one), and keeps the
// reporting package's dependency surface minimal.
//
// The callback client is typed `unknown` because the report's
// `run` already receives a `PrismaClient`-shaped client and casts
// at the boundary (same `tx as unknown as ...` pattern the command
// used before). The scope only needs to hand back SOMETHING the
// report can query; the report definition owns the read shape.

import { errors, runtime } from "@pharmax/platform-core";

export interface ReportReadScope {
  /** True when the scope routes to a dedicated replica (vs. the
   *  primary). Surfaced in boot logs / diagnostics only. */
  readonly usingReplica: boolean;
  /**
   * Run `fn` with a tenant-scoped read client for `organizationId`.
   * The implementation establishes both the ORM tenancy frame and
   * the RLS GUC (same dual-layer guarantee as a primary read).
   */
  read<T>(organizationId: string, fn: (client: unknown) => Promise<T>): Promise<T>;
}

export const REPORTING_READ_SCOPE_ALREADY_CONFIGURED =
  "REPORTING_READ_SCOPE_ALREADY_CONFIGURED" as const;

// globalThis-backed so boot (Next instrumentation bundle) and use
// (route bundles) share ONE configuration despite webpack giving each
// bundle its own copy of this module. See platform-core
// runtime/global-singleton.ts for the full rationale.
const box = runtime.globalSingletonBox<ReportReadScope>("pharmax:reporting:read-scope");

/**
 * Wire the report read scope. Idempotent re-call with the same
 * instance is a no-op; a DIFFERENT instance throws (only the test
 * harness swaps, via the reset helper).
 */
export function configureReportReadScope(scope: ReportReadScope): void {
  if (box.value !== null && box.value !== scope) {
    throw new errors.InvariantViolationError({
      code: REPORTING_READ_SCOPE_ALREADY_CONFIGURED,
      message:
        "configureReportReadScope was called with a different scope instance; only the test harness may swap.",
    });
  }
  box.value = scope;
}

/**
 * Resolve the configured read scope, or `null` when none is wired.
 * `RunReport` treats null as "read on the command tx" (pre-replica
 * behavior).
 */
export function getReportReadScope(): ReportReadScope | null {
  return box.value;
}

/** Test-only: drop the wired scope. */
export function resetReportReadScopeConfigurationForTests(): void {
  box.value = null;
}
