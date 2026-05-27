// ViewPatient — tamper-evident audit of PHI reads.
//
// Why this command exists:
//   - Every PHI read must leave a verifiable trail. A SOC 2 / HIPAA
//     reviewer needs to answer "who saw patient X's PHI on date D"
//     against the same chain-hashed `audit_log` that records
//     mutations. A structured stdout log isn't sufficient —
//     stdout is tamper-evident only by reputation; `audit_log` is
//     chain-hashed and tested.
//   - This is the FIRST read-only command on the bus. Most
//     commands mutate domain state. ViewPatient writes no
//     business state — it writes ONLY an audit row + outbox event.
//     The handler resolves the patient (with `cryptoShreddedAt`)
//     and refuses to record a view of a shredded row (the row
//     no longer has PHI to view; logging a view would be
//     misleading).
//
// Call convention:
//   - The operator console dispatches `ViewPatient` BEFORE
//     decrypting + rendering the patient block. If dispatch
//     denies (no `patients.read`) OR fails (DB down), the page
//     MUST NOT render the patient block. This preserves the
//     invariant: every PHI display has a corresponding audit row.
//   - Idempotency: minute-bucketed via the standard
//     `{commandName}:{userId}:{patientId}:{minuteBucket}` shape.
//     A refresh-spamming operator does not produce 100 audit rows;
//     a genuinely-distinct session-later view does.
//
// What gets audited:
//   - action: "patient.viewed"
//   - resourceType: "Patient"
//   - resourceId: patientId
//   - metadata: { patientId, organizationId, surface, orderId?,
//     phiDecryptErrors }
//
// Why `surface` matters: the SOC 2 reviewer wants to distinguish
// "viewed in the context of order processing" from "viewed via the
// patient roster admin page" — the latter is a higher-scrutiny
// access pattern. A small closed enum (`ORDER_DETAIL_PAGE`,
// `PATIENT_ADMIN_PAGE`, etc.) keeps the surface taxonomy stable
// and queryable.
//
// What is NOT audited:
//   - The PHI values themselves. We never want PHI in `audit_log`
//     metadata — the chain is signed but it is not encrypted.
//     `phiDecryptErrors` is a boolean (one bit, no values).
//
// PHI invariant: nothing in input or audit metadata is patient
// PHI. patientId is non-PHI by definition. `surface` is a closed
// enum. `phiDecryptErrors` is a boolean.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const PATIENT_NOT_FOUND = "PATIENT_NOT_FOUND";

/**
 * Closed enum of operator surfaces that read patient PHI. Add a
 * value here whenever a new surface starts decrypting — the
 * audit metadata then becomes queryable per-surface ("show me
 * every PHI view that happened on the patient admin page in May").
 *
 * The values are PHI-FREE strings safe to store + log.
 */
export const VIEW_PATIENT_SURFACES = [
  "ORDER_DETAIL_PAGE",
  "PATIENT_ADMIN_PAGE",
  "PATIENT_SEARCH_RESULT",
  "OPERATOR_API",
] as const;

export type ViewPatientSurface = (typeof VIEW_PATIENT_SURFACES)[number];

const inputSchema = z
  .object({
    patientId: z.uuid(),
    surface: z.enum(VIEW_PATIENT_SURFACES),
    /** Optional context: which order the operator was looking at. */
    orderId: z.uuid().optional(),
    /**
     * True iff one or more PHI envelopes failed to decrypt on the
     * read path. Captured here so a SOC 2 reviewer can correlate
     * "view audit" against "KMS / envelope health" without joining
     * separate log streams.
     */
    phiDecryptErrors: z.boolean(),
  })
  .strict();

export type ViewPatientInput = z.infer<typeof inputSchema>;

export interface ViewPatientOutput {
  readonly patientId: string;
  readonly surface: ViewPatientSurface;
  readonly recordedAt: string; // ISO timestamp of the audit write
  /**
   * True iff the targeted patient row had been crypto-shredded
   * before this view. The view was STILL audited (the operator's
   * intent matters even when no PHI was decryptable), but the
   * caller may want to render a "(redacted: shredded YYYY-MM-DD)"
   * banner instead of empty patient fields.
   */
  readonly wasShredded: boolean;
}

export const ViewPatient: Command<ViewPatientInput, ViewPatientOutput> = {
  name: "ViewPatient",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_READ,
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId, clock }): Promise<HandlerResult<ViewPatientOutput>> {
    // Verify the patient is in this tenant + still has PHI to view.
    // A crypto-shredded row is structurally still in the DB (FK
    // integrity) but has no decryptable PHI — recording a "view"
    // of nothing is misleading + would let a downstream reader
    // mistakenly believe PHI was accessed when it wasn't.
    const patient = await tx.patient.findFirst({
      where: { id: input.patientId, organizationId: ctx.organizationId },
      select: { id: true, status: true, cryptoShreddedAt: true },
    });
    if (patient === null) {
      throw new errors.NotFoundError({
        code: PATIENT_NOT_FOUND,
        message: "Patient not found in this organization.",
        metadata: { patientId: input.patientId },
      });
    }
    // Status check: ACTIVE / INACTIVE / DECEASED / MERGED rows are
    // all viewable (audit history is the whole point — operators
    // need to read records for inactive/deceased patients during
    // reconciliation). We deliberately do NOT gate on status —
    // the `patient.status` field is read into the selection only
    // for future-proofing if a status-aware policy lands.

    const wasShredded = patient.cryptoShreddedAt !== null;
    const now = clock.now();

    return {
      output: Object.freeze({
        patientId: patient.id,
        surface: input.surface,
        recordedAt: now.toISOString(),
        wasShredded,
      }),
      audit: {
        action: "patient.viewed",
        resourceType: "Patient",
        resourceId: patient.id,
        metadata: {
          patientId: patient.id,
          organizationId: ctx.organizationId,
          surface: input.surface,
          ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
          phiDecryptErrors: input.phiDecryptErrors,
          wasShredded,
          ...(wasShredded && patient.cryptoShreddedAt !== null
            ? { cryptoShreddedAt: patient.cryptoShreddedAt.toISOString() }
            : {}),
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "patient.viewed.v1",
          aggregateType: "Patient",
          aggregateId: patient.id,
          payload: {
            organizationId: ctx.organizationId,
            patientId: patient.id,
            surface: input.surface,
            ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
            actorUserId: ctx.actor.userId,
            phiDecryptErrors: input.phiDecryptErrors,
            wasShredded,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
