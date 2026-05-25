// CryptoShredPatient — render a patient's PHI permanently unreadable.
//
// The right-to-be-forgotten primitive. Once executed, the per-row
// DEKs (wrapped inside each `*Enc` envelope) are destroyed by setting
// every envelope column AND every blind-index column to NULL. The
// envelope held the only path to the plaintext; with it gone, no
// future read — no matter the credentials — can recover the original
// PHI. KMS round-trip is unnecessary: the DEK lived inside the row.
//
// Cascading guarantees this command DOES enforce:
//
//   - The patient row STAYS for FK integrity. Orders, prescriptions,
//     and order_lines keep their links; downstream readers MUST gate
//     PHI access on `cryptoShreddedAt IS NULL`.
//   - All blind-index columns (`*Bi`) are NULLed at the same time as
//     their `*Enc` partners. Otherwise the HMACs become permanent
//     pointers to plaintexts nobody can prove exist — a residual
//     identifier that violates the spirit of forget-me.
//   - `status` is flipped to `INACTIVE` so the row drops out of the
//     standard active-roster queries even before callers learn to
//     filter on `cryptoShreddedAt`.
//
// Cascading guarantees this command DOES NOT enforce (caller's job):
//
//   - Existing orders / prescriptions on the patient are NOT
//     cancelled. They still point at the patient by FK; if the
//     operator wants to halt in-flight workflow, they CancelOrder
//     each one separately. We refuse to do that implicitly because
//     "right to be forgotten" and "cancel my in-flight Rx" are
//     legally distinct requests.
//
// PHI rule:
//   - Audit metadata is PHI-FREE. We log `reason`, `commandLogId`,
//     and PRESENCE booleans (`hadMrn`, `hadPhone`, ...) describing
//     which optional fields the row used to carry. No plaintext, no
//     ciphertext.
//   - Outbox payload is PHI-FREE. Only ids + reason + timestamp.
//   - The bus's `redactFields` list is empty here — the input is
//     `{ patientId, reason }`, neither of which is PHI. We still
//     declare the field explicitly so a future input addition that
//     adds PHI lands a redact decision next to the schema change.
//
// SOC 2 framing:
//   - This is a destructive compliance action. The seeded role
//     templates grant `patients.crypto_shred` to OrgAdmin only. The
//     bus's `requirePermission` check fires before any tx work.
//   - Double-shred is REJECTED (not silently idempotent). An
//     operator calling shred twice is almost certainly a duplicate
//     request or a bug; surfacing `PATIENT_ALREADY_SHREDDED` with
//     the first-shred timestamp in metadata gives them the answer
//     they actually want.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { CRYPTO_SHRED_REASONS, planCryptoShred, type CryptoShredReason } from "@pharmax/crypto";
import { PatientStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const reasonValues = Object.values(CRYPTO_SHRED_REASONS) as ReadonlyArray<CryptoShredReason>;

const inputSchema = z
  .object({
    patientId: z.string().uuid(),
    // Closed enum from `@pharmax/crypto`. Drift is impossible because
    // `planCryptoShred` validates against the same registry inside
    // the handler — but failing at the Zod boundary gives the caller
    // a structured `COMMAND_INPUT_INVALID` with the bad value visible
    // in the error rather than a generic crypto-validation throw.
    reason: z.enum(reasonValues as [CryptoShredReason, ...CryptoShredReason[]]),
  })
  .strict();

export type CryptoShredPatientInput = z.infer<typeof inputSchema>;

export interface CryptoShredPatientOutput {
  readonly patientId: string;
  readonly cryptoShreddedAt: string; // ISO timestamp
  readonly reason: CryptoShredReason;
}

// Every PHI envelope column on the Patient row. Authoritative list;
// the schema test in `redact-patient.test.ts` pins this against the
// dmmf so a new `*Enc` column added to the schema fails the suite
// until it lands here too.
const PATIENT_ENC_COLUMNS = Object.freeze([
  "firstNameEnc",
  "lastNameEnc",
  "dateOfBirthEnc",
  "middleNameEnc",
  "sexAtBirthEnc",
  "ssnLast4Enc",
  "phoneEnc",
  "emailEnc",
  "addressLine1Enc",
  "addressLine2Enc",
  "cityEnc",
  "stateEnc",
  "postalCodeEnc",
  "mrnEnc",
] as const);

// Every blind-index column on the Patient row. Same dmmf-pin
// guarantee via `redact-patient.test.ts`.
const PATIENT_BI_COLUMNS = Object.freeze([
  "firstNameBi",
  "lastNameBi",
  "dobBi",
  "dobYearMonthBi",
  "phoneLast10Bi",
  "emailBi",
  "postalCodeBi",
  "mrnBi",
] as const);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CryptoShredPatient: Command<CryptoShredPatientInput, CryptoShredPatientOutput> = {
  name: "CryptoShredPatient",
  inputSchema,
  permission: PERMISSIONS.PATIENTS_CRYPTO_SHRED,
  // Empty — neither `patientId` nor `reason` is PHI. Declared
  // explicitly so a future input field gets a redact decision at
  // the same place as the schema change.
  redactFields: Object.freeze([] as const),

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CryptoShredPatientOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;

    // Step 1 — Read the row. We need its presence booleans for the
    // audit metadata AND its current `cryptoShreddedAt` for the
    // already-shredded guard. RLS + the tenancy extension confine
    // this read to the caller's organization; a cross-org id returns
    // null on both legs.
    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: {
        id: true,
        cryptoShreddedAt: true,
        middleNameEnc: true,
        sexAtBirthEnc: true,
        ssnLast4Enc: true,
        phoneEnc: true,
        emailEnc: true,
        addressLine1Enc: true,
        addressLine2Enc: true,
        cityEnc: true,
        stateEnc: true,
        postalCodeEnc: true,
        mrnEnc: true,
      },
    });

    if (patient === null) {
      throw new errors.NotFoundError({
        code: "PATIENT_NOT_FOUND",
        message: "Patient does not exist or is not in this organization.",
        metadata: { patientId: input.patientId },
      });
    }

    // Step 2 — Double-shred guard. The row is already crypto-shred
    // tombstoned; the operator gets the first-shred timestamp so
    // they can correlate with the original audit entry.
    if (patient.cryptoShreddedAt !== null) {
      throw new errors.ConflictError({
        code: "PATIENT_ALREADY_SHREDDED",
        message: "Patient has already been crypto-shredded.",
        metadata: {
          patientId: input.patientId,
          firstShreddedAt: patient.cryptoShreddedAt.toISOString(),
        },
      });
    }

    // Step 3 — Capture which optional fields the row USED to carry
    // for the audit log. Booleans only — we never log the ciphertext
    // itself, even though every Enc value is a JSON envelope object.
    const hadMrn = patient.mrnEnc !== null;
    const hadPhone = patient.phoneEnc !== null;
    const hadEmail = patient.emailEnc !== null;
    const hadAddress =
      patient.addressLine1Enc !== null ||
      patient.addressLine2Enc !== null ||
      patient.cityEnc !== null ||
      patient.stateEnc !== null ||
      patient.postalCodeEnc !== null;
    const hadSsnLast4 = patient.ssnLast4Enc !== null;
    const hadMiddleName = patient.middleNameEnc !== null;
    const hadSexAtBirth = patient.sexAtBirthEnc !== null;

    // Step 4 — Run the shred plan once per column. `planCryptoShred`
    // is pure (no I/O); we call it primarily so the AAD-binding
    // intent — `(tenantId, table, column, recordId)` — appears at
    // the call site, and so the reason code is validated against
    // the closed registry one more time as defense in depth.
    for (const column of PATIENT_ENC_COLUMNS) {
      planCryptoShred({
        tenantId,
        table: "patient",
        column,
        recordId: input.patientId,
        reason: input.reason,
      });
    }

    // Step 5 — Atomic CAS update. The `cryptoShreddedAt IS NULL`
    // predicate makes this safe against a concurrent shred winning
    // the race. We also flip `status` to INACTIVE so the row drops
    // out of standard active-roster queries.
    // `Prisma.DbNull` is the sentinel that writes a SQL NULL into a
    // nullable Json column. Plain TS `null` is a type error against
    // Prisma's `NullableJsonNullValueInput | InputJsonValue` union
    // because that union explicitly distinguishes SQL NULL from a
    // JSON literal `null` value — and we want SQL NULL here so the
    // envelope object is gone, not preserved as `null` payload.
    const result = await tx.patient.updateMany({
      where: {
        id: input.patientId,
        organizationId: tenantId,
        cryptoShreddedAt: null,
      },
      data: {
        firstNameEnc: Prisma.DbNull,
        lastNameEnc: Prisma.DbNull,
        dateOfBirthEnc: Prisma.DbNull,
        middleNameEnc: Prisma.DbNull,
        sexAtBirthEnc: Prisma.DbNull,
        ssnLast4Enc: Prisma.DbNull,
        phoneEnc: Prisma.DbNull,
        emailEnc: Prisma.DbNull,
        addressLine1Enc: Prisma.DbNull,
        addressLine2Enc: Prisma.DbNull,
        cityEnc: Prisma.DbNull,
        stateEnc: Prisma.DbNull,
        postalCodeEnc: Prisma.DbNull,
        mrnEnc: Prisma.DbNull,
        firstNameBi: null,
        lastNameBi: null,
        dobBi: null,
        dobYearMonthBi: null,
        phoneLast10Bi: null,
        emailBi: null,
        postalCodeBi: null,
        mrnBi: null,
        cryptoShreddedAt: now,
        status: PatientStatus.INACTIVE,
      },
    });

    if (result.count === 0) {
      // Concurrent shred won the CAS. The bus rolls back the tx;
      // command_log records the FAILED attempt. No partial state.
      throw new errors.ConflictError({
        code: "PATIENT_SHRED_RACE_LOST",
        message: "Patient was shredded by a concurrent operation. Retry not required.",
        metadata: { patientId: input.patientId },
      });
    }

    // Step 6 — PHI-FREE audit + outbox drafts. The audit metadata
    // is the forensic record an operator will use to answer "what
    // did we destroy?" without disclosing what was destroyed.
    return {
      output: {
        patientId: input.patientId,
        cryptoShreddedAt: now.toISOString(),
        reason: input.reason,
      },
      audit: {
        action: "patient.crypto_shredded",
        resourceType: "Patient",
        resourceId: input.patientId,
        metadata: {
          reason: input.reason,
          hadMrn,
          hadSsnLast4,
          hadPhone,
          hadEmail,
          hadAddress,
          hadMiddleName,
          hadSexAtBirth,
          commandLogId,
          // List of NULLed columns is structural data (not PHI)
          // and helps SOC 2 reviewers confirm the operation's
          // intended scope without reading any value.
          shreddedEncColumns: [...PATIENT_ENC_COLUMNS],
          shreddedBiColumns: [...PATIENT_BI_COLUMNS],
        },
      },
      outboxEvents: [
        {
          eventType: "patient.crypto_shredded.v1",
          aggregateType: "Patient",
          aggregateId: input.patientId,
          payload: {
            patientId: input.patientId,
            organizationId: tenantId,
            reason: input.reason,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
