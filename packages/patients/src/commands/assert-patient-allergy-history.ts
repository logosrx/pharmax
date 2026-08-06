// AssertPatientAllergyHistory — record that somebody took an allergy
// history, and what it found.
//
// This is the command that makes "no known allergies" a fact instead of
// an absence. Without it, a patient with zero allergy rows and a patient
// nobody has ever asked look identical in the database, and the PV1
// screening layer has to assume the dangerous one — which means a
// genuinely allergy-free patient would carry an unclosable
// acknowledgement on every order forever, and the acknowledgement would
// be trained away.
//
// TWO STATUSES, AND THE SECOND IS THE HONEST ONE.
//
//   NO_KNOWN_ALLERGIES — asked, patient reports none. This is what lets
//     the DRUG_ALLERGY axis be declared AVAILABLE and screen clear.
//   UNABLE_TO_ASSESS — asked, no answer obtainable (no historian, the
//     patient cannot answer). It records the attempt and deliberately
//     does NOT satisfy the axis. Making it satisfy the axis would be the
//     single most dangerous line in this feature: it would report a
//     clean allergy screen for the patient we know least about.
//
// APPEND-ONLY. Asserting again writes a new row; the previous assertion
// is never updated or deleted, because it is exactly the record that
// answers "who said this patient had no allergies, and when, before the
// reaction?". `patient_allergy_history_assertion` has SELECT + INSERT
// grants only.
//
// PHI. Nothing encrypted. Ids, one enum, two timestamps.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import type { AllergyHistoryAssertionStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

/**
 * How far back a history may be backfilled.
 *
 * Backfilling is legitimate — a history taken at the referring clinic
 * last week is the real clinical time — but an assertion dated years ago
 * is either a typo or an attempt to make a stale history look current,
 * and this assertion is what opens the screening axis.
 */
export const MAX_ALLERGY_HISTORY_BACKFILL_DAYS = 90;

const inputSchema = z
  .object({
    patientId: z.string().uuid(),
    status: z.enum(["NO_KNOWN_ALLERGIES", "UNABLE_TO_ASSESS"]),
    /**
     * When the history was TAKEN. Optional; defaults to now. Accepted as
     * an ISO string rather than a Date because the bus serialises inputs
     * into `command_log.requestPayload` as JSON, and a string
     * round-trips where a Date does not.
     */
    assertedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type AssertPatientAllergyHistoryInput = z.infer<typeof inputSchema>;

export interface AssertPatientAllergyHistoryOutput {
  readonly assertionId: string;
  /**
   * Whether this assertion opens the DRUG_ALLERGY screening axis.
   * True only for NO_KNOWN_ALLERGIES — returned explicitly so a console
   * can tell an operator that UNABLE_TO_ASSESS did not close the gap.
   */
  readonly satisfiesAllergyScreening: boolean;
}

export const ALLERGY_HISTORY_PATIENT_NOT_FOUND = "ALLERGY_HISTORY_PATIENT_NOT_FOUND";
export const ALLERGY_HISTORY_ASSERTED_IN_FUTURE = "ALLERGY_HISTORY_ASSERTED_IN_FUTURE";
export const ALLERGY_HISTORY_ASSERTED_TOO_LONG_AGO = "ALLERGY_HISTORY_ASSERTED_TOO_LONG_AGO";

export const AssertPatientAllergyHistory: Command<
  AssertPatientAllergyHistoryInput,
  AssertPatientAllergyHistoryOutput
> = {
  name: "AssertPatientAllergyHistory",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_ALLERGIES_RECORD,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<AssertPatientAllergyHistoryOutput>> {
    const now = clock.now();

    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: { id: true, clinicId: true },
    });
    if (patient === null) {
      throw new errors.ValidationError({
        code: ALLERGY_HISTORY_PATIENT_NOT_FOUND,
        message: "Patient does not exist or is not in this organization.",
        issues: [{ path: ["patientId"], message: "unknown patient" }],
        metadata: { patientId: input.patientId },
      });
    }

    const assertedAt = input.assertedAt === undefined ? now : new Date(input.assertedAt);

    // A history taken in the future is a clock or timezone bug, and
    // because the LATEST assertion wins it would pin the patient's
    // allergy state until real time caught up — outranking every
    // correct assertion made in between.
    if (assertedAt.getTime() > now.getTime()) {
      throw new errors.ValidationError({
        code: ALLERGY_HISTORY_ASSERTED_IN_FUTURE,
        message: "An allergy history cannot be recorded as having been taken in the future.",
        issues: [{ path: ["assertedAt"], message: "must not be in the future" }],
        metadata: { patientId: input.patientId },
      });
    }

    const oldestAllowed = now.getTime() - MAX_ALLERGY_HISTORY_BACKFILL_DAYS * 86_400_000;
    if (assertedAt.getTime() < oldestAllowed) {
      throw new errors.ValidationError({
        code: ALLERGY_HISTORY_ASSERTED_TOO_LONG_AGO,
        message:
          `An allergy history dated more than ${MAX_ALLERGY_HISTORY_BACKFILL_DAYS} days ago cannot be backfilled. ` +
          "This assertion is what allows allergy screening to report clear, so it has to reflect a history somebody actually took recently.",
        issues: [{ path: ["assertedAt"], message: "too far in the past" }],
        metadata: { patientId: input.patientId, maxDays: MAX_ALLERGY_HISTORY_BACKFILL_DAYS },
      });
    }

    const assertionId = randomUUID();

    await tx.patientAllergyHistoryAssertion.create({
      data: {
        id: assertionId,
        organizationId: ctx.organizationId,
        clinicId: patient.clinicId,
        patientId: input.patientId,
        status: input.status as AllergyHistoryAssertionStatus,
        assertedByUserId: ctx.actor.userId,
        assertedAt,
      },
    });

    const satisfiesAllergyScreening = input.status === "NO_KNOWN_ALLERGIES";

    return {
      output: { assertionId, satisfiesAllergyScreening },
      audit: {
        action: "patient.allergy_history.asserted",
        resourceType: "PatientAllergyHistoryAssertion",
        resourceId: assertionId,
        metadata: {
          patientId: input.patientId,
          clinicId: patient.clinicId,
          status: input.status,
          assertedAt: assertedAt.toISOString(),
          satisfiesAllergyScreening,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "patient.allergy_history.asserted.v1",
          aggregateType: "Patient",
          aggregateId: input.patientId,
          payload: {
            assertionId,
            patientId: input.patientId,
            organizationId: ctx.organizationId,
            clinicId: patient.clinicId,
            status: input.status,
            assertedAt: assertedAt.toISOString(),
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
