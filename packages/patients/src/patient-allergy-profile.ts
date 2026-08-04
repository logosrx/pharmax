// The patient's allergy profile as a reader sees it: every recorded
// allergy, plus the answer to the question the list alone cannot
// answer — has anybody actually asked?
//
// -------------------------------------------------------------------
// WHY THE HISTORY STATE IS PART OF THIS TYPE AND NOT A SEPARATE CALL
// -------------------------------------------------------------------
//
// Because a caller that can obtain the allergy list without obtaining
// the history state will render an empty list, and an empty list is the
// ambiguity this whole feature exists to destroy. Making them one
// projection means there is no way to build an allergy panel that
// cannot distinguish "asked, nothing found" from "never asked".
//
// PHI. This function DECRYPTS: `substanceLabel` and `reactionNote` come
// back as plaintext. That makes every caller a PHI-access surface, and
// callers are expected to be gated on `patients.allergies.read` and to
// leave an audit entry — the console page does both. A decrypt failure
// yields `null` for that field and sets `phiDecryptErrors`, so a
// partially readable profile is visibly partial rather than
// indistinguishable from a shorter one.

import { decryptField } from "@pharmax/crypto";
import type { TenantTransactionClient } from "@pharmax/database";

import {
  isScreenableAllergyRow,
  type AllergyHistoryState,
  type PatientAllergyView,
} from "./allergies.js";
import { loadAllergyHistoryState } from "./allergies.js";

/**
 * Cap on the allergies loaded for one patient.
 *
 * A `take` rather than a refusal, unlike the medication-profile cap in
 * `run-screen.ts`, and the difference is what the number is used for.
 * That cap guards a SCREEN, where an arbitrary subset produces a
 * confident wrong answer. This is a display projection; the screening
 * layer reads its own rows. Two hundred recorded allergies is already a
 * data-quality problem, and truncating the display of it is not a safety
 * decision.
 */
export const MAX_PATIENT_ALLERGIES = 200;

export interface PatientAllergyProfile {
  readonly patientId: string;
  /** Newest first. Includes inactive, resolved, refuted and erroneous
   * records — a pharmacist wants to see a retracted allergy and who
   * retracted it, and the console styles them differently. */
  readonly allergies: ReadonlyArray<PatientAllergyView>;
  readonly historyState: AllergyHistoryState;
  /**
   * Allergies the PV1 engine can actually use. NOT the same as
   * `allergies.length`: uncoded, non-drug, retired and refuted records
   * are all real records the engine cannot compare.
   */
  readonly screenableCount: number;
  /** True when at least one envelope column failed to decrypt. */
  readonly phiDecryptErrors: boolean;
}

export async function getPatientAllergyProfile(input: {
  readonly tx: TenantTransactionClient;
  readonly organizationId: string;
  readonly patientId: string;
}): Promise<PatientAllergyProfile> {
  const [rows, historyState] = await Promise.all([
    input.tx.patientAllergy.findMany({
      where: { organizationId: input.organizationId, patientId: input.patientId },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: MAX_PATIENT_ALLERGIES,
    }),
    loadAllergyHistoryState({
      tx: input.tx,
      organizationId: input.organizationId,
      patientId: input.patientId,
    }),
  ]);

  let phiDecryptErrors = false;

  const decrypt = async (
    envelope: unknown,
    column: string,
    recordId: string
  ): Promise<string | null> => {
    if (envelope === null || envelope === undefined) return null;
    try {
      return await decryptField({
        envelope,
        binding: {
          tenantId: input.organizationId,
          table: "patient_allergy",
          column,
          recordId,
        },
      });
    } catch {
      // Swallowed deliberately, and recorded. The alternative — throwing
      // — would blank the whole panel because one narrative field could
      // not be read, hiding the coded allergies that decrypt fine and
      // that a pharmacist most needs. The error is surfaced as a banner
      // instead. Nothing about the failure is logged here: the message
      // would name the column and the record.
      phiDecryptErrors = true;
      return null;
    }
  };

  const allergies: PatientAllergyView[] = [];
  for (const row of rows) {
    const [substanceLabel, reactionNote] = await Promise.all([
      decrypt(row.substanceLabelEnc, "substanceLabel", row.id),
      decrypt(row.reactionNoteEnc, "reactionNote", row.id),
    ]);

    allergies.push(
      Object.freeze({
        allergyId: row.id,
        substanceCode: row.substanceCode,
        substanceCodeSystem: row.substanceCodeSystem,
        substanceLabel,
        category: row.category,
        type: row.type,
        criticality: row.criticality,
        clinicalStatus: row.clinicalStatus,
        verificationStatus: row.verificationStatus,
        reactionManifestations: Object.freeze([...row.reactionManifestations]),
        reactionSeverity: row.reactionSeverity,
        reactionNote,
        onsetDate: row.onsetDate,
        recordedAt: row.recordedAt,
        statusChangeReason: row.statusChangeReason,
        screenable: isScreenableAllergyRow({
          category: row.category,
          clinicalStatus: row.clinicalStatus,
          verificationStatus: row.verificationStatus,
          substanceCodeSystem: row.substanceCodeSystem,
        }),
      })
    );
  }

  return Object.freeze({
    patientId: input.patientId,
    allergies: Object.freeze(allergies),
    historyState,
    screenableCount: allergies.filter((a) => a.screenable).length,
    phiDecryptErrors,
  });
}
