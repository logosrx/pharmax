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
    const code = cause instanceof errors.PharmaxError ? cause.code : "PATIENT_VIEW_AUDIT_FAILED";
    const message =
      cause instanceof errors.PharmaxError
        ? cause.message
        : "Failed to record PHI view audit; refusing to render patient data.";
    logger.error("ops.patient.view.audit_failed", {
      event: "ops.patient.view.audit_failed",
      operatorUserId: input.operatorUserId,
      patientId: input.patientId,
      orderId: input.orderId ?? null,
      code,
    });
    return { ok: false, code, message };
  }
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
 * Returns the patient ids whose audit failed; the caller decides
 * whether to render those rows or hide them. The conservative
 * choice is to hide ("every PHI display has an audit row" is
 * load-bearing); the practical choice for search is to show a
 * partial-audit warning banner and render the successful rows.
 * This helper does NOT make that choice — it just reports.
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
