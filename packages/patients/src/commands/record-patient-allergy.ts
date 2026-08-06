// RecordPatientAllergy — add one allergy or intolerance to a patient.
//
// Not an order-status transition, so this follows the NON-ORDER command
// pattern (`RegisterPatient`): no row lock, no `order_event`, no
// workflow-policy resolution. The bus still owns idempotency,
// `command_log`, the audit write and the outbox write.
//
// PHI. Two columns are encrypted and the rest are not, and the reason is
// on the `patient_allergy` model in `prisma/schema.prisma`: coded values
// are compared by the screening engine inside a transaction and must
// stay indexable; narrative is read by humans only. So:
//
//   - `substanceLabel` and `reactionNote` are AAD-bound envelopes.
//   - Both appear in `redactFields`, so neither reaches
//     `command_log.requestPayload`.
//   - The audit metadata and the outbox payload carry coded values and
//     ids only. The SUBSTANCE CODE is omitted from both: it is the one
//     coded field that says which allergen a named patient reacts to,
//     and pairing it with `patientId` in a payload that fans out to
//     every webhook subscriber is a clinical detail crossing a boundary
//     nobody asked it to cross.
//
// WHAT THIS COMMAND DOES NOT DO. It does not edit an existing allergy.
// Correcting one is `AmendPatientAllergyStatus` (mark the old record
// entered-in-error) followed by recording the corrected one, which is
// standard practice for allergy lists and leaves the mistake visible.
// An in-place content edit would rewrite what a pharmacist saw at a PV1
// that has already happened.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  ALLERGY_CATEGORIES,
  ALLERGY_CRITICALITIES,
  ALLERGY_SUBSTANCE_CODE_SYSTEMS,
  ALLERGY_TYPES,
  ALLERGY_VERIFICATION_STATUSES,
} from "@pharmax/clinical-screening";
import { encryptField } from "@pharmax/crypto";
import type { AllergyReactionSeverity, Prisma } from "@pharmax/database";
import { AllergyClinicalStatus, AllergyReactionManifestation } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { isScreenableAllergyRow } from "../allergies.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const REACTION_MANIFESTATION_VALUES = Object.values(AllergyReactionManifestation) as [
  string,
  ...string[],
];

const inputSchema = z
  .object({
    patientId: z.string().uuid(),

    // The substance. `substanceCode` is required unless the code system
    // is UNCODED, and forbidden when it is — mirrored by a CHECK
    // constraint in the migration, because a rule enforced only in Zod
    // is a rule the seed script and a future backfill do not obey.
    substanceCodeSystem: z.enum(ALLERGY_SUBSTANCE_CODE_SYSTEMS),
    substanceCode: z.string().min(1).max(64).optional(),
    /** PHI. What the patient or clinic actually said. */
    substanceLabel: z.string().min(1).max(300).optional(),

    category: z.enum(ALLERGY_CATEGORIES),
    type: z.enum(ALLERGY_TYPES),
    criticality: z.enum(ALLERGY_CRITICALITIES),
    // Clinical status is not accepted: a newly recorded allergy is
    // ACTIVE. Recording one that is already resolved is a data-migration
    // concern, not an intake one, and allowing it here would let a
    // record land in a state that never screens without anyone
    // deciding to retire it.
    verificationStatus: z.enum(ALLERGY_VERIFICATION_STATUSES).optional(),

    reactionManifestations: z.array(z.enum(REACTION_MANIFESTATION_VALUES)).max(16).optional(),
    reactionSeverity: z.enum(["MILD", "MODERATE", "SEVERE"]).optional(),
    /** PHI. Narrative detail about the reaction. */
    reactionNote: z.string().min(1).max(2000).optional(),

    onsetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .refine((s) => {
        const d = new Date(`${s}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return false;
        return d.toISOString().slice(0, 10) === s;
      }, "not a valid calendar date")
      .optional(),
  })
  .strict()
  .refine((v) => (v.substanceCodeSystem === "UNCODED" ? v.substanceCode === undefined : true), {
    message: "substanceCode must be omitted when substanceCodeSystem is UNCODED",
    path: ["substanceCode"],
  })
  .refine((v) => (v.substanceCodeSystem === "UNCODED" ? v.substanceLabel !== undefined : true), {
    // An UNCODED record with no label is an allergy to nothing
    // describable. It is worse than no record: it occupies the space
    // where a pharmacist would look for the answer.
    message: "substanceLabel is required when substanceCodeSystem is UNCODED",
    path: ["substanceLabel"],
  })
  .refine((v) => (v.substanceCodeSystem === "UNCODED" ? true : v.substanceCode !== undefined), {
    message: "substanceCode is required unless substanceCodeSystem is UNCODED",
    path: ["substanceCode"],
  });

export type RecordPatientAllergyInput = z.infer<typeof inputSchema>;

export interface RecordPatientAllergyOutput {
  readonly allergyId: string;
  /**
   * Whether PV1 screening can use this record. Returned rather than
   * left for the caller to infer, so a console can tell an operator
   * that the record they just entered will be read by a human but not
   * compared by the engine.
   */
  readonly screenable: boolean;
}

/** Narrative fields, scrubbed from `command_log.requestPayload`. */
const PHI_REDACT_FIELDS = Object.freeze(["substanceLabel", "reactionNote"] as const);

export const ALLERGY_PATIENT_NOT_FOUND = "ALLERGY_PATIENT_NOT_FOUND";
export const ALLERGY_PATIENT_SHREDDED = "ALLERGY_PATIENT_SHREDDED";

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const RecordPatientAllergy: Command<RecordPatientAllergyInput, RecordPatientAllergyOutput> =
  {
    name: "RecordPatientAllergy",
    inputSchema,
    permission: PERMISSIONS.PATIENTS_ALLERGIES_RECORD,
    redactFields: PHI_REDACT_FIELDS,

    async handle({
      input,
      ctx,
      tx,
      commandLogId,
      clock,
    }): Promise<HandlerResult<RecordPatientAllergyOutput>> {
      const now = clock.now();
      const tenantId = ctx.organizationId;

      // Step 1 — The patient must exist in this tenant. The tenancy
      // extension scopes the read and RLS enforces the same at the DB
      // layer, so a cross-tenant id returns null on both legs.
      //
      // `clinicId` is read here rather than taken from the caller: an
      // allergy belongs to wherever the patient belongs, and letting a
      // request name its own clinic would let a row be filed under a
      // clinic the patient is not in.
      const patient = await tx.patient.findUnique({
        where: { id: input.patientId },
        select: { id: true, clinicId: true, cryptoShreddedAt: true },
      });
      if (patient === null) {
        throw new errors.ValidationError({
          code: ALLERGY_PATIENT_NOT_FOUND,
          message: "Patient does not exist or is not in this organization.",
          issues: [{ path: ["patientId"], message: "unknown patient" }],
          metadata: { patientId: input.patientId },
        });
      }

      // A shredded patient has had their PHI destroyed under a
      // right-to-be-forgotten request. Writing new PHI against that row
      // would quietly undo the erasure — and the encrypted columns here
      // would be unshreddable, because the shred already ran.
      if (patient.cryptoShreddedAt !== null) {
        throw new errors.ConflictError({
          code: ALLERGY_PATIENT_SHREDDED,
          message:
            "This patient has been crypto-shredded; no further clinical data may be recorded against the record.",
          metadata: { patientId: input.patientId },
        });
      }

      // Step 2 — Pre-issue the id so the AAD binding can include
      // recordId before the row exists (same reason as RegisterPatient).
      const allergyId = randomUUID();

      const enc = async (column: string, plaintext: string) =>
        (await encryptField({
          plaintext,
          binding: { tenantId, table: "patient_allergy", column, recordId: allergyId },
        })) as unknown as Prisma.InputJsonValue;

      const substanceLabelEnc =
        input.substanceLabel === undefined
          ? null
          : await enc("substanceLabel", input.substanceLabel);
      const reactionNoteEnc =
        input.reactionNote === undefined ? null : await enc("reactionNote", input.reactionNote);

      const verificationStatus = input.verificationStatus ?? "UNCONFIRMED";
      const manifestations = (input.reactionManifestations ??
        []) as ReadonlyArray<AllergyReactionManifestation>;

      // Step 3 — Compute screenability from the SAME predicate the
      // screening layer uses, so this command's report and the PV1 axis
      // decision cannot disagree.
      const screenable = isScreenableAllergyRow({
        category: input.category,
        clinicalStatus: "ACTIVE",
        verificationStatus,
        substanceCodeSystem: input.substanceCodeSystem,
      });

      await tx.patientAllergy.create({
        data: {
          id: allergyId,
          organizationId: tenantId,
          clinicId: patient.clinicId,
          patientId: input.patientId,
          ...(input.substanceCode === undefined ? {} : { substanceCode: input.substanceCode }),
          substanceCodeSystem: input.substanceCodeSystem,
          ...(substanceLabelEnc === null ? {} : { substanceLabelEnc }),
          category: input.category,
          type: input.type,
          criticality: input.criticality,
          clinicalStatus: AllergyClinicalStatus.ACTIVE,
          verificationStatus,
          reactionManifestations: [...manifestations],
          ...(input.reactionSeverity === undefined
            ? {}
            : { reactionSeverity: input.reactionSeverity as AllergyReactionSeverity }),
          ...(reactionNoteEnc === null ? {} : { reactionNoteEnc }),
          ...(input.onsetDate === undefined
            ? {}
            : { onsetDate: new Date(`${input.onsetDate}T00:00:00.000Z`) }),
          recordedByUserId: ctx.actor.userId,
          recordedAt: now,
        },
      });

      return {
        output: { allergyId, screenable },
        audit: {
          action: "patient.allergy.recorded",
          resourceType: "PatientAllergy",
          resourceId: allergyId,
          metadata: {
            patientId: input.patientId,
            clinicId: patient.clinicId,
            // Structural and coded only. No substance code, no narrative,
            // no presence flag that would leak the content of one.
            category: input.category,
            type: input.type,
            criticality: input.criticality,
            verificationStatus,
            substanceCodeSystem: input.substanceCodeSystem,
            reactionManifestationCount: manifestations.length,
            hasReactionNote: input.reactionNote !== undefined,
            screenable,
            commandLogId,
          },
        },
        outboxEvents: [
          {
            eventType: "patient.allergy.recorded.v1",
            aggregateType: "Patient",
            aggregateId: input.patientId,
            payload: {
              allergyId,
              patientId: input.patientId,
              organizationId: tenantId,
              clinicId: patient.clinicId,
              category: input.category,
              type: input.type,
              criticality: input.criticality,
              verificationStatus,
              substanceCodeSystem: input.substanceCodeSystem,
              screenable,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
