// Running a PV1 clinical screen inside a command transaction.
//
// `screenPrescription` is pure: facts in, evaluation out. This module
// is the impure half — it reads the facts out of the locked order's
// neighbourhood, calls the engine once per prescription line, and
// writes what came back to `order_screening_finding`.
//
// ---------------------------------------------------------------------
// What this can and cannot feed the engine today
// ---------------------------------------------------------------------
//
// The engine screens four axes. This platform can supply two of them,
// and `INPUT_AVAILABILITY` below DECLARES the other two unavailable —
// which makes the engine report each as a `SCREENING_GAP` the
// approving pharmacist has to acknowledge. The list is therefore a
// statement of what is enforced, not a warning somebody has to read:
//
//   - DRUG-DRUG INTERACTION and THERAPEUTIC DUPLICATION: supplied.
//     The candidate is the prescription on each order line; the
//     profile is the patient's other ACTIVE prescriptions.
//   - DRUG ALLERGY: NOT supplied. Pharmax has no allergy capture —
//     there is no `patient_allergy` table to read.
//   - DOSE RANGE: NOT supplied. `prescription.sigEnc` is encrypted
//     free text with no structured (amount, unit, frequency) beside
//     it, so there is no dose to compare against a range.
//
// Why this is a declaration and not a comment. An empty `allergies`
// array makes the engine's allergy loop iterate zero times and
// contribute nothing, and nothing is indistinguishable from clean.
// Today that is masked: with no licensed knowledge source every
// prescription raises `SCR_KNOWLEDGE_UNAVAILABLE`, so no screen reads
// as clear anyway. The mask is the hazard. The day an adapter is
// wired, that universal gap stops firing, interactions and
// duplication start screening for real, and a prescription for a
// patient with documented anaphylaxis would come back CLEAR having
// never been compared to an allergy list that does not exist —
// against the one axis that can produce a hard stop at all.
//
// SELF-HEALING, which is the property to preserve when editing this.
// Nothing here has to be deleted at the right moment. When allergy
// capture lands, pass the records and flip DRUG_ALLERGY to
// "AVAILABLE"; the gap stops being emitted because the declaration
// changed, not because someone remembered a note. Same for DOSE_RANGE
// when a structured sig lands. Leaving a declaration at "UNAVAILABLE"
// after the input exists costs a spurious acknowledgement, which is
// loud; the reverse is impossible without editing this constant.
//
// ---------------------------------------------------------------------
// Why acknowledged fingerprints are NOT passed to the engine
// ---------------------------------------------------------------------
//
// `ScreeningRequest.acknowledgedFingerprints` downgrades a settled
// finding to INFORMATIONAL, which is the right behaviour for a
// console that should not re-interrupt. It is the wrong behaviour for
// the row we persist and for the gate: a finding stored as
// INFORMATIONAL because someone had already acknowledged it reads,
// years later, as a finding that never required a decision. So the
// engine is always called with an EMPTY acknowledged set, the true
// dispositions are what get written down, and the gate compares the
// required fingerprints against `order_screening_acknowledgement`
// itself — which it has to do anyway, because the engine's set is
// per-patient and the gate is per-PHARMACIST.
//
// PHI: the only columns read are `prescription.id` and
// `prescription.drugNdc` (a public product code, not a drug name) plus
// `order.patientId`, which is needed to find the profile and never
// leaves this module. Nothing here is logged.

import {
  screenPrescription,
  severityRank,
  type DrugKnowledgeSource,
  type PrescribedDrug,
  type ScreeningEvaluation,
  type ScreeningFinding,
  type ScreeningInputAvailability,
  type ScreeningInputAxis,
  type ScreeningPolicy,
} from "@pharmax/clinical-screening";
import { PrescriptionStatus, type Prisma, type ScreeningPhase } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { getClinicalScreeningKnowledgeSource } from "./configure.js";
import { PV1_SCREENING_NOT_PERFORMED, PV1_SCREENING_PROFILE_TOO_LARGE } from "./errors.js";

/**
 * Cap on the patient's active-medication profile.
 *
 * A safety screen that silently drops half its inputs is worse than
 * no screen, so this is not a `take` that truncates — the query asks
 * for one more than the cap and the command REFUSES if it gets it.
 * A patient with this many concurrent active prescriptions is a
 * data-quality incident (a duplicate patient record, a failed
 * expiry job), and screening against an arbitrary subset of them
 * would produce a confident, wrong answer.
 */
export const MAX_PROFILE_MEDICATIONS = 500;

/**
 * Which clinical axes this platform can currently supply facts for.
 *
 * Written as a literal rather than derived, so adding a fifth axis to
 * the engine fails to compile here until somebody decides what
 * Pharmax can say about it. See the module header for what each entry
 * means and how it self-heals.
 */
const INPUT_AVAILABILITY: Readonly<Record<ScreeningInputAxis, ScreeningInputAvailability>> =
  Object.freeze({
    // Both fed from the patient's other ACTIVE prescriptions.
    DRUG_DRUG_INTERACTION: "AVAILABLE",
    THERAPEUTIC_DUPLICATION: "AVAILABLE",
    // No allergy capture exists in this platform yet. Flip to
    // "AVAILABLE" and pass the records when it lands.
    DRUG_ALLERGY: "UNAVAILABLE",
    // `prescription.sigEnc` is encrypted free text; there is no
    // structured dose to compare. Flip when a structured sig lands.
    DOSE_RANGE: "UNAVAILABLE",
  });

export interface RunScreenInput {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly patientId: string;
  readonly policy: ScreeningPolicy;
  /** Injected in tests; defaults to the composition-wired source. */
  readonly knowledgeSource?: DrugKnowledgeSource;
}

export interface ScreenResult {
  /**
   * The order-level evaluation: every finding across every line,
   * deduplicated by fingerprint and ordered most-severe-first, with
   * the same three outcomes a single-line evaluation carries. Two
   * lines producing the identical clinical situation produce one
   * finding — the pharmacist should be asked once.
   *
   * Shaped as a `ScreeningEvaluation` so callers can use the
   * package's own `hardStopFindings` /
   * `findingsRequiringAcknowledgement` selectors rather than
   * re-deriving "what blocks" locally, which is precisely the kind of
   * duplicated policy that drifts.
   */
  readonly evaluation: ScreeningEvaluation;
  /** Prescription lines actually screened. */
  readonly screenedLineCount: number;
}

/**
 * Screen every line on an order.
 *
 * Throws `InvariantViolationError(PV1_SCREENING_NOT_PERFORMED)` when
 * the order has no prescription lines to screen. An order in PV1 with
 * nothing on it cannot be dispensed anyway, and the alternative —
 * returning zero findings — is indistinguishable from "screened and
 * clear", which is the one sentence this feature must never say by
 * accident.
 */
export async function runOrderScreen(input: RunScreenInput): Promise<ScreenResult> {
  const knowledge = input.knowledgeSource ?? getClinicalScreeningKnowledgeSource();

  const candidates = await loadCandidateDrugs(input);
  if (candidates.length === 0) {
    throw new errors.InvariantViolationError({
      code: PV1_SCREENING_NOT_PERFORMED,
      message:
        "No prescription lines were available to screen for this order, so no clinical screening was performed.",
      metadata: { orderId: input.orderId },
    });
  }

  const activeMedications = await loadProfileMedications(input);

  // Deduplicate across lines by fingerprint. The engine already merges
  // within one screen; this merges ACROSS the lines of a multi-Rx
  // order, where the same profile interaction can surface twice.
  const byFingerprint = new Map<string, ScreeningFinding>();
  for (const candidate of candidates) {
    const evaluation: ScreeningEvaluation = screenPrescription({
      candidate,
      inputAvailability: INPUT_AVAILABILITY,
      activeMedications,
      // Empty because DRUG_ALLERGY is declared UNAVAILABLE above, and
      // the engine ignores the inputs for an axis it is told we
      // cannot answer. It is not "this patient has no allergies".
      allergies: [],
      knowledge,
      // Deliberately empty. See the header.
      acknowledgedFingerprints: new Set<string>(),
      policy: input.policy,
    });
    for (const finding of evaluation.findings) {
      if (!byFingerprint.has(finding.fingerprint)) {
        byFingerprint.set(finding.fingerprint, finding);
      }
    }
  }

  const findings = [...byFingerprint.values()].sort(compareFindings);
  return {
    evaluation: toEvaluation(findings),
    screenedLineCount: candidates.length,
  };
}

/**
 * Most severe first, then a stable tiebreak on code and fingerprint —
 * the same ordering the engine applies within one screen, reapplied
 * after the cross-line merge. Determinism matters twice: the console
 * shows the finding that matters at the top, and two replays of the
 * same command produce byte-identical event payloads.
 */
function compareFindings(a: ScreeningFinding, b: ScreeningFinding): number {
  const bySeverity = severityRank(b.severity) - severityRank(a.severity);
  if (bySeverity !== 0) return bySeverity;
  const byCode = a.code.localeCompare(b.code);
  if (byCode !== 0) return byCode;
  return a.fingerprint.localeCompare(b.fingerprint);
}

function toEvaluation(findings: ReadonlyArray<ScreeningFinding>): ScreeningEvaluation {
  if (findings.length === 0) return { outcome: "CLEAR", findings: [] };
  if (findings.some((f) => f.disposition === "HARD_STOP")) {
    return { outcome: "BLOCKED", findings };
  }
  return { outcome: "ADVISORY", findings };
}

/**
 * The prescriptions being dispensed on this order.
 *
 * `recordId` is the PRESCRIPTION id rather than the order-line id, on
 * purpose: the engine skips a profile medication whose `recordId`
 * matches the candidate's, which is how a refill re-screened against a
 * profile that already contains it avoids reporting itself as
 * duplicating itself.
 */
async function loadCandidateDrugs(input: RunScreenInput): Promise<ReadonlyArray<PrescribedDrug>> {
  const lines = await input.tx.orderLine.findMany({
    where: { organizationId: input.organizationId, orderId: input.orderId },
    select: { prescriptionId: true },
  });
  if (lines.length === 0) return [];

  const prescriptions = await input.tx.prescription.findMany({
    where: {
      organizationId: input.organizationId,
      id: { in: lines.map((l) => l.prescriptionId) },
    },
    select: { id: true, drugNdc: true },
  });

  return prescriptions.map(toPrescribedDrug);
}

/**
 * The patient's other active prescriptions.
 *
 * Scoped by organization AND patient. The candidate's own rows are not
 * filtered out here — the engine does that by `recordId`, and letting
 * it do so keeps the "is this a refill of something already on the
 * profile?" decision in one place.
 */
async function loadProfileMedications(
  input: RunScreenInput
): Promise<ReadonlyArray<PrescribedDrug>> {
  const rows = await input.tx.prescription.findMany({
    where: {
      organizationId: input.organizationId,
      patientId: input.patientId,
      status: PrescriptionStatus.ACTIVE,
    },
    select: { id: true, drugNdc: true },
    // One more than the cap, so "too many" is detectable rather than
    // silently truncated.
    take: MAX_PROFILE_MEDICATIONS + 1,
  });

  if (rows.length > MAX_PROFILE_MEDICATIONS) {
    throw new errors.InvariantViolationError({
      code: PV1_SCREENING_PROFILE_TOO_LARGE,
      message:
        `The patient profile carries more than ${MAX_PROFILE_MEDICATIONS} active prescriptions. ` +
        "Screening against a subset would produce a confident, incomplete result, so the screen was refused. " +
        "Investigate the profile (duplicate patient record, or expired prescriptions still marked ACTIVE).",
      metadata: { orderId: input.orderId, limit: MAX_PROFILE_MEDICATIONS },
    });
  }

  return rows.map(toPrescribedDrug);
}

function toPrescribedDrug(row: { readonly id: string; readonly drugNdc: string }): PrescribedDrug {
  return {
    recordId: row.id,
    // The NDC is a public product code. `prescription.drugName` is
    // NOT passed and must never be: the finding vocabulary is codes,
    // and a name in a persisted finding would put a drug name into an
    // append-only table and every event payload derived from it.
    drugCode: row.drugNdc,
    // Not "this prescription has no dose" — this platform cannot read
    // one. That claim is made once, structurally, by declaring
    // DOSE_RANGE unavailable in `INPUT_AVAILABILITY`; the engine then
    // gaps the axis and never reaches this field.
    dose: null,
  };
}

export interface PersistFindingsInput {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly phase: ScreeningPhase;
  readonly screenedForUserId: string;
  readonly findings: ReadonlyArray<ScreeningFinding>;
  readonly workflowPolicyId: string;
  readonly workflowPolicyVersion: number;
  readonly minimumReportedSeverity: string;
  readonly commandLogId: string;
  readonly occurredAt: Date;
}

/**
 * Write one `order_screening_finding` row per finding.
 *
 * Insert-only by design: the table has no UPDATE grant. A later screen
 * on the same order appends a new set of rows rather than replacing
 * the earlier one, because "what did the previous screen say?" is the
 * question that makes a mid-review profile change visible.
 */
export async function persistFindings(input: PersistFindingsInput): Promise<void> {
  if (input.findings.length === 0) return;

  await input.tx.orderScreeningFinding.createMany({
    data: input.findings.map((finding) => ({
      organizationId: input.organizationId,
      orderId: input.orderId,
      phase: input.phase,
      screenedForUserId: input.screenedForUserId,
      code: finding.code,
      kind: finding.kind,
      severity: finding.severity,
      certainty: finding.certainty,
      disposition: finding.disposition,
      fingerprint: finding.fingerprint,
      reason: finding.reason,
      triggers: finding.triggers as unknown as Prisma.InputJsonValue,
      citation: finding.citation,
      workflowPolicyId: input.workflowPolicyId,
      workflowPolicyVersion: input.workflowPolicyVersion,
      minimumReportedSeverity: input.minimumReportedSeverity,
      commandLogId: input.commandLogId,
      occurredAt: input.occurredAt,
    })),
  });
}
