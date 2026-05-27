// UpdatePatient — edit identity, contact, address, or MRN on an
// existing Patient row.
//
// This is the second PHI-bearing patient command after `RegisterPatient`
// and the reference for every future "selectively re-encrypt a subset
// of columns" pattern across `prescription`, `order_line`, and any
// other table that holds envelope PHI.
//
// Design choices worth reading before you change this file:
//
//   - WE NEVER DECRYPT TO DIFF. The operator's submitted value is
//     authoritative for the columns they name. Two reasons: (1) AAD
//     binding means decrypting "just to compare" is real cryptographic
//     work with a real failure surface (a tampered envelope would
//     throw); (2) the audit trail records OPERATOR INTENT ("the user
//     said: change lastName"), not "the bytes actually changed". A
//     re-set of the same name is still an audit event because the
//     operator explicitly asked for it.
//
//   - TRI-STATE INPUT.
//       * `undefined` (key absent) → leave the column alone.
//       * `null` → clear the column (optional fields only).
//       * `string` → set the column.
//     Identity fields (firstName, lastName, dateOfBirth) cannot be
//     cleared via null; clearing identity is a `CryptoShredPatient`
//     request, not an edit. Zod's `.nullable()` is applied to the
//     optional fields only.
//
//   - LOCKED-OUT STATES. We refuse to update a row that is:
//       * crypto-shredded — PHI was deliberately destroyed; writing
//         new ciphertext after that is a policy violation.
//       * merged — the row is a forwarding tombstone; edits must go
//         to the survivor.
//     DECEASED and INACTIVE are still editable: ops may need to fix
//     a typo'd MRN or address during close-out / archival.
//
//   - CAS PREDICATE. We use `updateMany` with a where clause that
//     re-checks `cryptoShreddedAt: null` AND `status: { not: MERGED }`.
//     A concurrent shred or merge between our read and our write
//     returns `count: 0`, which we translate to a typed
//     `PATIENT_UPDATE_RACE_LOST` so the API layer surfaces 409.
//
//   - SEARCHABLE FIELD COUPLING. Every searchable field has a partner
//     `*Bi` column. When the encrypted column moves, the BI MUST
//     move with it in the same SQL statement — otherwise search
//     produces stale matches. DOB is special: updating dateOfBirth
//     refreshes BOTH `dobBi` (full date) and `dobYearMonthBi` (the
//     fuzzy-match column).
//
// PHI rule:
//   - `audit.metadata` is PHI-FREE. We log `clinicId` (queryability),
//     `commandLogId`, and two STRUCTURAL lists: `updatedFields` (keys
//     that received a new value) and `clearedFields` (optional keys
//     explicitly set to null). Column names, not values.
//   - `outboxEvents[].payload` is PHI-FREE. Same lists; no plaintext.
//   - The bus's `redactFields` list scrubs every PHI key from
//     `command_log.requestPayload`. List is identical to
//     `RegisterPatient`'s — clinicId stays in the clear in both.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import { PatientStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { PATIENT_BLIND_INDEX } from "../blind-indexes.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const sexAtBirthEnum = z.enum(["MALE", "FEMALE", "INTERSEX", "UNKNOWN", "OTHER"]);

// Same DOB validator as RegisterPatient. Repeated here so the two
// commands stay independently legible; the cost of duplication is
// 6 lines, the cost of an indirection is forever.
const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

const inputSchema = z
  .object({
    patientId: z.string().uuid(),

    // Identity — string-only patches. Use `CryptoShredPatient` to
    // remove identity; this command refuses (Zod rejects `null`).
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    dateOfBirth: dateOfBirthSchema.optional(),

    // Optional fields — string sets a new value, null explicitly
    // clears, absent leaves the existing column alone.
    middleName: z.string().min(1).max(100).nullable().optional(),
    sexAtBirth: sexAtBirthEnum.nullable().optional(),
    ssnLast4: z
      .string()
      .regex(/^\d{4}$/, "must be exactly 4 digits")
      .nullable()
      .optional(),
    phone: z.string().min(7).max(40).nullable().optional(),
    email: z.email().max(320).nullable().optional(),
    addressLine1: z.string().min(1).max(200).nullable().optional(),
    addressLine2: z.string().min(1).max(200).nullable().optional(),
    city: z.string().min(1).max(100).nullable().optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "expected 2-letter state code")
      .nullable()
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}(-\d{4})?$/, "expected ZIP or ZIP+4")
      .nullable()
      .optional(),
    mrn: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export type UpdatePatientInput = z.infer<typeof inputSchema>;

export interface UpdatePatientOutput {
  readonly patientId: string;
  /** ISO timestamp at which the update was committed. */
  readonly updatedAt: string;
  /** Sorted list of input keys whose value was SET in this update. */
  readonly updatedFields: ReadonlyArray<string>;
  /** Sorted list of optional keys that were CLEARED (set to null). */
  readonly clearedFields: ReadonlyArray<string>;
}

// Every top-level PHI key. Bus redacts these from `command_log.requestPayload`.
const PHI_REDACT_FIELDS = Object.freeze([
  "firstName",
  "lastName",
  "middleName",
  "dateOfBirth",
  "sexAtBirth",
  "ssnLast4",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "mrn",
] as const);

// All updatable input keys (excluding patientId). Used to walk the
// input deterministically when building the audit change-set.
// Order here is the audit log's display order; we sort the actual
// emitted lists alphabetically for stable comparisons in tests.
const UPDATABLE_KEYS = Object.freeze([
  "firstName",
  "lastName",
  "dateOfBirth",
  "middleName",
  "sexAtBirth",
  "ssnLast4",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "mrn",
] as const);

// Identity keys cannot be CLEARED. Listed here so the
// "all PHI fields, all change-set logic" pieces below can branch
// the right way without restating the rule.
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["firstName", "lastName", "dateOfBirth"]);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const UpdatePatient: Command<UpdatePatientInput, UpdatePatientOutput> = {
  name: "UpdatePatient",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_UPDATE,
  redactFields: PHI_REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<UpdatePatientOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;

    // ---- Step 1 — Compute the change set. ----
    //
    // We classify each provided key as either "updated" (string value)
    // or "cleared" (explicit null). Absent keys are skipped. Identity
    // keys cannot be cleared — Zod's schema enforces that, but we
    // re-assert with a typed throw as defense in depth.
    const updatedFields: string[] = [];
    const clearedFields: string[] = [];
    const bag = input as unknown as Record<string, string | null | undefined>;

    for (const key of UPDATABLE_KEYS) {
      const v = bag[key];
      if (v === undefined) continue;
      if (v === null) {
        if (IDENTITY_KEYS.has(key)) {
          // Belt and suspenders. Zod's schema doesn't allow null
          // on identity keys, but if a future schema change weakens
          // that and forgets this guard, the handler still refuses.
          throw new errors.ValidationError({
            code: "PATIENT_UPDATE_IDENTITY_CANNOT_CLEAR",
            message: `Identity field "${key}" cannot be cleared — use CryptoShredPatient instead.`,
            issues: [{ path: [key], message: "null not allowed for identity field" }],
          });
        }
        clearedFields.push(key);
      } else {
        updatedFields.push(key);
      }
    }

    if (updatedFields.length === 0 && clearedFields.length === 0) {
      throw new errors.ValidationError({
        code: "PATIENT_UPDATE_NO_CHANGES",
        message: "Update requires at least one field besides patientId.",
        issues: [{ path: [], message: "no updatable fields provided" }],
      });
    }

    // ---- Step 2 — Read the row for guard checks. ----
    //
    // We read ONLY non-PHI columns. The handler never decrypts to
    // diff. `mergedIntoPatientId` and `cryptoShreddedAt` give us the
    // two terminal-state checks; `clinicId` rides into audit metadata
    // so SOC 2 reviewers can scope a "show all edits to clinic X
    // patients" query without joining back to the patient row.
    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: {
        id: true,
        clinicId: true,
        status: true,
        cryptoShreddedAt: true,
        mergedIntoPatientId: true,
      },
    });

    if (patient === null) {
      throw new errors.NotFoundError({
        code: "PATIENT_NOT_FOUND",
        message: "Patient does not exist or is not in this organization.",
        metadata: { patientId: input.patientId },
      });
    }

    if (patient.cryptoShreddedAt !== null) {
      throw new errors.ConflictError({
        code: "PATIENT_SHREDDED",
        message: "Patient has been crypto-shredded; PHI updates are blocked.",
        metadata: {
          patientId: input.patientId,
          cryptoShreddedAt: patient.cryptoShreddedAt.toISOString(),
        },
      });
    }

    if (patient.status === PatientStatus.MERGED) {
      throw new errors.ConflictError({
        code: "PATIENT_MERGED_AWAY",
        message: "Patient has been merged into another record. Update the survivor instead.",
        metadata: {
          patientId: input.patientId,
          ...(patient.mergedIntoPatientId !== null
            ? { mergedIntoPatientId: patient.mergedIntoPatientId }
            : {}),
        },
      });
    }

    // ---- Step 3 — Build the column write map. ----
    //
    // One closure for the encrypt + cast pattern; same AAD binding
    // shape as RegisterPatient. recordId === patientId always.
    const enc = async (column: string, plaintext: string): Promise<Prisma.InputJsonValue> =>
      (await encryptField({
        plaintext,
        binding: { tenantId, table: "patient", column, recordId: input.patientId },
      })) as unknown as Prisma.InputJsonValue;

    // `data` accumulates the SQL UPDATE payload. We use plain
    // Record<string, unknown> here because Prisma's UncheckedUpdate
    // input is a tagged union whose precise type changes column by
    // column; the surrounding `updateMany` call is the type boundary.
    const data: Record<string, unknown> = {};

    // ----- Identity (string-only patches) -----

    if (input.firstName !== undefined) {
      data.firstNameEnc = await enc("firstName", input.firstName);
      const bi = await PATIENT_BLIND_INDEX.firstName({ tenantId, value: input.firstName });
      if (bi === null) throw biRequiredNullError("firstName");
      data.firstNameBi = bi;
    }
    if (input.lastName !== undefined) {
      data.lastNameEnc = await enc("lastName", input.lastName);
      const bi = await PATIENT_BLIND_INDEX.lastName({ tenantId, value: input.lastName });
      if (bi === null) throw biRequiredNullError("lastName");
      data.lastNameBi = bi;
    }
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirthEnc = await enc("dateOfBirth", input.dateOfBirth);
      const dobBi = await PATIENT_BLIND_INDEX.dateOfBirth({
        tenantId,
        value: input.dateOfBirth,
      });
      const dobYearMonthBi = await PATIENT_BLIND_INDEX.dateOfBirthYearMonth({
        tenantId,
        value: input.dateOfBirth.slice(0, 7),
      });
      if (dobBi === null || dobYearMonthBi === null) {
        throw biRequiredNullError("dateOfBirth");
      }
      data.dobBi = dobBi;
      data.dobYearMonthBi = dobYearMonthBi;
    }

    // ----- Optional non-searchable fields -----

    if (input.middleName !== undefined) {
      data.middleNameEnc =
        input.middleName === null ? Prisma.DbNull : await enc("middleName", input.middleName);
    }
    if (input.sexAtBirth !== undefined) {
      data.sexAtBirthEnc =
        input.sexAtBirth === null ? Prisma.DbNull : await enc("sexAtBirth", input.sexAtBirth);
    }
    if (input.ssnLast4 !== undefined) {
      data.ssnLast4Enc =
        input.ssnLast4 === null ? Prisma.DbNull : await enc("ssnLast4", input.ssnLast4);
    }
    if (input.addressLine1 !== undefined) {
      data.addressLine1Enc =
        input.addressLine1 === null ? Prisma.DbNull : await enc("addressLine1", input.addressLine1);
    }
    if (input.addressLine2 !== undefined) {
      data.addressLine2Enc =
        input.addressLine2 === null ? Prisma.DbNull : await enc("addressLine2", input.addressLine2);
    }
    if (input.city !== undefined) {
      data.cityEnc = input.city === null ? Prisma.DbNull : await enc("city", input.city);
    }
    if (input.state !== undefined) {
      data.stateEnc = input.state === null ? Prisma.DbNull : await enc("state", input.state);
    }

    // ----- Optional searchable fields (Enc + Bi move together) -----

    if (input.phone !== undefined) {
      if (input.phone === null) {
        data.phoneEnc = Prisma.DbNull;
        data.phoneLast10Bi = null;
      } else {
        data.phoneEnc = await enc("phone", input.phone);
        data.phoneLast10Bi = await PATIENT_BLIND_INDEX.phoneLast10({
          tenantId,
          value: input.phone,
        });
      }
    }
    if (input.email !== undefined) {
      if (input.email === null) {
        data.emailEnc = Prisma.DbNull;
        data.emailBi = null;
      } else {
        data.emailEnc = await enc("email", input.email);
        data.emailBi = await PATIENT_BLIND_INDEX.email({ tenantId, value: input.email });
      }
    }
    if (input.postalCode !== undefined) {
      if (input.postalCode === null) {
        data.postalCodeEnc = Prisma.DbNull;
        data.postalCodeBi = null;
      } else {
        data.postalCodeEnc = await enc("postalCode", input.postalCode);
        data.postalCodeBi = await PATIENT_BLIND_INDEX.postalCode({
          tenantId,
          value: input.postalCode,
        });
      }
    }
    if (input.mrn !== undefined) {
      if (input.mrn === null) {
        data.mrnEnc = Prisma.DbNull;
        data.mrnBi = null;
      } else {
        data.mrnEnc = await enc("mrn", input.mrn);
        data.mrnBi = await PATIENT_BLIND_INDEX.mrn({ tenantId, value: input.mrn });
      }
    }

    // ---- Step 4 — Atomic CAS update. ----
    //
    // The where clause re-checks the two locked-out states. A
    // concurrent shred or merge between our read in step 2 and this
    // write returns count=0; the bus rolls back the tx.
    const result = await tx.patient.updateMany({
      where: {
        id: input.patientId,
        organizationId: tenantId,
        cryptoShreddedAt: null,
        status: { not: PatientStatus.MERGED },
      },
      data,
    });

    if (result.count === 0) {
      throw new errors.ConflictError({
        code: "PATIENT_UPDATE_RACE_LOST",
        message:
          "Patient state changed during update (concurrent crypto-shred or merge). Refetch the patient and resubmit if needed.",
        metadata: { patientId: input.patientId },
      });
    }

    // ---- Step 5 — PHI-FREE audit + outbox. ----
    //
    // Sort the change-set lists so audit consumers and downstream
    // analytics get a stable ordering regardless of how the input
    // was serialized over the wire.
    updatedFields.sort();
    clearedFields.sort();

    return {
      output: {
        patientId: input.patientId,
        updatedAt: now.toISOString(),
        updatedFields,
        clearedFields,
      },
      audit: {
        action: "patient.updated",
        resourceType: "Patient",
        resourceId: input.patientId,
        metadata: {
          clinicId: patient.clinicId,
          updatedFields,
          clearedFields,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "patient.updated.v1",
          aggregateType: "Patient",
          aggregateId: input.patientId,
          payload: {
            patientId: input.patientId,
            organizationId: tenantId,
            updatedFields,
            clearedFields,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

// Same shape as the RegisterPatient internal-error escape hatch. A
// null BI on a non-empty plaintext means the crypto layer is
// misconfigured (no per-tenant search key, broken normalizer, etc.) —
// surface loud rather than write a SQL NULL where the column is
// expected to carry a hash.
function biRequiredNullError(field: string): Error {
  return new errors.InternalError({
    code: "PATIENT_BI_REQUIRED_NULL",
    message:
      `Blind index for patient.${field} returned null on a non-empty value. ` +
      "Verify @pharmax/crypto configuration and normalizers.",
  });
}
