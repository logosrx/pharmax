// AmendPatientAllergyStatus — correct or retire a recorded allergy
// WITHOUT deleting it.
//
// This is the retraction path, and the only edit this slice offers to an
// existing allergy row. It exists because clinical data is corrected,
// not erased: an allergy entered against the wrong patient must stop
// driving the PV1 screen while remaining in the record, because the
// question "what was this pharmacist shown when they approved?" has to
// stay answerable after the mistake is found.
//
// The database backs that up rather than trusting this handler. There is
// no DELETE grant on `patient_allergy` and no RLS policy FOR DELETE, so
// two independent layers would have to be re-opened before a row could
// be destroyed.
//
// PERMISSION. `patients.allergies.amend_status` is deliberately separate
// from `patients.allergies.record` and is granted to pharmacists, not
// technicians. Recording a wrong allergy costs a false alert; refuting a
// right one costs the alert that mattered. Those are not the same risk
// and should not share a grant.
//
// PHI. Nothing encrypted is read or written here. The audit metadata and
// event payload carry the previous and new statuses, a reason CODE, and
// ids. No substance, no narrative.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_VERIFICATION_STATUSES,
} from "@pharmax/clinical-screening";
import type { AllergyClinicalStatus, AllergyVerificationStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { ALLERGY_STATUS_CHANGE_REASON_CODES, isScreenableAllergyRow } from "../allergies.js";

const reasonCodes = ALLERGY_STATUS_CHANGE_REASON_CODES as unknown as [string, ...string[]];

const inputSchema = z
  .object({
    allergyId: z.string().uuid(),

    // Both statuses are optional, but at least one must actually change
    // — enforced in the handler against the stored row, since Zod
    // cannot see it. Omitting a status leaves it alone rather than
    // resetting it to a default: an amendment that silently reactivated
    // a resolved allergy because the caller only meant to confirm it
    // would be a change nobody asked for.
    clinicalStatus: z.enum(ALLERGY_CLINICAL_STATUSES).optional(),
    verificationStatus: z.enum(ALLERGY_VERIFICATION_STATUSES).optional(),

    /**
     * Required, always. A status change with no reason is a change
     * nobody can explain a year later, which is the state this field
     * exists to prevent — and the database agrees, via the
     * `patient_allergy_status_change_fully_stamped` CHECK.
     */
    reasonCode: z.enum(reasonCodes),
  })
  .strict()
  .refine((v) => v.clinicalStatus !== undefined || v.verificationStatus !== undefined, {
    message: "at least one of clinicalStatus or verificationStatus must be supplied",
    path: ["clinicalStatus"],
  });

export type AmendPatientAllergyStatusInput = z.infer<typeof inputSchema>;

export interface AmendPatientAllergyStatusOutput {
  readonly allergyId: string;
  readonly patientId: string;
  /**
   * Whether the record still counts as screenable input after the
   * amendment. The consequential fact: an operator who has just refuted
   * a patient's only screenable allergy has changed what PV1 will do.
   */
  readonly screenable: boolean;
}

export const ALLERGY_NOT_FOUND = "ALLERGY_NOT_FOUND";
export const ALLERGY_STATUS_UNCHANGED = "ALLERGY_STATUS_UNCHANGED";

export const AmendPatientAllergyStatus: Command<
  AmendPatientAllergyStatusInput,
  AmendPatientAllergyStatusOutput
> = {
  name: "AmendPatientAllergyStatus",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_ALLERGIES_AMEND_STATUS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<AmendPatientAllergyStatusOutput>> {
    const now = clock.now();

    const existing = await tx.patientAllergy.findUnique({
      where: { id: input.allergyId },
      select: {
        id: true,
        patientId: true,
        clinicId: true,
        category: true,
        clinicalStatus: true,
        verificationStatus: true,
        substanceCodeSystem: true,
      },
    });
    if (existing === null) {
      throw new errors.ValidationError({
        code: ALLERGY_NOT_FOUND,
        message: "Allergy record does not exist or is not in this organization.",
        issues: [{ path: ["allergyId"], message: "unknown allergy" }],
        metadata: { allergyId: input.allergyId },
      });
    }

    const nextClinicalStatus = (input.clinicalStatus ??
      existing.clinicalStatus) as AllergyClinicalStatus;
    const nextVerificationStatus = (input.verificationStatus ??
      existing.verificationStatus) as AllergyVerificationStatus;

    // A no-op amendment is refused rather than accepted quietly.
    //
    // Not pedantry: accepting it writes a status-change stamp and a
    // reason code onto a record whose status did not change, which reads
    // in the audit trail as a clinical decision that was never made.
    // A genuine retry of the same request replays through the bus's
    // idempotency layer and never reaches here.
    if (
      nextClinicalStatus === existing.clinicalStatus &&
      nextVerificationStatus === existing.verificationStatus
    ) {
      throw new errors.ValidationError({
        code: ALLERGY_STATUS_UNCHANGED,
        message:
          "This amendment would not change either status. Supply a status that differs from the record's current state.",
        issues: [{ path: ["clinicalStatus"], message: "no change requested" }],
        metadata: {
          allergyId: input.allergyId,
          clinicalStatus: existing.clinicalStatus,
          verificationStatus: existing.verificationStatus,
        },
      });
    }

    await tx.patientAllergy.update({
      where: { id: input.allergyId },
      data: {
        clinicalStatus: nextClinicalStatus,
        verificationStatus: nextVerificationStatus,
        statusChangedByUserId: ctx.actor.userId,
        statusChangedAt: now,
        statusChangeReason: input.reasonCode,
      },
    });

    const screenable = isScreenableAllergyRow({
      category: existing.category,
      clinicalStatus: nextClinicalStatus,
      verificationStatus: nextVerificationStatus,
      substanceCodeSystem: existing.substanceCodeSystem,
    });

    return {
      output: { allergyId: input.allergyId, patientId: existing.patientId, screenable },
      audit: {
        action: "patient.allergy.status_amended",
        resourceType: "PatientAllergy",
        resourceId: input.allergyId,
        metadata: {
          patientId: existing.patientId,
          clinicId: existing.clinicId,
          previousClinicalStatus: existing.clinicalStatus,
          clinicalStatus: nextClinicalStatus,
          previousVerificationStatus: existing.verificationStatus,
          verificationStatus: nextVerificationStatus,
          reasonCode: input.reasonCode,
          screenable,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "patient.allergy.status.amended.v1",
          aggregateType: "Patient",
          aggregateId: existing.patientId,
          payload: {
            allergyId: input.allergyId,
            patientId: existing.patientId,
            organizationId: ctx.organizationId,
            clinicId: existing.clinicId,
            previousClinicalStatus: existing.clinicalStatus,
            clinicalStatus: nextClinicalStatus,
            previousVerificationStatus: existing.verificationStatus,
            verificationStatus: nextVerificationStatus,
            reasonCode: input.reasonCode,
            screenable,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
