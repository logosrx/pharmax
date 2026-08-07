// The PV1 approval gate.
//
// Two refusals, two codes, and two reads of two acknowledgement
// tables — one per scope, split by what the finding is a fact ABOUT:
//
//   - CLINICAL findings and order-level gaps consume
//     `order_screening_acknowledgement`, scoped to (organization,
//     order, approving pharmacist). Every part of that key is
//     load-bearing:
//       - ORDER, because a clinical finding is an input to a
//         DISPENSING DECISION and every fill is a new one — DUR
//         overrides are per-fill events, and an interaction
//         acknowledged in January must be re-confronted in February
//         because the clinical context may have changed.
//       - PHARMACIST, because an acknowledgement is a professional
//         judgement attached to a person. If pharmacist A's
//         acknowledgement satisfied pharmacist B's approval, the
//         alert would have been converted into a checkbox that
//         someone else already ticked — and B would sign a decision
//         they never made.
//       - ORGANIZATION, belt-and-braces behind the Prisma tenancy
//         extension and RLS. An unscoped read here would let one
//         tenant's acknowledgement open another tenant's gate, which
//         is the worst shape a cross-tenant leak can take: not a
//         disclosure, a bypassed safety control.
//   - PATIENT-RECORD gaps (`asPatientRecordGap` — today exactly the
//     "no allergy history recorded" gap) consume
//     `patient_screening_acknowledgement`, scoped to (organization,
//     PATIENT, approving pharmacist) AND to the record-state token:
//     the row counts only while the patient's allergy record still
//     hashes to the state the pharmacist acknowledged. The gap is a
//     statement about the record, not about this fill; it is
//     byte-identical on every order the patient has, and re-charging
//     the same pharmacist for the same unchanged fact per refill is
//     the alert-fatigue machine the tiers were built to dismantle.
//     The PHARMACIST and ORGANIZATION halves of the key keep their
//     full force — a colleague's patient-scoped acknowledgement opens
//     nothing for the signer.
//
//     TRANSITION: order-scoped rows recorded for these gaps before
//     patient scoping existed still satisfy the gate ON THEIR OWN
//     ORDER (they were legitimate judgements and are not
//     invalidated); only NEW coverage is patient-keyed.
//
//     THE SPLIT IS STRUCTURAL, NOT A WHERE-CLAUSE CONVENTION. The
//     patient-scoped lookup accepts only `PatientRecordGapFinding`, a
//     branded type whose sole constructor proves the finding is a
//     per-subject gap; the table's CHECK constraints refuse any other
//     finding code at the database layer. A clinical finding cannot
//     reach the patient-scoped path without an unsafe cast AND a
//     constraint-violating row.
//
// Note what the gate does NOT do: it never downgrades a HARD_STOP,
// and there is no input by which a caller could ask it to. The
// unoverridable tier is unreachable from the acknowledgement path by
// construction, not by convention — `AcknowledgePV1ScreeningFinding`
// refuses to record one, and this function checks hard stops before
// it looks at acknowledgements at all.
//
// WHY THIS RETURNS THE REFUSAL RATHER THAN THROWING IT. A throw out
// of an ApprovePV1 handler rolls the transaction back, and the screen
// this gate just evaluated rolls back with it — so the pharmacist
// would be refused for a finding no console could then show them and
// no command would then let them acknowledge. The caller has to be
// able to persist the evidence BEFORE the refusal reaches the bus,
// which means the refusal has to be a value it holds, not a stack
// unwind it cannot get in front of. See `approve-pv1.ts`.

import {
  findingsRequiringAcknowledgement,
  hardStopFindings,
  type ScreeningEvaluation,
  type ScreeningFinding,
} from "@pharmax/clinical-screening";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED, PV1_SCREENING_HARD_STOP } from "./errors.js";
import {
  asPatientRecordGap,
  patientRecordStateToken,
  type PatientRecordGapFinding,
} from "./patient-scope.js";

export interface ApprovalGateInput {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
  /**
   * The patient on the order — the key patient-record gap
   * acknowledgements are honored under. The caller has already
   * resolved it for the screen itself (`loadPatientIdForOrder`).
   */
  readonly patientId: string;
  /** The pharmacist whose acknowledgements count. */
  readonly pharmacistUserId: string;
  readonly evaluation: ScreeningEvaluation;
}

/**
 * Decide whether the screening result permits the approval.
 *
 * Returns `null` when it does, and the refusal the caller must raise
 * when it does not. The caller persists the screen first and hands
 * the refusal to the bus as a committed refusal, so the findings the
 * gate judged are on record before the pharmacist is told about them.
 *
 * Order of checks is deliberate: hard stops first, so an order that
 * cannot pass at all reports that rather than a list of
 * acknowledgements the pharmacist would waste time recording before
 * meeting the wall.
 */
export async function screeningRefusalForApproval(
  input: ApprovalGateInput
): Promise<errors.PharmaxError | null> {
  const blocking = hardStopFindings(input.evaluation);
  if (blocking.length > 0) {
    return new errors.InvariantViolationError({
      code: PV1_SCREENING_HARD_STOP,
      message:
        "Clinical screening returned a finding that cannot be overridden; this prescription cannot pass PV1 as written. " +
        "The screen this refusal was made against has been recorded on the order — reload it to read the finding and its source.",
      metadata: {
        orderId: input.orderId,
        // Codes and fingerprints only — the same PHI posture as the
        // persisted rows. A finding's `reason` is safe to store but
        // an error message is a different surface (it reaches logs
        // and partner responses), so the console reads the detail
        // from `order_screening_finding` inside an authorized
        // session.
        findingCodes: blocking.map((f) => f.code),
        fingerprints: blocking.map((f) => f.fingerprint),
      },
    });
  }

  const required = findingsRequiringAcknowledgement(input.evaluation);
  if (required.length === 0) return null;

  // Partition by scope. `asPatientRecordGap` is the single authority
  // on what may be patient-keyed; everything it declines — every
  // clinical finding, every knowledge or per-record gap — stays on
  // the order-scoped path below.
  const patientRecordGaps: PatientRecordGapFinding[] = [];
  const orderScoped: ScreeningFinding[] = [];
  for (const finding of required) {
    const gap = asPatientRecordGap(finding);
    if (gap === null) {
      orderScoped.push(finding);
    } else {
      patientRecordGaps.push(gap);
    }
  }

  // ONE read of the order table for BOTH partitions. For the
  // order-scoped findings it is their gate; for the patient-record
  // gaps it is the backward-compatibility path — an order-scoped row
  // recorded before patient scoping existed keeps satisfying the
  // order it was recorded on.
  const acknowledgedOnOrder = await input.tx.orderScreeningAcknowledgement.findMany({
    where: {
      organizationId: input.organizationId,
      orderId: input.orderId,
      pharmacistUserId: input.pharmacistUserId,
      fingerprint: { in: required.map((f) => f.fingerprint) },
    },
    select: { fingerprint: true },
  });
  const settled = new Set(acknowledgedOnOrder.map((row) => row.fingerprint));

  const unsettledPatientGaps = patientRecordGaps.filter((g) => !settled.has(g.fingerprint));
  for (const fingerprint of await patientScopedSettledFingerprints(input, unsettledPatientGaps)) {
    settled.add(fingerprint);
  }

  const outstanding = required.filter((f) => !settled.has(f.fingerprint));
  if (outstanding.length === 0) return null;

  return new errors.InvariantViolationError({
    code: PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED,
    message:
      "Clinical screening returned findings that this pharmacist has not acknowledged. " +
      "Acknowledgements are per-pharmacist: a colleague's acknowledgement of the same finding does not satisfy the gate. " +
      "The screen this refusal was made against has been recorded on the order — reload it, and the findings panel will list exactly these findings for acknowledgement.",
    metadata: {
      orderId: input.orderId,
      pharmacistUserId: input.pharmacistUserId,
      outstandingFindingCodes: outstanding.map((f) => f.code),
      outstandingFingerprints: outstanding.map((f) => f.fingerprint),
    },
  });
}

/**
 * Which of the given PATIENT-RECORD gaps this pharmacist has settled
 * for this PATIENT, at the patient's CURRENT record state.
 *
 * The parameter type is the structural guarantee (layer 1 in the
 * header): only `asPatientRecordGap` can produce a
 * `PatientRecordGapFinding`, so a clinical finding cannot be passed
 * here without an unsafe cast. The query itself adds layer 2 — it
 * matches rows whose `axis` proves them per-subject — and the table's
 * CHECK constraints are layer 3.
 *
 * The token comparison is the entire re-arming mechanism: a row whose
 * `recordStateToken` no longer matches the current hash is simply not
 * selected. No status column, no invalidation write — the record
 * state only moves through the audited allergy commands, and this
 * comparison is where that movement becomes a fresh prompt.
 */
async function patientScopedSettledFingerprints(
  input: ApprovalGateInput,
  gaps: ReadonlyArray<PatientRecordGapFinding>
): Promise<ReadonlyArray<string>> {
  if (gaps.length === 0) return [];

  // One token per distinct axis. Today that is one hash for the whole
  // set (DRUG_ALLERGY is the only PER_SUBJECT axis), but the loop is
  // written for the day a second one exists.
  const settled: string[] = [];
  for (const axis of new Set(gaps.map((g) => g.axis))) {
    const recordStateToken = await patientRecordStateToken(
      { tx: input.tx, organizationId: input.organizationId, patientId: input.patientId },
      axis
    );
    const axisGaps = gaps.filter((g) => g.axis === axis);
    const rows = await input.tx.patientScreeningAcknowledgement.findMany({
      where: {
        organizationId: input.organizationId,
        patientId: input.patientId,
        pharmacistUserId: input.pharmacistUserId,
        axis,
        fingerprint: { in: axisGaps.map((g) => g.fingerprint) },
        recordStateToken,
      },
      select: { fingerprint: true },
    });
    for (const row of rows) settled.push(row.fingerprint);
  }
  return settled;
}
