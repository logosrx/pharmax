// Reading a patient's allergies for a PV1 screen, and answering the
// question that decides whether the allergy axis runs at all.
//
// =====================================================================
// THE THREE STATES, AND WHY THE MIDDLE ONE IS THE POINT
// =====================================================================
//
//   1. At least one SCREENABLE allergy record  → AVAILABLE, records
//      passed to the engine, real comparison happens.
//   2. No screenable records, but a current NO_KNOWN_ALLERGIES
//      assertion → AVAILABLE with an empty list. The engine's allergy
//      loop runs zero times and the axis reports CLEAR, which is the
//      correct answer for a patient somebody asked.
//   3. Neither → NOT_RECORDED_FOR_SUBJECT. The engine skips the axis
//      and emits `SCR_ALLERGY_INPUT_UNAVAILABLE` graded MODERATE, so
//      the pharmacist is asked to acknowledge that nobody has taken an
//      allergy history. Actionable, therefore interruptive.
//
// State 2 is what the assertion table buys. Without it, states 2 and 3
// are the same database — zero rows — and the screening layer must
// assume the dangerous one. That would put an unclosable
// acknowledgement on every order for every genuinely allergy-free
// patient, and an alert that can never be closed is an alert that gets
// trained away. See `screeningGapSeverity`.
//
// =====================================================================
// WHY "SCREENABLE" IS NARROWER THAN "EXISTS", WHICH IS THE SUBTLE PART
// =====================================================================
//
// The obvious implementation is "any allergy row → AVAILABLE". It is
// wrong, and wrong in the direction that reports a clean screen.
//
// The engine compares a substance code to a knowledge source's
// ingredient codes by string equality. Records it therefore cannot use:
//
//   - UNCODED substances. "Sulfa", as the patient said it, matches no
//     ingredient code. The engine iterates it and contributes nothing.
//   - FOOD and ENVIRONMENT categories. A drug knowledge base cannot
//     answer them; the engine excludes them at the door.
//   - REFUTED and ENTERED_IN_ERROR records. Someone decided these are
//     wrong; screening against them would resurrect the correction.
//   - INACTIVE and RESOLVED records. These say the propensity no longer
//     applies.
//
// A patient whose only allergy row is any of the above has data on file
// and NO screenable input, so this module answers
// NOT_RECORDED_FOR_SUBJECT for them. That is deliberate and it is the
// conservative direction: the gap is cheap to close (record a coded
// allergy, or assert the history) and the alternative is a screen that
// compared nothing while reporting clear.
//
// The imprecision this leaves is worth naming: the gap's reason text
// says "none was recorded for this subject", which is not literally
// true for a patient with one uncoded allergy on file. The console
// closes that hole by rendering the actual records beside the gap — for
// an uncoded allergen, a pharmacist reading the text is the only screen
// there is, which is why the allergy panel at PV1 is load-bearing
// rather than decorative.
//
// A patient with a MIXTURE — one coded allergy and one uncoded — is
// AVAILABLE and the uncoded record is not passed. The engine has no
// "partially screened" state by design (see
// `SCREENING_INPUT_AVAILABILITIES`), so the console carries that
// weight too.
//
// PHI: the columns read here are coded values and record ids only.
// `substanceLabelEnc` and `reactionNoteEnc` are never selected — the
// engine cannot use them, and a finding must never carry narrative.
// Nothing here is logged.

import type {
  AllergyCategory,
  AllergyClinicalStatus,
  AllergySubstanceCodeSystem,
  RecordedAllergy,
} from "@pharmax/clinical-screening";
import { isScreenableAllergy } from "@pharmax/clinical-screening";
import {
  AllergyClinicalStatus as AllergyClinicalStatusEnum,
  type TenantTransactionClient,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { PV1_SCREENING_ALLERGY_PROFILE_TOO_LARGE } from "./errors.js";

/** One patient, inside the caller's transaction. */
export interface PatientScreeningScope {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  readonly patientId: string;
}

/**
 * Cap on the allergy records fed to one screen.
 *
 * A REFUSAL, not a `take`, for the same reason `MAX_PROFILE_MEDICATIONS`
 * is: screening against an arbitrary subset of a patient's allergies
 * produces a confident answer that may have skipped the one that
 * mattered. A patient with this many recorded allergies is a
 * data-quality incident (a duplicated intake, a merge that duplicated
 * rows), and the honest response is to stop rather than to guess.
 */
export const MAX_SCREENED_ALLERGIES = 200;

/**
 * The columns the screen needs. Kept as a named constant because
 * `hasScreenableAllergyInput` and `loadScreenableAllergies` must select
 * the same fields — a probe that decided on a narrower view than the
 * loader passes could answer AVAILABLE for records the loader then
 * drops.
 */
const SCREENING_SELECT = {
  id: true,
  substanceCode: true,
  substanceCodeSystem: true,
  category: true,
  type: true,
  criticality: true,
  clinicalStatus: true,
  verificationStatus: true,
} as const;

/**
 * One row as the screen reads it.
 *
 * Typed with the `@pharmax/clinical-screening` string unions rather
 * than the Prisma enums, which is what makes the mapping below
 * cast-free: the two vocabularies are member-for-member identical (see
 * the enum block in `prisma/schema.prisma`), so a Prisma row assigns
 * straight into this shape. If they ever diverge, this file stops
 * compiling — and `allergy-input.test.ts` asserts the equality
 * directly, so the failure names the cause instead of showing up as an
 * inscrutable assignability error.
 */
interface AllergyRow {
  readonly id: string;
  readonly substanceCode: string | null;
  readonly substanceCodeSystem: AllergySubstanceCodeSystem;
  readonly category: AllergyCategory;
  readonly type: RecordedAllergy["type"];
  readonly criticality: RecordedAllergy["criticality"];
  readonly clinicalStatus: AllergyClinicalStatus;
  readonly verificationStatus: RecordedAllergy["verificationStatus"];
}

function isScreenableRow(row: AllergyRow): boolean {
  return isScreenableAllergy({
    category: row.category,
    clinicalStatus: row.clinicalStatus,
    verificationStatus: row.verificationStatus,
    substanceCodeSystem: row.substanceCodeSystem,
  });
}

/**
 * Whether the DRUG_ALLERGY axis can be declared AVAILABLE for this
 * patient.
 *
 * The probe behind `SCREENING_AXIS_CAPABILITY.DRUG_ALLERGY`. Ordered
 * cheapest-first: most patients with allergy data have a screenable
 * record, and the assertion lookup is only needed when they do not.
 */
export async function hasScreenableAllergyInput(scope: PatientScreeningScope): Promise<boolean> {
  const rows = await loadCandidateRows(scope);
  if (rows.some(isScreenableRow)) return true;

  // No usable records. The axis is still AVAILABLE if somebody has
  // stated the history is empty — and ONLY for NO_KNOWN_ALLERGIES.
  // UNABLE_TO_ASSESS records that a history was attempted and failed,
  // which is precisely not a basis for reporting a clean allergy
  // screen: it would give the most reassuring answer to the patient we
  // know least about.
  const latest = await scope.tx.patientAllergyHistoryAssertion.findFirst({
    where: { organizationId: scope.organizationId, patientId: scope.patientId },
    orderBy: [{ assertedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { status: true },
  });

  return latest?.status === "NO_KNOWN_ALLERGIES";
}

/**
 * The allergy records to hand the engine.
 *
 * Returns only screenable records, so the engine is never given a row
 * it will silently skip. An empty result is legitimate and means
 * exactly one thing by the time it is used: the caller has declared the
 * axis AVAILABLE on the strength of a NO_KNOWN_ALLERGIES assertion.
 * If the axis were NOT_RECORDED_FOR_SUBJECT the engine would not read
 * the list at all.
 */
export async function loadScreenableAllergies(
  scope: PatientScreeningScope
): Promise<ReadonlyArray<RecordedAllergy>> {
  const rows = await loadCandidateRows(scope);

  return rows.filter(isScreenableRow).map((row) => ({
    recordId: row.id,
    // Non-null by `isScreenableRow`: an UNCODED record has a null code
    // and is not screenable, and the CHECK constraint
    // `patient_allergy_substance_code_matches_system` makes the
    // converse impossible. The fallback is unreachable and exists so a
    // future constraint change cannot turn a null into the empty string
    // silently — the empty string would match no ingredient and read as
    // clean.
    substanceCode: row.substanceCode ?? UNREACHABLE_SUBSTANCE_CODE,
    category: row.category,
    type: row.type,
    criticality: row.criticality,
    verificationStatus: row.verificationStatus,
  }));
}

/**
 * A code no knowledge source can match, used where a null substance
 * code is unreachable. Chosen over `""` so that if it ever DOES appear
 * in a finding, it names itself as a bug rather than looking like data.
 */
const UNREACHABLE_SUBSTANCE_CODE = "__PHARMAX_INVARIANT_VIOLATION_UNCODED__";

/**
 * Rows in a state that could matter to a screen.
 *
 * Filtered to ACTIVE in the query rather than in memory, so the
 * `(organizationId, patientId, clinicalStatus)` index does the work and
 * a patient with a long retired-allergy history does not drag it into
 * the transaction. The remaining screenability rules are evaluated in
 * memory because they belong to `@pharmax/clinical-screening` and must
 * not be restated as a `where` clause — two copies of that policy is
 * exactly how a screen ends up disagreeing with itself.
 */
async function loadCandidateRows(scope: PatientScreeningScope): Promise<ReadonlyArray<AllergyRow>> {
  const rows = await scope.tx.patientAllergy.findMany({
    where: {
      organizationId: scope.organizationId,
      patientId: scope.patientId,
      clinicalStatus: AllergyClinicalStatusEnum.ACTIVE,
    },
    select: SCREENING_SELECT,
    // One more than the cap, so "too many" is detectable rather than
    // silently truncated.
    take: MAX_SCREENED_ALLERGIES + 1,
  });

  if (rows.length > MAX_SCREENED_ALLERGIES) {
    throw new errors.InvariantViolationError({
      code: PV1_SCREENING_ALLERGY_PROFILE_TOO_LARGE,
      message:
        `The patient carries more than ${MAX_SCREENED_ALLERGIES} active allergy records. ` +
        "Screening against a subset would produce a confident, incomplete result, so the screen was refused. " +
        "Investigate the profile (duplicated intake, or a patient merge that duplicated rows).",
      metadata: { limit: MAX_SCREENED_ALLERGIES },
    });
  }

  return rows;
}
