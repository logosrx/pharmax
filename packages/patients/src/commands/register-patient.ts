// RegisterPatient — the first PHI-bearing command.
//
// This is the reference for every future write that touches the
// `patient`, `prescription`, or `order_line` tables. Read carefully:
//
//   - Every PHI field is encrypted via `@pharmax/crypto::encryptField`
//     with AAD bound to `(tenantId, table="patient", column, recordId)`.
//     The recordId IS the patient id, so a ciphertext stolen from one
//     row cannot be moved into another row and decrypted — the AAD
//     check fails first.
//
//   - Every searchable PHI field is paired with an HMAC blind index
//     (`@pharmax/crypto::blindIndex`) using the per-tenant per-purpose
//     search key. Purposes come from the typed registry in
//     `@pharmax/database/phi` so a typo cannot silently land an
//     orphan BI that doesn't match any indexed column.
//
//   - The patient id is generated client-side (UUID v4) BEFORE
//     encryption so the AAD binding can include `recordId`. The id
//     is then written into `patient.id` alongside the ciphertexts;
//     a tx rollback rolls back BOTH (no orphan KMS calls — the KEK
//     is per-tenant and the DEK is wrapped, so nothing leaks).
//
//   - The clinic existence check uses the tenancy-extended Prisma
//     client so cross-tenant clinic ids return null (RLS does the
//     same belt-and-suspenders at the DB layer).
//
// PHI rule:
//   - `audit.metadata` is PHI-FREE. We log only:
//     `clinicId`, `hasMrn`, `hasPhone`, `hasEmail`, `hasAddress`,
//     `hasSsnLast4`, `commandLogId`. Booleans, not values — even
//     "presence of email" is borderline metadata but it's the
//     minimum the admin UI needs to render an intake-status badge.
//   - `outboxEvents[].payload` is PHI-FREE. Only ids and timestamps.
//   - The bus's `redactFields` list scrubs every PHI key from
//     `command_log.requestPayload` before persistence. We declare
//     the full list explicitly; the bus's ALWAYS_REDACT set covers
//     `dateOfBirth`, `ssn`, `mrn` already, but explicit > implicit.

import { randomUUID } from "node:crypto";

import { errors } from "@pharmax/platform-core";
import type { Command, HandlerResult } from "@pharmax/command-bus";
import { encryptField } from "@pharmax/crypto";
import { PatientStatus, Prisma } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { PATIENT_BLIND_INDEX } from "../blind-indexes.js";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------
//
// Flat — every PHI field at the top level so the bus's per-field
// redactor can scrub them without nested-path support.

const sexAtBirthEnum = z.enum(["MALE", "FEMALE", "INTERSEX", "UNKNOWN", "OTHER"]);

// Validate `YYYY-MM-DD` AND that the resulting date is real (e.g.
// rejects "2026-02-30"). We don't accept a `Date` object here because
// the bus serializes inputs into `command_log.requestPayload` as JSON
// — strings are stable round-trip; Date is not.
const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    // Round-trip check rejects normalization (e.g. "2026-02-30" → Mar 2).
    return d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

const inputSchema = z
  .object({
    clinicId: z.string().uuid(),

    // Required PHI.
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    dateOfBirth: dateOfBirthSchema,

    // Optional PHI.
    middleName: z.string().min(1).max(100).optional(),
    sexAtBirth: sexAtBirthEnum.optional(),
    ssnLast4: z
      .string()
      .regex(/^\d{4}$/, "must be exactly 4 digits")
      .optional(),
    phone: z.string().min(7).max(40).optional(),
    email: z.email().max(320).optional(),
    addressLine1: z.string().min(1).max(200).optional(),
    addressLine2: z.string().min(1).max(200).optional(),
    city: z.string().min(1).max(100).optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "expected 2-letter state code")
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}(-\d{4})?$/, "expected ZIP or ZIP+4")
      .optional(),
    mrn: z.string().min(1).max(64).optional(),
  })
  .strict();

export type RegisterPatientInput = z.infer<typeof inputSchema>;

export interface RegisterPatientOutput {
  readonly patientId: string;
}

// Every top-level PHI key on the input. The bus redacts these from
// `command_log.requestPayload`. `dateOfBirth`, `ssn`-prefixed, and
// `mrn` are also in the bus's ALWAYS_REDACT set as defense in depth.
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

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const RegisterPatient: Command<RegisterPatientInput, RegisterPatientOutput> = {
  name: "RegisterPatient",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_CREATE,
  redactFields: PHI_REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RegisterPatientOutput>> {
    const now = clock.now();

    // Step 1 — Validate the clinic exists in this tenant. The
    // tenancy Prisma extension auto-filters by organizationId and
    // RLS enforces the same at the DB layer; a cross-tenant clinic
    // id returns null on both legs.
    const clinic = await tx.clinic.findUnique({ where: { id: input.clinicId } });
    if (clinic === null) {
      throw new errors.ValidationError({
        code: "PATIENT_CLINIC_NOT_FOUND",
        message: "Clinic does not exist or is not in this organization.",
        issues: [{ path: ["clinicId"], message: "unknown clinic" }],
        metadata: { clinicId: input.clinicId },
      });
    }

    // Step 2 — Pre-issue the patient id so AAD bindings can include
    // recordId BEFORE the row exists.
    const patientId = randomUUID();
    const tenantId = ctx.organizationId;

    // Step 3 — Encrypt every PHI field that was provided. We use a
    // local helper so the "encrypt + persist as Json" pattern stays
    // a one-liner per column.
    const enc = async (column: string, plaintext: string) =>
      (await encryptField({
        plaintext,
        binding: { tenantId, table: "patient", column, recordId: patientId },
      })) as unknown as Prisma.InputJsonValue;

    // Step 4 — Compute blind indexes via the `PATIENT_BLIND_INDEX`
    // helper. The helper owns:
    //   - the (table, column) binding lookup against the typed
    //     registry in `@pharmax/database/phi` (no magic strings),
    //   - the per-purpose normalizer (text, phone, identity for
    //     pre-normalized DOB),
    //   - returning `null` when a value normalizes to empty, so
    //     callers don't store empty-hash BIs that would match every
    //     NULL row.
    // Search (`searchPatients`) uses the SAME helper for its query
    // side, so identical plaintexts MUST produce identical BIs.

    const dobYearMonth = input.dateOfBirth.slice(0, 7); // YYYY-MM

    const [firstNameEnc, lastNameEnc, dateOfBirthEnc] = await Promise.all([
      enc("firstName", input.firstName),
      enc("lastName", input.lastName),
      enc("dateOfBirth", input.dateOfBirth),
    ]);

    const [firstNameBi, lastNameBi, dobBi, dobYearMonthBi] = await Promise.all([
      PATIENT_BLIND_INDEX.firstName({ tenantId, value: input.firstName }),
      PATIENT_BLIND_INDEX.lastName({ tenantId, value: input.lastName }),
      PATIENT_BLIND_INDEX.dateOfBirth({ tenantId, value: input.dateOfBirth }),
      PATIENT_BLIND_INDEX.dateOfBirthYearMonth({ tenantId, value: dobYearMonth }),
    ]);

    // The required BIs MUST resolve to a non-null hash. They came
    // from non-empty inputs (Zod min(1)), so a null here would be
    // a crypto-layer bug — fail loud rather than insert a NULL into
    // a NOT NULL column.
    if (firstNameBi === null || lastNameBi === null || dobBi === null || dobYearMonthBi === null) {
      throw new errors.InternalError({
        code: "PATIENT_BI_REQUIRED_NULL",
        message:
          "Blind index for a required patient identity field returned null. " +
          "Verify @pharmax/crypto configuration and normalizers.",
      });
    }

    // Optional fields — encrypted + (where searchable) indexed.
    const middleNameEnc =
      input.middleName === undefined ? null : await enc("middleName", input.middleName);
    const sexAtBirthEnc =
      input.sexAtBirth === undefined ? null : await enc("sexAtBirth", input.sexAtBirth);
    const ssnLast4Enc = input.ssnLast4 === undefined ? null : await enc("ssnLast4", input.ssnLast4);

    const phoneEnc = input.phone === undefined ? null : await enc("phone", input.phone);
    const phoneLast10Bi =
      input.phone === undefined
        ? null
        : await PATIENT_BLIND_INDEX.phoneLast10({ tenantId, value: input.phone });

    const emailEnc = input.email === undefined ? null : await enc("email", input.email);
    const emailBi =
      input.email === undefined
        ? null
        : await PATIENT_BLIND_INDEX.email({ tenantId, value: input.email });

    const addressLine1Enc =
      input.addressLine1 === undefined ? null : await enc("addressLine1", input.addressLine1);
    const addressLine2Enc =
      input.addressLine2 === undefined ? null : await enc("addressLine2", input.addressLine2);
    const cityEnc = input.city === undefined ? null : await enc("city", input.city);
    const stateEnc = input.state === undefined ? null : await enc("state", input.state);
    const postalCodeEnc =
      input.postalCode === undefined ? null : await enc("postalCode", input.postalCode);
    const postalCodeBi =
      input.postalCode === undefined
        ? null
        : await PATIENT_BLIND_INDEX.postalCode({ tenantId, value: input.postalCode });

    const mrnEnc = input.mrn === undefined ? null : await enc("mrn", input.mrn);
    const mrnBi =
      input.mrn === undefined
        ? null
        : await PATIENT_BLIND_INDEX.mrn({ tenantId, value: input.mrn });

    // Step 5 — Insert. organizationId is auto-injected by the
    // tenancy extension, but we set it explicitly so the row data
    // is self-documenting at the call site (and so test fakes that
    // don't run the extension still receive the correct value).
    try {
      await tx.patient.create({
        data: {
          id: patientId,
          organizationId: tenantId,
          clinicId: input.clinicId,
          firstNameEnc,
          lastNameEnc,
          dateOfBirthEnc,
          ...(middleNameEnc === null ? {} : { middleNameEnc }),
          ...(sexAtBirthEnc === null ? {} : { sexAtBirthEnc }),
          ...(ssnLast4Enc === null ? {} : { ssnLast4Enc }),
          ...(phoneEnc === null ? {} : { phoneEnc }),
          ...(emailEnc === null ? {} : { emailEnc }),
          ...(addressLine1Enc === null ? {} : { addressLine1Enc }),
          ...(addressLine2Enc === null ? {} : { addressLine2Enc }),
          ...(cityEnc === null ? {} : { cityEnc }),
          ...(stateEnc === null ? {} : { stateEnc }),
          ...(postalCodeEnc === null ? {} : { postalCodeEnc }),
          ...(mrnEnc === null ? {} : { mrnEnc }),
          lastNameBi,
          firstNameBi,
          dobBi,
          dobYearMonthBi,
          ...(phoneLast10Bi === null ? {} : { phoneLast10Bi }),
          ...(emailBi === null ? {} : { emailBi }),
          ...(postalCodeBi === null ? {} : { postalCodeBi }),
          ...(mrnBi === null ? {} : { mrnBi }),
          status: PatientStatus.ACTIVE,
        },
      });
    } catch (err) {
      // No `@@unique` constraints currently fire on patient insert —
      // we don't enforce dedupe at the DB layer because intent-aware
      // dedupe (same Bi triplet → propose merge to operator) is the
      // future product surface. We still translate the most likely
      // Prisma errors to typed throws for the bus's error mapping.
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2003") {
          // FK violation on clinicId — should be unreachable because
          // we checked above, but a clinic deletion between the
          // check and the insert would land here.
          throw new errors.ConflictError({
            code: "PATIENT_CLINIC_RACE",
            message: "Clinic was modified concurrently. Retry the registration.",
            metadata: { clinicId: input.clinicId },
          });
        }
      }
      throw err;
    }

    // Step 6 — Build the PHI-FREE audit + outbox drafts. Presence
    // booleans only — never plaintext PHI in audit metadata.
    const hasAddress =
      input.addressLine1 !== undefined ||
      input.addressLine2 !== undefined ||
      input.city !== undefined ||
      input.state !== undefined ||
      input.postalCode !== undefined;

    return {
      output: { patientId },
      audit: {
        action: "patient.registered",
        resourceType: "Patient",
        resourceId: patientId,
        metadata: {
          clinicId: input.clinicId,
          hasMrn: input.mrn !== undefined,
          hasSsnLast4: input.ssnLast4 !== undefined,
          hasPhone: input.phone !== undefined,
          hasEmail: input.email !== undefined,
          hasAddress,
          hasMiddleName: input.middleName !== undefined,
          hasSexAtBirth: input.sexAtBirth !== undefined,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "patient.registered.v1",
          aggregateType: "Patient",
          aggregateId: patientId,
          payload: {
            patientId,
            organizationId: tenantId,
            clinicId: input.clinicId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
