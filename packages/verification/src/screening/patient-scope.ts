// Which screening findings may be acknowledged PER PATIENT, and the
// record-state token that decides how long such an acknowledgement
// stays honest.
//
// =====================================================================
// THE BOUNDARY, AND WHY IT IS NARROWER THAN "SUBJECT_DATA"
// =====================================================================
//
// The tempting rule is "patient-scope every SUBJECT_DATA gap". It is
// wrong, because SUBJECT_DATA answers "who can close this?" (somebody
// present, today) — not "what is this a fact about?". Three findings
// carry SUBJECT_DATA at the acknowledge tier today and they are facts
// about three different things:
//
//   - SCR_ALLERGY_INPUT_UNAVAILABLE — a fact about the PATIENT'S
//     RECORD ("nobody has taken this patient's allergy history").
//     Byte-identical on every order the patient has; re-asking the
//     same pharmacist about the same unchanged record on refill
//     twelve is alert fatigue, not safety.
//   - SCR_KNOWLEDGE_UNAVAILABLE (under a PROVISIONED source) — a fact
//     about a DRUG CODE missing from the org's reference data. The
//     same on every PATIENT taking that drug; patient-keying it would
//     both under-suppress (next patient, same non-answer) and
//     mis-file a reference-data fact under a person.
//   - SCR_DOSE_UNIT_NOT_COMPARABLE — a fact about ONE PRESCRIPTION
//     (its unit vs the published range's unit). A new prescription is
//     a new dispensing decision; its fingerprint already carries the
//     units, and the order key is the right one.
//
// So the rule here is: a finding is patient-scopable exactly when it
// is the NOT_RECORDED_FOR_SUBJECT gap of a PER_SUBJECT screening axis
// — the gap that says "the platform can hold this input and nobody
// recorded it for this patient". That set is DERIVED from
// `SCREENING_AXIS_CAPABILITY` and `INPUT_UNAVAILABLE_CODE_FOR_AXIS`
// rather than written out, so a future axis moved to PER_SUBJECT gets
// patient-scoped acknowledgements the moment it exists — and gets a
// compile/test failure until it declares a record-state reader below.
//
// CLINICAL FINDINGS ARE UNREACHABLE FROM HERE BY CONSTRUCTION, three
// layers deep:
//
//   1. TYPE — the gate's patient-scoped lookup accepts only
//      `PatientRecordGapFinding`, a branded type whose sole
//      constructor is `asPatientRecordGap` below. There is no way to
//      hand a clinical finding to that query without a cast a review
//      cannot miss.
//   2. QUERY — the lookup matches `axis` and `findingCode` columns
//      that only ever hold per-subject gap values.
//   3. DATABASE — `patient_screening_acknowledgement` carries CHECK
//      constraints confining `findingCode` and `axis` to the
//      per-subject gap vocabulary, so even a bugged writer cannot
//      seed a row a bugged reader could consume.
//
// =====================================================================
// THE RECORD-STATE TOKEN — RE-ARMING WITHOUT AN INVALIDATION WRITE
// =====================================================================
//
// A patient-scoped acknowledgement must not suppress the gap forever.
// The dangerous sequence: gap acknowledged → allergy data later
// recorded (gap resolves) → data later retracted as entered-in-error
// → the gap re-arises with the SAME fingerprint. A years-old
// acknowledgement silently swallowing that re-arisen gap is exactly
// the suppressed-alert failure `fingerprintOf` documents — data
// disappearing from a patient record is rare and deserves fresh eyes.
//
// Three candidate mechanisms were considered:
//
//   - CONSUME-ON-RESOLUTION (invalidate acks when a screen observes
//     the axis AVAILABLE). Rejected: it only re-arms if a screen
//     HAPPENED to run between the data arriving and the data being
//     removed. Record-then-retract with no intervening order slips
//     through, and that is precisely the dangerous sequence.
//   - TTL. Rejected: a timer answers "how long ago?", but the hazard
//     is "did the record change?". A short TTL re-taxes unchanged
//     facts (the fatigue this feature removes); a long one suppresses
//     a changed record for months.
//   - RECORD-STATE COMPARISON — chosen. The acknowledgement stores a
//     hash of the patient's record state for the axis at the moment
//     of judgement; the gate honors it only while the current state
//     still hashes to the same value.
//
// The token is ABA-PROOF because the source tables cannot shrink:
// `patient_allergy` has no DELETE grant and no RLS DELETE policy
// (retraction is a status amendment that stamps `statusChangedAt`),
// and `patient_allergy_history_assertion` is append-only. Record an
// allergy and enter-it-in-error and BOTH edits stay visible to the
// hash forever, so the state can never hash back to what the
// pharmacist acknowledged. Every transition that re-arms the prompt
// therefore flows through an already-audited command
// (RecordPatientAllergy / AmendPatientAllergyStatus /
// AssertPatientAllergyHistory) — no invalidation write exists to
// audit, because nothing is mutated: a stale acknowledgement simply
// stops matching, and a fresh judgement appends a NEW row under the
// new token.
//
// Deliberate consequence: ANY change to the record re-arms the
// prompt, including one that leaves the gap standing (e.g. recording
// an UNCODED "sulfa" allergy — unscreenable, so the axis stays
// NOT_RECORDED_FOR_SUBJECT). That is a feature, not looseness: the
// record the pharmacist acknowledged is not the record now on file,
// and the panel renders the new (unscreenable) entry beside the
// re-armed gap.
//
// PHI: the token hashes record IDS and CODED STATUSES only — never a
// substance code, never a narrative column. It reveals nothing about
// what the patient is allergic to, only that the record's shape
// changed.

import { createHash } from "node:crypto";

import {
  CLINICAL_SCREENING_AXES,
  INPUT_UNAVAILABLE_CODE_FOR_AXIS,
  type ScreeningInputAxis,
} from "@pharmax/clinical-screening";
import type { TenantTransactionClient } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { SCREENING_AXIS_CAPABILITY } from "./axis-capability.js";

// ---------------------------------------------------------------------
// The patient-scopable vocabulary, derived
// ---------------------------------------------------------------------

/**
 * The axes whose input is a per-patient record — exactly the
 * PER_SUBJECT entries of `SCREENING_AXIS_CAPABILITY`. Derived so the
 * two cannot drift: re-kinding an axis updates this set without
 * anyone editing this file.
 */
export const PER_SUBJECT_SCREENING_AXES: ReadonlyArray<ScreeningInputAxis> = Object.freeze(
  CLINICAL_SCREENING_AXES.filter((axis) => SCREENING_AXIS_CAPABILITY[axis].kind === "PER_SUBJECT")
);

/**
 * Gap code → the PER_SUBJECT axis it reports, for the codes that ARE
 * patient-record gaps. Everything else — clinical findings, knowledge
 * gaps, per-record gaps — is absent, which is what `asPatientRecordGap`
 * turns into `null`.
 */
export const PATIENT_RECORD_GAP_AXIS_BY_CODE: ReadonlyMap<string, ScreeningInputAxis> = new Map(
  PER_SUBJECT_SCREENING_AXES.map((axis) => [INPUT_UNAVAILABLE_CODE_FOR_AXIS[axis], axis])
);

// ---------------------------------------------------------------------
// The branded type — layer 1 of the structural guarantee
// ---------------------------------------------------------------------

/** Not exported: the brand is constructible only inside this module. */
const PATIENT_RECORD_GAP: unique symbol = Symbol("PatientRecordGapFinding");

/**
 * A finding that has been PROVEN to be a patient-record gap. The only
 * producer is `asPatientRecordGap`; a clinical finding cannot be given
 * this type without an explicit unsafe cast, which is the property the
 * gate's patient-scoped lookup builds on.
 */
export interface PatientRecordGapFinding {
  readonly fingerprint: string;
  readonly code: string;
  readonly axis: ScreeningInputAxis;
  readonly [PATIENT_RECORD_GAP]: true;
}

/** The identity columns the classification reads — a persisted row or
 * an engine finding both satisfy it. */
export interface FindingIdentity {
  readonly kind: string;
  readonly code: string;
  readonly disposition: string;
  readonly fingerprint: string;
}

/**
 * Classify one finding. `null` for everything that must stay
 * order-scoped: every clinical finding (any kind other than
 * SCREENING_GAP), every gap that does not require acknowledgement,
 * and every acknowledge-tier gap whose code is not a PER_SUBJECT
 * axis's input-unavailability code (knowledge misses, dose-unit
 * mismatches).
 */
export function asPatientRecordGap(finding: FindingIdentity): PatientRecordGapFinding | null {
  if (finding.kind !== "SCREENING_GAP") return null;
  if (finding.disposition !== "REQUIRES_ACKNOWLEDGEMENT") return null;
  const axis = PATIENT_RECORD_GAP_AXIS_BY_CODE.get(finding.code);
  if (axis === undefined) return null;
  return {
    fingerprint: finding.fingerprint,
    code: finding.code,
    axis,
    [PATIENT_RECORD_GAP]: true,
  };
}

// ---------------------------------------------------------------------
// The record-state token
// ---------------------------------------------------------------------

/**
 * Cap on the rows one token computation reads. A patient with more
 * allergy-record rows than this is a data-quality incident (the same
 * judgement `MAX_SCREENED_ALLERGIES` makes at 200 ACTIVE rows — this
 * bound also counts retired history, so it is wider). REFUSED rather
 * than truncated: a token computed over a subset would disagree with
 * a token computed over a different subset, and the failure mode of
 * that disagreement is a prompt that can never be settled.
 */
export const MAX_RECORD_STATE_ROWS = 2000;

export const PV1_SCREENING_RECORD_STATE_TOO_LARGE = "PV1_SCREENING_RECORD_STATE_TOO_LARGE";

/**
 * An axis reached the patient-scoped path without a record-state
 * reader below. Internal: `PER_SUBJECT_SCREENING_AXES` is derived, so
 * the only way here is moving an axis to PER_SUBJECT without
 * extending `patientRecordStateToken` — and `patient-scope.test.ts`
 * pins that every PER_SUBJECT axis resolves a token, so this
 * surfaces in CI, not in a pharmacy.
 */
export const PV1_SCREENING_AXIS_STATE_UNSUPPORTED = "PV1_SCREENING_AXIS_STATE_UNSUPPORTED";

export interface PatientRecordStateScope {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  readonly patientId: string;
}

/**
 * The current record-state token for one PER_SUBJECT axis of one
 * patient.
 *
 * Deterministic within a transaction: the acknowledging command and
 * the approval gate both call this against their own snapshot, and
 * equality of the two hashes is what "the record has not changed
 * since the judgement" means.
 */
export async function patientRecordStateToken(
  scope: PatientRecordStateScope,
  axis: ScreeningInputAxis
): Promise<string> {
  switch (axis) {
    case "DRUG_ALLERGY":
      return allergyRecordStateToken(scope);
    default:
      throw new errors.InternalError({
        code: PV1_SCREENING_AXIS_STATE_UNSUPPORTED,
        message:
          `No record-state reader is declared for screening axis ${axis}. ` +
          "An axis cannot carry patient-scoped acknowledgements until patientRecordStateToken " +
          "can say what 'the record changed' means for it.",
        metadata: { axis },
      });
  }
}

/**
 * The allergy-record state, hashed.
 *
 * Reads EVERY `patient_allergy` row — not just ACTIVE ones — because
 * retraction is a status amendment and a token blind to non-ACTIVE
 * rows would hash record-then-retract back to the pre-record value,
 * which is the ABA hole the whole mechanism exists to close. The
 * columns are ids, coded statuses and the status-change stamp; the
 * substance code and every encrypted column are deliberately not
 * read.
 */
async function allergyRecordStateToken(scope: PatientRecordStateScope): Promise<string> {
  const allergies = await scope.tx.patientAllergy.findMany({
    where: { organizationId: scope.organizationId, patientId: scope.patientId },
    select: {
      id: true,
      clinicalStatus: true,
      verificationStatus: true,
      statusChangedAt: true,
    },
    orderBy: { id: "asc" },
    take: MAX_RECORD_STATE_ROWS + 1,
  });
  const assertions = await scope.tx.patientAllergyHistoryAssertion.findMany({
    where: { organizationId: scope.organizationId, patientId: scope.patientId },
    select: { id: true, status: true, assertedAt: true },
    orderBy: { id: "asc" },
    take: MAX_RECORD_STATE_ROWS + 1,
  });

  if (allergies.length > MAX_RECORD_STATE_ROWS || assertions.length > MAX_RECORD_STATE_ROWS) {
    throw new errors.InvariantViolationError({
      code: PV1_SCREENING_RECORD_STATE_TOO_LARGE,
      message:
        `The patient's allergy record carries more than ${MAX_RECORD_STATE_ROWS} rows. ` +
        "A record-state token over a subset would never match itself, so the computation was refused. " +
        "Investigate the record (duplicated intake, or a patient merge that duplicated rows).",
      metadata: { limit: MAX_RECORD_STATE_ROWS },
    });
  }

  const hash = createHash("sha256");
  // Version prefix: if the token's inputs ever change, bump this so
  // every stored token goes stale at once (re-prompting, the safe
  // direction) instead of colliding with hashes of the old shape.
  hash.update("allergy-record-state-v1\n");
  for (const row of allergies) {
    hash.update(
      `A|${row.id}|${row.clinicalStatus}|${row.verificationStatus}|` +
        `${row.statusChangedAt === null ? "-" : row.statusChangedAt.toISOString()}\n`
    );
  }
  for (const row of assertions) {
    hash.update(`H|${row.id}|${row.status}|${row.assertedAt.toISOString()}\n`);
  }
  return hash.digest("hex");
}
