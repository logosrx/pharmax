// Shared types for the reporting domain.
//
// A `ReportDefinition` is the static metadata that describes a
// runnable report: stable id, version, parameter schema, and the
// pure async `run` function. Future slices will register
// definitions in a `report_definition` table and persist execution
// records in `report_run`; this initial slice keeps both inputs
// and outputs in-memory so the patterns are set without paying
// schema cost up front.
//
// Why pure functions instead of classes:
//
//   - Trivially testable — feed a stub Prisma client + fixed args,
//     assert the output shape. No bus, no tenancy, no clock unless
//     the report actually needs them.
//
//   - Composable — a future "scheduled report" runner just maps a
//     `ReportRunRequest` over the registry; no inheritance gymnastics.
//
//   - Forward-compatible — when persistence lands, the same
//     definition shape becomes the row schema; no rewrites.
//
// Tenancy: every report MUST scope by `organizationId`. The
// `run` function receives a `ReportRunContext` with the resolved
// org id; passing `null`/`undefined` is a programmer error.

import type { PrismaClient } from "@pharmax/database";
import type { ZodTypeAny, z } from "zod";

/**
 * Runtime context handed to every report's `run` function.
 *
 * `client` is the standard PrismaClient — reports run as
 * read-only queries against the live transactional tables. Heavy
 * analytics that would degrade OLTP move to a reporting replica
 * (see Phase 6: read-replica routing), at which point
 * `ReportRunContext.client` becomes the replica handle.
 */
export interface ReportRunContext {
  readonly client: PrismaClient;
  /** Tenant scope. Every report query must include this. */
  readonly organizationId: string;
  /**
   * Optional clinic narrow for per-clinic dashboards. When
   * undefined, the report aggregates across every clinic in the
   * org.
   */
  readonly clinicId?: string;
  /**
   * "As of" timestamp — most reports use this as the upper bound
   * of their date-range filter. Defaults to "now" if unset by the
   * caller.
   */
  readonly asOf?: Date;
}

/**
 * Declarative description of a runnable report. Generic over the
 * Zod parameter schema and the output row shape.
 *
 * Convention:
 *   - `id` is a stable kebab-case identifier (`order-volume-by-stage`),
 *     used as the row key in future `report_run` tables.
 *   - `version` is a semver-style integer; increment when the
 *     output shape changes in a non-backward-compatible way.
 *   - `parametersSchema` is the Zod schema for caller-supplied
 *     parameters (date range, filters, etc.). Defaults belong on
 *     the schema, not in the `run` function.
 *   - `run` is a pure async function: same inputs → same outputs
 *     (modulo the underlying data). MUST NOT mutate; MUST scope
 *     by `organizationId`.
 */
export interface ReportDefinition<TParamsSchema extends ZodTypeAny, TRow extends object> {
  readonly id: string;
  readonly version: number;
  /** Operator-facing label (for the reports list UI). */
  readonly title: string;
  /** Operator-facing one-line description. */
  readonly description: string;
  readonly parametersSchema: TParamsSchema;
  readonly run: (
    ctx: ReportRunContext,
    params: z.infer<TParamsSchema>
  ) => Promise<ReportResult<TRow>>;
}

/**
 * Standard report result envelope. The `rows` array is the
 * primary payload; aggregates surface totals + grouping helpers
 * the UI uses to render summary tiles without re-scanning the
 * row set.
 */
export interface ReportResult<TRow extends object> {
  readonly rows: ReadonlyArray<TRow>;
  /**
   * Aggregate counters relevant to the report. Free-form so each
   * report can publish its own (e.g. `totalCount`, `totalAmountCents`).
   */
  readonly aggregates: Readonly<Record<string, number>>;
  /** Resolved query window for traceability + audit. */
  readonly window: { readonly from: Date; readonly to: Date };
  readonly generatedAt: Date;
}

/** Shared parameter schema fragment for date-range filters. */
export interface DateRangeParams {
  readonly from: Date;
  readonly to: Date;
}
