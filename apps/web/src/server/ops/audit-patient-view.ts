// Server-side helper for dispatching ViewPatient from a server
// component (page render path).
//
// `dispatchOpsCommand` is for HTTP routes — it does session
// resolution + bus dispatch + HTTP redirect, all wrapped together.
// Pages can't redirect from inside a render; they need a different
// shape that simply: enters tenancy → executes the command →
// returns the result (success or typed failure).
//
// This helper is intentionally narrow: it ONLY handles ViewPatient
// because (a) it's the only read-path audit command today, and
// (b) the idempotency-key shape is specific to "this operator
// viewed this patient within this minute window".

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import { ViewPatient, type ViewPatientOutput, type ViewPatientSurface } from "@pharmax/patients";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { logger } from "../logger.js";
import { withSentryOpsScope } from "../observability/ops-scope.js";

export type AuditPatientViewResult =
  | { readonly ok: true; readonly output: ViewPatientOutput }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

/**
 * Audit a single PHI view. Used by detail pages where exactly
 * one patient is rendered.
 *
 * For search result lists rendering N patients, callers should
 * use `auditPatientViewsBatch` below — it fans out via Promise.all
 * with per-patient idempotency keys so a refresh-spamming
 * operator only writes one audit row per (patient, minute).
 */
export async function auditPatientView(input: {
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly patientId: string;
  readonly surface: ViewPatientSurface;
  readonly orderId?: string;
  readonly phiDecryptErrors: boolean;
}): Promise<AuditPatientViewResult> {
  // Minute-bucketed idempotency key: an operator refreshing the
  // same page 50 times in one minute writes ONE audit row. A
  // genuinely-separate view 2 minutes later writes a NEW row.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = [
    "page:view-patient",
    input.operatorUserId,
    input.patientId,
    input.orderId ?? "no-order",
    String(minuteBucket),
  ].join(":");

  const tenancy = buildTenancyContext({
    organizationId: input.organizationId,
    actor: { userId: input.operatorUserId, correlationId: ids.generateUlid() },
  });

  return await withSentryOpsScope(
    {
      operatorUserId: input.operatorUserId,
      organizationId: input.organizationId,
      commandName: "ViewPatient",
      surface: input.surface,
      route: "page:view-patient",
    },
    async () => {
      try {
        const output = await withTenancyContext(tenancy, () =>
          executeCommand(
            ViewPatient,
            {
              patientId: input.patientId,
              surface: input.surface,
              phiDecryptErrors: input.phiDecryptErrors,
              ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
            },
            { idempotencyKey }
          )
        );
        return { ok: true, output };
      } catch (cause) {
        const code =
          cause instanceof errors.PharmaxError ? cause.code : "PATIENT_VIEW_AUDIT_FAILED";
        const message =
          cause instanceof errors.PharmaxError
            ? cause.message
            : "Failed to record PHI view audit; refusing to render patient data.";
        // Audit failure is a compliance regression — forward the
        // cause as `error` so Sentry captures the full stack with
        // operator + surface tags from the scope above.
        logger.error("ops.patient.view.audit_failed", {
          event: "ops.patient.view.audit_failed",
          operatorUserId: input.operatorUserId,
          patientId: input.patientId,
          orderId: input.orderId ?? null,
          surface: input.surface,
          code,
          error: cause,
        });
        return { ok: false, code, message };
      }
    }
  );
}

export interface BatchAuditPatientViewResult {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failedPatientIds: ReadonlyArray<string>;
}

/**
 * Audit a batch of PHI views in parallel. Used by search result
 * pages that render identifying fields for N patients in one
 * render. Each patient gets its own ViewPatient audit row + outbox
 * event — the SOC 2 reviewer can answer "did operator X see
 * patient Y's PHI on date D" for each visible patient, not just
 * "operator X ran a search and saw something".
 *
 * Per-patient idempotency keys (same minute-bucket shape as the
 * single helper) ensure a refresh-spamming operator writes ONE
 * row per (patient, minute), not N.
 *
 * Returns the patient ids whose audit failed. Callers MUST NOT
 * render identity for those patients: "every PHI display has an
 * audit row" is load-bearing, and an unauditable view is precisely
 * the view that should not happen — if the audit write is failing,
 * the thing that would have recorded the disclosure is down, which
 * is when a disclosure is least defensible after the fact. Pass the
 * result through `partitionAuditedPatients` and render only the
 * `visible` rows, with a banner naming the suppressed count (issue
 * #79 removed the older render-anyway-and-warn behaviour).
 */
export async function auditPatientViewsBatch(input: {
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly surface: ViewPatientSurface;
  readonly patients: ReadonlyArray<{
    readonly patientId: string;
    readonly phiDecryptErrors: boolean;
  }>;
}): Promise<BatchAuditPatientViewResult> {
  if (input.patients.length === 0) {
    return Object.freeze({ attempted: 0, succeeded: 0, failedPatientIds: [] });
  }
  const results = await Promise.all(
    input.patients.map((p) =>
      auditPatientView({
        organizationId: input.organizationId,
        operatorUserId: input.operatorUserId,
        patientId: p.patientId,
        surface: input.surface,
        phiDecryptErrors: p.phiDecryptErrors,
      })
    )
  );
  const failedPatientIds: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]!.ok) {
      failedPatientIds.push(input.patients[i]!.patientId);
    }
  }
  return Object.freeze({
    attempted: input.patients.length,
    succeeded: input.patients.length - failedPatientIds.length,
    failedPatientIds,
  });
}

export interface PartitionedAuditedPatients<T> {
  /** Rows whose `ViewPatient` audit is durably on record — the only rows a page may render. */
  readonly visible: ReadonlyArray<T>;
  /** How many rows were withheld because their audit failed. */
  readonly suppressedCount: number;
}

/**
 * Split search rows into the ones whose PHI view was audited and the
 * count that must be withheld.
 *
 * ONE function, used by every search surface, deliberately: the
 * failure issue #79 closed was not the render-anyway behaviour itself
 * but the DIVERGENCE — the same control enforced on the detail pages
 * and advisory on the search pages, with no principle distinguishing
 * them. A page that maps `results.rows` directly instead of `visible`
 * is reintroducing that divergence; there should be exactly one place
 * that decides what an audit failure withholds.
 *
 * A `null` batch means no audit was attempted (the search itself
 * failed or was never run) — there are no rows to protect, and the
 * caller renders none.
 */
export function partitionAuditedPatients<T extends { readonly patientId: string }>(
  rows: ReadonlyArray<T>,
  batch: BatchAuditPatientViewResult | null
): PartitionedAuditedPatients<T> {
  if (batch === null) {
    return Object.freeze({ visible: [], suppressedCount: rows.length });
  }
  if (batch.failedPatientIds.length === 0) {
    return Object.freeze({ visible: rows, suppressedCount: 0 });
  }
  const failed = new Set(batch.failedPatientIds);
  const visible = rows.filter((row) => !failed.has(row.patientId));
  return Object.freeze({ visible, suppressedCount: rows.length - visible.length });
}
