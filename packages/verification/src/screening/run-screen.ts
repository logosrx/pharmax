// Running a PV1 clinical screen inside a command transaction.
//
// `screenPrescription` is pure: facts in, evaluation out. This module
// is the impure half — it reads the facts out of the locked order's
// neighbourhood, calls the engine once per prescription line, and
// writes what came back to `order_screening_finding`.
//
// ---------------------------------------------------------------------
// What this can and cannot feed the engine
// ---------------------------------------------------------------------
//
// The engine screens four axes and NONE of them is decided here any
// more. `SCREENING_AXIS_CAPABILITY` in `axis-capability.ts` declares
// what this platform can supply per axis, and
// `resolveInputAvailability` executes that declaration for the patient
// on the order. Where the answer is "we cannot supply this", the engine
// reports a `SCREENING_GAP` persisted on the order.
//
// As of the allergy-capture slice:
//
//   - DRUG-DRUG INTERACTION and THERAPEUTIC DUPLICATION: always
//     AVAILABLE. The candidate is the prescription on each order line;
//     the profile is the patient's other ACTIVE prescriptions.
//     Prescriptions are BORN in Pharmax, so an empty profile is a fact
//     about the patient, not a gap in our knowledge of them.
//   - DRUG ALLERGY: PER-PATIENT. AVAILABLE when the patient has at
//     least one screenable allergy record OR an explicit
//     NO_KNOWN_ALLERGIES assertion; NOT_RECORDED_FOR_SUBJECT
//     otherwise. See `allergy-input.ts` for what "screenable" excludes
//     and why the exclusions are the interesting part.
//   - DOSE RANGE: still NOT_SUPPORTED_BY_PLATFORM.
//     `prescription.sigEnc` is encrypted free text with no structured
//     (amount, unit, frequency) beside it, so no prescription carries a
//     dose to compare against a range. That claim is now CHECKED
//     against the schema — see the forcing function below.
//
// WHY THE DECLARATION MOVED OUT OF THIS FILE. It used to be a frozen
// literal here, with a comment promising it would be revisited when the
// schema gained an allergy table. Adding that table broke nothing: the
// constant still compiled, every test still passed, and the axis would
// have gone on reporting "no screen can perform this check" while the
// data sat unused. The gap between a declaration and the reality it
// describes had no enforcement across it.
//
// It does now. Each entry names the SCHEMA its claim depends on, and
// `axis-capability.test.ts` asserts every claim against the generated
// Prisma client — including the negative direction: an axis declared
// NOT_SUPPORTED_BY_PLATFORM must have its schema ABSENT. The day
// structured sig columns land on `prescription`, the DOSE_RANGE claim
// becomes false and the test fails with instructions. Nobody has to
// remember, because the thing that silences an axis is a statement
// about the schema they are changing.
//
// The unsafe direction is still the hard one, which is the property to
// preserve: silencing the allergy axis now means declaring a
// `patient_allergy` model absent while it exists, and the test says so.
//
// GATE (b) IS NOT OPENED BY ANY OF THIS, and the honesty of the record
// depends on not pretending otherwise. Having the patient's allergies
// answers "do we know what they react to?". It does not answer "does
// the prescribed drug contain that allergen?" — that needs NDC →
// ingredient resolution and cross-reactivity data from a licensed
// source, and `DrugKnowledgeSource.coverage` is NOT_PROVISIONED in
// production. So today a patient with recorded allergies still sees
// `SCR_KNOWLEDGE_UNAVAILABLE`, because `describeDrug` returns null for
// the candidate and the engine cannot reach the allergy comparison at
// all. That is the truthful state and the engine already reports it as
// its own gap with its own remediation. What this slice removes is a
// FALSE gap ("this platform cannot hold allergies"); what it leaves is
// a TRUE one ("no drug knowledge is provisioned").
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
// PHI: the columns read are `prescription.id` and
// `prescription.drugNdc` (a public product code, not a drug name),
// `order.patientId`, and the CODED columns of `patient_allergy` — never
// its encrypted narrative. None of it leaves this module and nothing
// here is logged.

import {
  screenPrescription,
  severityRank,
  type DrugKnowledgeRelease,
  type DrugKnowledgeSource,
  type PrescribedDrug,
  type RecordedAllergy,
  type ScreeningEvaluation,
  type ScreeningFinding,
  type ScreeningPolicy,
} from "@pharmax/clinical-screening";
import { PrescriptionStatus, type Prisma, type ScreeningPhase } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { loadScreenableAllergies } from "./allergy-input.js";
import { resolveInputAvailability } from "./axis-capability.js";
import { resolveClinicalScreeningKnowledgeSource } from "./configure.js";
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
  /**
   * The knowledge release the screen resolved against, for stamping
   * onto every persisted finding — the same treatment
   * `workflowPolicyId`/`Version` give the policy. `null` when the
   * source carries no release identity (empty or caller-seeded).
   */
  readonly knowledgeRelease: DrugKnowledgeRelease | null;
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

  // Resolved ONCE per order, not per line. Availability is a fact about
  // the patient and the platform, so recomputing it per line would ask
  // the same question of the same rows N times — and, worse, could
  // answer differently mid-order if a concurrent write landed between
  // two lines, producing an order whose lines disagree about whether
  // allergies were screened.
  const scope = {
    tx: input.tx,
    organizationId: input.organizationId,
    patientId: input.patientId,
  };
  const inputAvailability = await resolveInputAvailability(scope);

  // Loaded only when the axis came back AVAILABLE. When it did not, the
  // engine ignores the list and reads the gap instead — and skipping
  // the query keeps the two consistent by construction rather than by
  // the engine's politeness.
  //
  // An EMPTY list with AVAILABLE is meaningful and correct: it means
  // somebody asserted this patient has no known allergies. It is never
  // "we did not look".
  const allergies: ReadonlyArray<RecordedAllergy> =
    inputAvailability.DRUG_ALLERGY === "AVAILABLE" ? await loadScreenableAllergies(scope) : [];

  // Resolved AFTER the inputs are loaded, because a per-screen
  // resolver prefetches exactly the codes the engine will ask about —
  // inside this same transaction, so the whole screen answers from one
  // knowledge release even if an ingestion swap lands mid-command. A
  // test-injected source short-circuits all of it.
  const knowledge =
    input.knowledgeSource ??
    (await resolveClinicalScreeningKnowledgeSource({
      tx: input.tx,
      organizationId: input.organizationId,
      drugCodes: [...new Set([...candidates, ...activeMedications].map((drug) => drug.drugCode))],
      allergenCodes: [...new Set(allergies.map((allergy) => allergy.substanceCode))],
    }));

  // Deduplicate across lines by fingerprint. The engine already merges
  // within one screen; this merges ACROSS the lines of a multi-Rx
  // order, where the same profile interaction can surface twice.
  const byFingerprint = new Map<string, ScreeningFinding>();
  for (const candidate of candidates) {
    const evaluation: ScreeningEvaluation = screenPrescription({
      candidate,
      inputAvailability,
      activeMedications,
      allergies,
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
    knowledgeRelease: knowledge.release,
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
  /**
   * The knowledge release the screen resolved against
   * (`ScreenResult.knowledgeRelease`); `null` when the source carried
   * no release identity. Stamped on every row so "why did this not
   * fire in March?" survives the reference data moving on.
   */
  readonly knowledgeRelease: DrugKnowledgeRelease | null;
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
      knowledgeSourceCode: input.knowledgeRelease?.source ?? null,
      knowledgeReleaseVersion: input.knowledgeRelease?.version ?? null,
      commandLogId: input.commandLogId,
      occurredAt: input.occurredAt,
    })),
  });
}
