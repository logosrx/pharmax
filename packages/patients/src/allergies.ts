// Shared vocabulary and read path for the patient allergy profile.
//
// The screening semantics — which records a screen can use — live in
// `@pharmax/clinical-screening` because `@pharmax/verification` needs
// the same answer and the two domain packages may not import each
// other. What lives HERE is everything about capture: the reason codes
// a status change must cite, and the projection the console reads.

import { isScreenableAllergy, type AllergyScreenability } from "@pharmax/clinical-screening";
import {
  AllergyClinicalStatus,
  AllergyVerificationStatus,
  type TenantTransactionClient,
} from "@pharmax/database";

/**
 * Reason codes for a status amendment.
 *
 * A CLOSED LIST, and free text is not an alternative to it. "Every
 * rejection requires a reason code" is a workflow rule precisely
 * because a code is countable: "how often do we refute allergies, and
 * on whose word?" is a question a pharmacy has to be able to answer
 * from a report rather than by reading a year of notes. The operator's
 * own narrative belongs in the encrypted note on the record, not in the
 * field a report groups by.
 *
 * Grouped by the direction they move the record. The two REFUTED_* and
 * two ENTERED_IN_ERROR_* codes are the ones that switch a safety check
 * off, which is why `patients.allergies.amend_status` is a separate,
 * pharmacist-level grant.
 */
export const ALLERGY_STATUS_CHANGE_REASONS = Object.freeze({
  // Corrections — the record should never have existed as written.
  ENTERED_IN_ERROR_WRONG_PATIENT: "entered-in-error-wrong-patient",
  ENTERED_IN_ERROR_DATA_ENTRY: "entered-in-error-data-entry",
  // Refutations — the record described something real, and it turned
  // out not to be an allergy to this substance.
  REFUTED_BY_ALLERGY_TESTING: "refuted-by-allergy-testing",
  REFUTED_BY_TOLERATED_RECHALLENGE: "refuted-by-tolerated-rechallenge",
  REFUTED_PATIENT_CORRECTION: "refuted-patient-correction",
  REFUTED_PRESCRIBER_CORRECTION: "refuted-prescriber-correction",
  // Lifecycle — it was an allergy and the propensity has changed.
  RESOLVED_OUTGROWN: "resolved-outgrown",
  RESOLVED_TOLERANCE_ESTABLISHED: "resolved-tolerance-established",
  INACTIVE_NO_LONGER_RELEVANT: "inactive-no-longer-relevant",
  // Strengthening — the record is being upgraded, not retired.
  CONFIRMED_BY_ALLERGY_TESTING: "confirmed-by-allergy-testing",
  CONFIRMED_BY_PRESCRIBER: "confirmed-by-prescriber",
  CONFIRMED_BY_PATIENT_INTERVIEW: "confirmed-by-patient-interview",
  REACTIVATED_RECURRENCE: "reactivated-recurrence",
} as const);

export type AllergyStatusChangeReason =
  (typeof ALLERGY_STATUS_CHANGE_REASONS)[keyof typeof ALLERGY_STATUS_CHANGE_REASONS];

export const ALLERGY_STATUS_CHANGE_REASON_CODES: ReadonlyArray<AllergyStatusChangeReason> =
  Object.freeze(Object.values(ALLERGY_STATUS_CHANGE_REASONS));

/**
 * The columns needed to decide whether a stored row is screenable.
 *
 * Deliberately narrow: a caller answering "can the screen use this?"
 * should not have to select the encrypted narrative to find out.
 */
export interface AllergyScreenabilityRow {
  readonly category: AllergyScreenability["category"];
  readonly clinicalStatus: AllergyScreenability["clinicalStatus"];
  readonly verificationStatus: AllergyScreenability["verificationStatus"];
  readonly substanceCodeSystem: AllergyScreenability["substanceCodeSystem"];
}

/**
 * Whether the PV1 screening engine can use this stored row.
 *
 * A one-line pass-through to `@pharmax/clinical-screening` on purpose.
 * The point is that the answer has exactly one implementation: the
 * screening layer that DECIDES `ScreeningInputAvailability` and this
 * package that REPORTS coverage must not be able to disagree, because
 * disagreeing in the optimistic direction means the axis claims a
 * screen the engine did not run.
 */
export function isScreenableAllergyRow(row: AllergyScreenabilityRow): boolean {
  return isScreenableAllergy(row);
}

/**
 * One allergy as the console shows it.
 *
 * `substanceLabel` and `reactionNote` arrive decrypted; a caller that
 * cannot decrypt passes `null` and the UI says so rather than implying
 * the field was empty. That distinction matters most for an UNCODED
 * record, where the label is the entire clinical content.
 */
export interface PatientAllergyView {
  readonly allergyId: string;
  readonly substanceCode: string | null;
  readonly substanceCodeSystem: AllergyScreenability["substanceCodeSystem"];
  readonly substanceLabel: string | null;
  readonly category: AllergyScreenability["category"];
  readonly type: "ALLERGY" | "INTOLERANCE";
  readonly criticality: "HIGH" | "LOW" | "UNABLE_TO_ASSESS";
  readonly clinicalStatus: AllergyScreenability["clinicalStatus"];
  readonly verificationStatus: AllergyScreenability["verificationStatus"];
  readonly reactionManifestations: ReadonlyArray<string>;
  readonly reactionSeverity: string | null;
  readonly reactionNote: string | null;
  readonly onsetDate: Date | null;
  readonly recordedAt: Date;
  readonly statusChangeReason: string | null;
  /** Whether PV1 screening can use this row. Drives the console badge. */
  readonly screenable: boolean;
}

/**
 * Whether an allergy history has been taken for this patient, and what
 * it said.
 *
 * THREE STATES, NOT TWO, and the third is the whole reason this type
 * exists. `NOT_ASKED` is not a variant of "no allergies" — it is the
 * absence of the question, and a console that rendered the two the same
 * way would be the bug this feature was built to fix.
 */
export type AllergyHistoryState =
  | { readonly kind: "NOT_ASKED" }
  | {
      readonly kind: "NO_KNOWN_ALLERGIES";
      readonly assertedAt: Date;
      readonly assertedByUserId: string;
    }
  | {
      readonly kind: "UNABLE_TO_ASSESS";
      readonly assertedAt: Date;
      readonly assertedByUserId: string;
    };

/**
 * Read the current allergy-history assertion for a patient.
 *
 * The most recent row wins; earlier rows are the audit trail of who
 * said what. Ties on `assertedAt` fall back to `createdAt` then `id` so
 * two assertions backfilled with the same clinical time still resolve
 * deterministically — a screen that answered differently on two reads
 * of unchanged data would be worse than either answer.
 */
export async function loadAllergyHistoryState(input: {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  readonly patientId: string;
}): Promise<AllergyHistoryState> {
  const latest = await input.tx.patientAllergyHistoryAssertion.findFirst({
    where: { organizationId: input.organizationId, patientId: input.patientId },
    orderBy: [{ assertedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { status: true, assertedAt: true, assertedByUserId: true },
  });

  if (latest === null) return { kind: "NOT_ASKED" };
  return {
    kind: latest.status,
    assertedAt: latest.assertedAt,
    assertedByUserId: latest.assertedByUserId,
  };
}

/**
 * True when the allergy history is KNOWN to be empty.
 *
 * `UNABLE_TO_ASSESS` deliberately returns false. "We tried and could
 * not find out" is a different clinical statement from "we asked and
 * there is nothing", and treating them alike would let a failed history
 * open the screening axis — which would report a clean allergy check
 * for the patient we know least about.
 */
export function assertsEmptyAllergyHistory(state: AllergyHistoryState): boolean {
  return state.kind === "NO_KNOWN_ALLERGIES";
}

/**
 * The clinical statuses a status amendment may set, paired with the
 * verification statuses, so a caller reading this file can see the
 * retraction paths in one place:
 *
 *   entered in error  → verificationStatus ENTERED_IN_ERROR
 *   disproved         → verificationStatus REFUTED
 *   outgrown/resolved → clinicalStatus RESOLVED
 *   no longer tracked → clinicalStatus INACTIVE
 *   upgraded          → verificationStatus CONFIRMED
 *
 * None of these delete anything. There is no DELETE grant on
 * `patient_allergy` and no RLS policy for it.
 */
export const ALLERGY_RETRACTING_VERIFICATION_STATUSES: ReadonlyArray<AllergyVerificationStatus> =
  Object.freeze([AllergyVerificationStatus.REFUTED, AllergyVerificationStatus.ENTERED_IN_ERROR]);

export const ALLERGY_RETIRING_CLINICAL_STATUSES: ReadonlyArray<AllergyClinicalStatus> =
  Object.freeze([AllergyClinicalStatus.INACTIVE, AllergyClinicalStatus.RESOLVED]);
