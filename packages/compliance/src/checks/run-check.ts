// runComplianceCheck — executes one probe and converts what happened
// into `compliance_check_run` rows.
//
// This function owns the two states a probe is not allowed to report
// about itself, and both matter more than they look:
//
//   ERROR — `evaluate` threw. The control's status is UNKNOWN, not
//   satisfied. Recording a thrown probe as PASS is the single worst
//   bug this module could have: it would let an expired AWS
//   credential silently manufacture evidence of compliance for as
//   long as nobody looked. Recording it as FAIL would be almost as
//   bad in the other direction, burying real failures under
//   infrastructure noise until the team learns to ignore the alert.
//
//   ERROR on an empty return — a probe that produces no verdict has
//   a bug (an early return, an empty org list where one was
//   expected). Persisting nothing would render as "no findings",
//   which reads exactly like a pass on every dashboard.
//
// Persistence is the caller's job. Returning records instead of
// writing them keeps this logic pure and lets the tests assert on
// digests and outcomes without a database.

import { canonicalStringify } from "@pharmax/command-bus";
import { createHash } from "node:crypto";

import type {
  ComplianceCheckContext,
  ComplianceCheckDefinition,
  ComplianceCheckRunRecord,
  ComplianceJsonValue,
  ComplianceVerdict,
} from "../types.js";

export const COMPLIANCE_PROBE_THREW = "COMPLIANCE_PROBE_THREW";
export const COMPLIANCE_PROBE_RETURNED_NO_VERDICTS = "COMPLIANCE_PROBE_RETURNED_NO_VERDICTS";

/** Current shape version of the persisted `details` payload. */
export const COMPLIANCE_DETAILS_VERSION = 1;

/**
 * Canonical (sorted-key) SHA-256 of a details payload, hex-encoded.
 *
 * Reuses the command bus's `canonicalStringify` so a compliance
 * digest is computed exactly the way an idempotency-key hash and an
 * access-review digest are. An auditor who exports the JSON can
 * recompute this and confirm the row was not altered — which is the
 * whole point of storing it next to an append-only table.
 */
export function computeComplianceDigest(details: unknown): string {
  return createHash("sha256").update(canonicalStringify(details)).digest("hex");
}

export async function runComplianceCheck(
  definition: ComplianceCheckDefinition,
  ctx: ComplianceCheckContext
): Promise<readonly ComplianceCheckRunRecord[]> {
  // Both timestamps come from the injected clock rather than a
  // monotonic timer, so a frozen test clock yields a deterministic
  // durationMs of 0. In production the clock is systemClock, so the
  // duration is real wall time and slow probes are visible.
  const startedAt = ctx.clock.now();

  let verdicts: readonly ComplianceVerdict[];
  try {
    verdicts = await definition.evaluate(ctx);
  } catch (cause) {
    const observedAt = ctx.clock.now();
    ctx.logger.error("compliance.check.threw", {
      checkCode: definition.code,
      errorMessage: describeError(cause).message,
    });
    return [
      errorRecord({
        definition,
        startedAt,
        observedAt,
        errorCode: COMPLIANCE_PROBE_THREW,
        errorMessage: describeError(cause).message,
        summary:
          `Probe did not reach a verdict: ${describeError(cause).message}. ` +
          `Control status is UNKNOWN, not satisfied.`,
      }),
    ];
  }

  const observedAt = ctx.clock.now();

  if (verdicts.length === 0) {
    ctx.logger.error("compliance.check.no_verdicts", { checkCode: definition.code });
    return [
      errorRecord({
        definition,
        startedAt,
        observedAt,
        errorCode: COMPLIANCE_PROBE_RETURNED_NO_VERDICTS,
        errorMessage: "Probe returned an empty verdict array.",
        summary:
          "Probe returned no verdicts, which is a probe bug. Control status is " +
          "UNKNOWN, not satisfied.",
      }),
    ];
  }

  return verdicts.map((verdict) => {
    const details: Readonly<Record<string, ComplianceJsonValue>> = {
      ...verdict.details,
      // Findings are folded into the digested payload so that
      // altering the finding list changes the digest. Keeping them
      // only in a sibling column would leave them unprotected by the
      // integrity check.
      findings: verdict.findings.map((f) => ({ subject: f.subject, detail: f.detail })),
    };
    return {
      checkCode: definition.code,
      outcome: verdict.outcome,
      severityAtRun: definition.severity,
      subjectOrganizationId: verdict.subjectOrganizationId,
      summary: verdict.summary,
      details,
      detailsVersion: COMPLIANCE_DETAILS_VERSION,
      digestSha256: computeComplianceDigest(details),
      findingCount: verdict.findings.length,
      errorCode: null,
      errorMessage: null,
      observedAt,
      durationMs: observedAt.getTime() - startedAt.getTime(),
    };
  });
}

function errorRecord(args: {
  readonly definition: ComplianceCheckDefinition;
  readonly startedAt: Date;
  readonly observedAt: Date;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly summary: string;
}): ComplianceCheckRunRecord {
  const details: Readonly<Record<string, ComplianceJsonValue>> = {
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
    findings: [],
  };
  return {
    checkCode: args.definition.code,
    outcome: "ERROR",
    severityAtRun: args.definition.severity,
    subjectOrganizationId: null,
    summary: args.summary,
    details,
    detailsVersion: COMPLIANCE_DETAILS_VERSION,
    digestSha256: computeComplianceDigest(details),
    findingCount: 0,
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
    observedAt: args.observedAt,
    durationMs: args.observedAt.getTime() - args.startedAt.getTime(),
  };
}

/**
 * Error description that is safe to persist. Name + message only —
 * never the stack, which can embed file paths and, in a query error,
 * fragments of the failing statement.
 */
function describeError(cause: unknown): { readonly message: string } {
  if (cause instanceof Error) {
    return { message: `${cause.name}: ${cause.message}` };
  }
  return { message: "Unknown non-Error thrown by probe." };
}
