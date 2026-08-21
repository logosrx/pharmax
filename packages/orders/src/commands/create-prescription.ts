// CreatePrescription — transcription. The only supported way to put a
// prescription into Pharmax.
//
// Before this command existed, the sole code path that wrote a
// `prescription` row was `scripts/seed-demo-orders.ts`. Everything
// downstream — CreateOrder, AddPrescription, PV1, fill, final
// verification — assumed a prescription already existed and was
// correct. This command is where that assumption is earned.
//
// It is NOT built with `defineCommand`. That factory codifies the
// order-aggregate contract: lock an order row, resolve the workflow
// policy, run the separation-of-duties check, CAS the order version.
// A prescription is not an order and has none of those. The plain
// `Command` shape is the established alternative for aggregate-less
// writes — `RegisterPatient` is the precedent this file follows, down
// to the encryption and audit conventions.
//
// Four safety properties this command is responsible for:
//
//   1. **The DEA schedule is not operator input when the catalog
//      knows better.** A technician who marks oxycodone
//      NON_CONTROLLED disables every controlled-substance gate for
//      the life of that prescription. So the schedule is read from
//      `product` by NDC, and a caller-supplied value that disagrees
//      is a hard error rather than a silent overwrite. When the NDC
//      is not in the catalog the caller MUST state the schedule
//      explicitly — defaulting an unknown drug to NON_CONTROLLED is
//      precisely the hole this closes.
//
//   2. **Refills are validated at issuance, not at dispense.** An
//      over-authorized prescription is defective when written
//      (21 CFR 1306.12(a) for CII, 1306.22(a) for CIII/CIV), and
//      catching it here means the pharmacist never sees a script
//      that promises the patient refills they cannot lawfully get.
//
//   3. **The prescriber must hold a DEA registration for a
//      controlled substance.** Checked against `provider.deaNumber`.
//
//   4. **The Rx number comes from the allocator, never the
//      operator.** See `../rx-number.ts`.
//
// PHI rules, identical in spirit to `RegisterPatient`:
//   - `sig`, the two notes, and the indication are the clinical free
//     text. They are encrypted with AAD bound to `(tenantId,
//     "prescription", column, prescriptionId)` and redacted from
//     `command_log.requestPayload`.
//   - `audit.metadata` and the outbox payload carry ids, the NDC and
//     the schedule — never the directions for use. The NDC is
//     deliberately included: 21 CFR 1304 recordkeeping is the reason
//     the audit row exists, and the row's `resourceId` already
//     resolves to the patient, so naming the drug adds no disclosure
//     that the row did not already imply.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import {
  DEA_AUTHORITY_EXPIRED,
  DEA_AUTHORITY_NO_REGISTRATION,
  DEA_AUTHORITY_NOT_ACTIVE,
  DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED,
  evaluatePrescriberDeaAuthority,
  federalRefillCap,
  hasSixMonthRefillHorizon,
  isControlled,
  startOfUtcDay,
  validateControlledPrescriptionAuthorization,
  addUtcCalendarMonths,
  type DeaAuthorityRefusalCode,
} from "@pharmax/controlled-substances";
import { encryptField } from "@pharmax/crypto";
import {
  ControlledSubstanceSchedule,
  DoseUnit,
  PatientStatus,
  Prisma,
  PrescriptionStatus,
  ProviderStatus,
  SigStructureKind,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { normalizeNdc } from "@pharmax/drug-identity";
import { z } from "zod";

import { PRESCRIPTION_BLIND_INDEX } from "../blind-indexes.js";
import { allocateRxNumber } from "../rx-number.js";

// ---------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------

export const RX_CLINIC_NOT_FOUND = "RX_CLINIC_NOT_FOUND";
export const RX_PATIENT_NOT_FOUND = "RX_PATIENT_NOT_FOUND";
export const RX_PATIENT_CLINIC_MISMATCH = "RX_PATIENT_CLINIC_MISMATCH";
export const RX_PATIENT_NOT_ACTIVE = "RX_PATIENT_NOT_ACTIVE";
export const RX_PROVIDER_NOT_FOUND = "RX_PROVIDER_NOT_FOUND";
export const RX_PROVIDER_INACTIVE = "RX_PROVIDER_INACTIVE";
export const RX_PROVIDER_DEA_REQUIRED = "RX_PROVIDER_DEA_REQUIRED";
export const RX_NDC_INVALID = "RX_NDC_INVALID";
export const RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC = "RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC";
export const RX_SCHEDULE_CATALOG_MISMATCH = "RX_SCHEDULE_CATALOG_MISMATCH";
export const RX_CONTROLLED_AUTHORIZATION_INVALID = "RX_CONTROLLED_AUTHORIZATION_INVALID";
export const RX_DATE_WRITTEN_IN_FUTURE = "RX_DATE_WRITTEN_IN_FUTURE";
export const RX_EXPIRES_NOT_AFTER_WRITTEN = "RX_EXPIRES_NOT_AFTER_WRITTEN";
export const RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON = "RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON";
export const RX_EARLIEST_FILL_BEFORE_WRITTEN = "RX_EARLIEST_FILL_BEFORE_WRITTEN";
export const RX_STRUCTURED_SIG_SHAPE_INVALID = "RX_STRUCTURED_SIG_SHAPE_INVALID";
export const RX_STRUCTURED_SIG_DAYS_SUPPLY_INCONSISTENT =
  "RX_STRUCTURED_SIG_DAYS_SUPPLY_INCONSISTENT";
export const RX_BI_REQUIRED_NULL = "RX_BI_REQUIRED_NULL";
export const RX_NUMBER_COLLISION = "RX_NUMBER_COLLISION";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

/**
 * Calendar-date string. Stored into a `@db.Date` column, so the value
 * is a date, not an instant — accepting a `Date` here would put a
 * timezone between what the prescriber wrote and what we record, and
 * would not round-trip through `command_log.requestPayload` as JSON.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    // Round-trip rejects normalization (e.g. "2026-02-30" → Mar 2).
    return d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

/**
 * Dispensed quantity, as a decimal string. A string rather than a
 * number because the column is `DECIMAL(18,4)` and IEEE-754 cannot
 * represent every four-decimal value exactly; "0.1" must survive the
 * trip through JSON and Prisma unchanged.
 */
const decimalQuantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "expected a decimal with up to 4 fractional digits")
  .refine((s) => Number(s) > 0, "must be greater than zero");

const scheduleEnum = z.enum(ControlledSubstanceSchedule);

/**
 * Dose per administration, as a decimal string for the same
 * IEEE-754-survival reason as `decimalQuantity`; the column is
 * `DECIMAL(12,4)`, hence the tighter integer-digit bound.
 */
const decimalDoseAmount = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,4})?$/, "expected a decimal with up to 4 fractional digits")
  .refine((s) => Number(s) > 0, "must be greater than zero");

/**
 * Administrations per day. Decimal, not integer: every-other-day is
 * 0.5 and weekly is 0.1429. Bounded above at hourly dosing — a
 * frequency beyond 24/day is a transcription error, not a regimen.
 */
const decimalDosesPerDay = z
  .string()
  .regex(/^\d{1,2}(\.\d{1,4})?$/, "expected a decimal with up to 4 fractional digits")
  .refine((s) => Number(s) > 0, "must be greater than zero")
  .refine((s) => Number(s) <= 24, "more than 24 doses per day is not a schedule");

const sigStructureKindEnum = z.enum(SigStructureKind);
const doseUnitEnum = z.enum(DoseUnit);

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    patientId: z.uuid(),
    providerId: z.uuid(),

    // Drug identity. `drugNdc` is normalized to 11 digits with the
    // same function the barcode scanner uses at fill time, so the
    // transcribed NDC and the scanned NDC are comparable strings.
    drugNdc: z.string().min(1).max(32),
    drugName: z.string().min(1).max(200),
    drugStrength: z.string().min(1).max(100).optional(),
    drugForm: z.string().min(1).max(100).optional(),

    // Omit to take the schedule from the product catalog. Supply it
    // only when the NDC is not catalogued, or to assert agreement
    // with the catalog (a disagreement is rejected).
    controlledSubstanceSchedule: scheduleEnum.optional(),

    quantityAuthorized: decimalQuantity,
    daysSupply: z.int().positive().max(365),
    refillsAuthorized: z.int().nonnegative().max(99),

    originalDateWritten: calendarDate,
    // Omit to derive: six months for a controlled substance, one year
    // otherwise. See `deriveExpiry`.
    expiresAt: calendarDate.optional(),
    earliestFillDate: calendarDate.optional(),

    // "Dispense as written" code (NCPDP DAW 0–9).
    daw: z.int().min(0).max(9).default(0),

    // Clinical free text — PHI.
    sig: z.string().min(1).max(2000),

    // Structured sig — the machine-comparable summary of `sig`,
    // captured so the PV1 dose-range screen has an amount, a unit and
    // a frequency to compare. ALL OPTIONAL: the free-text sig remains
    // the authoritative label instruction, and a transcription
    // without these is legal (its dose axis reports an informational
    // gap instead of screening). What each value means per kind is
    // documented on `SigStructureKind` in `schema.prisma`; the shape
    // rules are enforced in the handler
    // (`validateStructuredSigShape`) with a named error code, and by
    // the `prescription_structured_sig_shape` CHECK constraint.
    // Coded values, not PHI narrative — same treatment as `drugNdc`.
    sigStructureKind: sigStructureKindEnum.optional(),
    doseAmount: decimalDoseAmount.optional(),
    doseUnit: doseUnitEnum.optional(),
    dosesPerDay: decimalDosesPerDay.optional(),

    noteToPharmacist: z.string().min(1).max(2000).optional(),
    noteToPatient: z.string().min(1).max(2000).optional(),
    indication: z.string().min(1).max(500).optional(),
  })
  .strict();

export type CreatePrescriptionInput = z.infer<typeof inputSchema>;

export interface CreatePrescriptionOutput {
  readonly prescriptionId: string;
  readonly rxNumber: string;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule;
  readonly expiresAt: string;
}

/**
 * Clinical free-text fields scrubbed from `command_log.requestPayload`.
 *
 * The drug identity is deliberately NOT redacted. The command log is
 * the reconstruction record for a transcription; a log that cannot
 * answer "what drug was typed" cannot serve the purpose it exists for,
 * and the row is tenant-scoped, RLS-protected and immutable.
 */
const PHI_REDACT_FIELDS = Object.freeze([
  "sig",
  "noteToPharmacist",
  "noteToPatient",
  "indication",
] as const);

const DEFAULT_CONTROLLED_VALIDITY_MONTHS = 6;
const DEFAULT_NON_CONTROLLED_VALIDITY_MONTHS = 12;

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const CreatePrescription: Command<CreatePrescriptionInput, CreatePrescriptionOutput> = {
  name: "CreatePrescription",
  inputSchema,
  permission: PERMISSIONS.PRESCRIPTIONS_CREATE,
  redactFields: PHI_REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<CreatePrescriptionOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;

    // ---- Step 1: NDC normalization ---------------------------------
    // Do this first: the catalog lookup, the scanner comparison at
    // fill time, and the stored column must all agree on one form.
    const drugNdc = normalizeNdc(input.drugNdc);
    if (drugNdc === null) {
      throw new errors.ValidationError({
        code: RX_NDC_INVALID,
        message: "Drug NDC is not a valid 10- or 11-digit National Drug Code.",
        issues: [{ path: ["drugNdc"], message: "not a valid NDC" }],
      });
    }

    // ---- Step 2: tenancy-scoped existence checks -------------------
    // The tenancy extension filters each of these by organizationId
    // and RLS enforces the same at the database; a cross-tenant id
    // returns null on both legs.
    const clinic = await tx.clinic.findUnique({
      where: { id: input.clinicId },
      select: { id: true },
    });
    if (clinic === null) {
      throw new errors.ValidationError({
        code: RX_CLINIC_NOT_FOUND,
        message: "Clinic does not exist or is not in this organization.",
        issues: [{ path: ["clinicId"], message: "unknown clinic" }],
        metadata: { clinicId: input.clinicId },
      });
    }

    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: { id: true, clinicId: true, status: true },
    });
    if (patient === null) {
      throw new errors.ValidationError({
        code: RX_PATIENT_NOT_FOUND,
        message: "Patient does not exist or is not in this organization.",
        issues: [{ path: ["patientId"], message: "unknown patient" }],
      });
    }
    if (patient.clinicId !== input.clinicId) {
      // Mirrors CreateOrder's ORDER_PATIENT_CLINIC_MISMATCH: a
      // prescription filed under the wrong clinic would be invisible
      // to the clinic that owns the patient and visible to one that
      // should not see them at all.
      throw new errors.ValidationError({
        code: RX_PATIENT_CLINIC_MISMATCH,
        message: "Patient does not belong to the specified clinic.",
        issues: [{ path: ["patientId"], message: "patient belongs to a different clinic" }],
        metadata: { clinicId: input.clinicId },
      });
    }
    if (patient.status !== PatientStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: RX_PATIENT_NOT_ACTIVE,
        message: `Patient is ${patient.status.toLowerCase()} and cannot receive a new prescription.`,
        metadata: { patientStatus: patient.status },
      });
    }

    const provider = await tx.provider.findUnique({
      where: { id: input.providerId },
      select: {
        id: true,
        status: true,
        // Every registration, not only the live ones. The refusal
        // reason depends on WHY none of them authorize — lapsed,
        // revoked, or simply not covering this schedule — and filtering
        // in the query would collapse all three into "none found".
        deaRegistrations: {
          select: {
            deaNumber: true,
            status: true,
            expiresAt: true,
            authorizedSchedules: true,
          },
        },
      },
    });
    if (provider === null) {
      throw new errors.ValidationError({
        code: RX_PROVIDER_NOT_FOUND,
        message: "Prescriber does not exist or is not in this organization.",
        issues: [{ path: ["providerId"], message: "unknown provider" }],
      });
    }
    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: RX_PROVIDER_INACTIVE,
        message: "Prescriber is inactive and cannot write new prescriptions.",
        metadata: { providerId: input.providerId, providerStatus: provider.status },
      });
    }

    // ---- Step 3: resolve the schedule from the catalog -------------
    const product = await tx.product.findUnique({
      where: { organizationId_ndc: { organizationId: tenantId, ndc: drugNdc } },
      select: { controlledSubstanceSchedule: true },
    });

    const schedule = resolveSchedule({
      catalogSchedule: product?.controlledSubstanceSchedule ?? null,
      declared: input.controlledSubstanceSchedule ?? null,
      drugNdc,
    });

    // ---- Step 4: DEA authorization limits --------------------------
    //
    // This used to be a presence check on a nullable column, which
    // could only say "no DEA on file". A registration can also have
    // lapsed, been revoked, or simply not cover this schedule, and the
    // operator's next action differs for each — so the verdict carries
    // a specific code and the message names the thing to go fix.
    const deaAuthority = evaluatePrescriberDeaAuthority({
      schedule,
      registrations: provider.deaRegistrations,
      asOf: now,
    });
    if (!deaAuthority.ok) {
      throw new errors.ValidationError({
        code: RX_PROVIDER_DEA_REQUIRED,
        message: deaRefusalMessage(deaAuthority.code, schedule),
        issues: [{ path: ["providerId"], message: "prescriber DEA authority insufficient" }],
        // The DEA number itself never appears here — a refusal is not a
        // reason to put a prescribing credential into an error payload.
        metadata: {
          providerId: input.providerId,
          schedule,
          reason: deaAuthority.code,
          registrationCount: deaAuthority.registrationCount,
        },
      });
    }

    const authorization = validateControlledPrescriptionAuthorization({
      schedule,
      refillsAuthorized: input.refillsAuthorized,
    });
    if (!authorization.ok) {
      const [first] = authorization.violations;
      throw new errors.ValidationError({
        code: RX_CONTROLLED_AUTHORIZATION_INVALID,
        message:
          first?.reason ?? "Prescription authorizes refills that federal law does not allow.",
        issues: [{ path: ["refillsAuthorized"], message: first?.reason ?? "not permitted" }],
        metadata: {
          schedule,
          federalRefillCap: federalRefillCap(schedule),
          violations: authorization.violations.map((v) => ({
            code: v.code,
            citation: v.citation,
          })),
        },
      });
    }

    // ---- Step 5: dates ---------------------------------------------
    const writtenDate = toUtcDate(input.originalDateWritten);
    const today = startOfUtcDay(now);
    if (writtenDate.getTime() > today.getTime()) {
      // A future date-written is either a typo or an attempt to
      // extend the fillable window. Neither should reach a
      // pharmacist.
      throw new errors.ValidationError({
        code: RX_DATE_WRITTEN_IN_FUTURE,
        message: "Date written cannot be in the future.",
        issues: [{ path: ["originalDateWritten"], message: "future date" }],
      });
    }

    const expiresAt =
      input.expiresAt === undefined
        ? deriveExpiry(writtenDate, schedule)
        : toUtcDate(input.expiresAt);

    if (expiresAt.getTime() <= writtenDate.getTime()) {
      throw new errors.ValidationError({
        code: RX_EXPIRES_NOT_AFTER_WRITTEN,
        message: "Expiry must be after the date written.",
        issues: [{ path: ["expiresAt"], message: "not after date written" }],
      });
    }

    // 21 CFR 1306.22(a): a Schedule III or IV prescription may not be
    // filled or refilled more than six months after issue. Clamping
    // the stored expiry to that horizon keeps the lifecycle from ever
    // presenting the prescription as fillable past it.
    if (hasSixMonthRefillHorizon(schedule)) {
      const horizon = addUtcCalendarMonths(writtenDate, DEFAULT_CONTROLLED_VALIDITY_MONTHS);
      if (expiresAt.getTime() > horizon.getTime()) {
        throw new errors.ValidationError({
          code: RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON,
          message: `A ${schedule} prescription is not fillable more than six months after it was written.`,
          issues: [{ path: ["expiresAt"], message: "beyond the six-month federal horizon" }],
          metadata: { schedule, citation: "21 CFR 1306.22(a)" },
        });
      }
    }

    const earliestFillDate =
      input.earliestFillDate === undefined ? null : toUtcDate(input.earliestFillDate);
    if (earliestFillDate !== null && earliestFillDate.getTime() < writtenDate.getTime()) {
      throw new errors.ValidationError({
        code: RX_EARLIEST_FILL_BEFORE_WRITTEN,
        message: "A do-not-fill-before date cannot precede the date written.",
        issues: [{ path: ["earliestFillDate"], message: "before date written" }],
      });
    }

    // ---- Step 5b: structured sig ------------------------------------
    // Shape first (which fields a kind requires), then the
    // days-supply cross-check — a transcription-time arithmetic check
    // that is cheapest to fix while the operator is holding the
    // script. Both are named errors rather than schema refinements so
    // the console can tell the operator which field to fix and why.
    validateStructuredSigShape(input);
    validateDaysSupplyConsistency(input);

    // ---- Step 6: id, Rx number, encryption -------------------------
    // The id is minted before encryption so the AAD binding can name
    // the row it belongs to: a ciphertext lifted out of this row and
    // pasted into another fails its AAD check rather than decrypting.
    const prescriptionId = randomUUID();

    // Allocation is deliberately AFTER every validation above. It
    // takes a row lock held until this transaction commits, so doing
    // it earlier would hold the clinic's counter across the catalog
    // and provider reads and serialize transcriptions that were about
    // to fail anyway.
    const rxNumber = await allocateRxNumber({ tx, organizationId: tenantId, clinicId: clinic.id });

    const enc = async (column: string, plaintext: string) =>
      (await encryptField({
        plaintext,
        binding: { tenantId, table: "prescription", column, recordId: prescriptionId },
      })) as unknown as Prisma.InputJsonValue;

    const sigEnc = await enc("sig", input.sig);
    const noteToPharmacistEnc =
      input.noteToPharmacist === undefined
        ? null
        : await enc("noteToPharmacist", input.noteToPharmacist);
    const noteToPatientEnc =
      input.noteToPatient === undefined ? null : await enc("noteToPatient", input.noteToPatient);
    const indicationEnc =
      input.indication === undefined ? null : await enc("indication", input.indication);

    const rxNumberBi = await PRESCRIPTION_BLIND_INDEX.rxNumber({ tenantId, value: rxNumber });
    if (rxNumberBi === null) {
      // The allocator never returns an empty string, so a null here
      // is a crypto-configuration fault, not bad input. Fail loudly
      // rather than write a NULL into a NOT NULL column.
      throw new errors.InternalError({
        code: RX_BI_REQUIRED_NULL,
        message:
          "Blind index for the Rx number returned null. Verify @pharmax/crypto configuration.",
      });
    }

    // ---- Step 7: persist -------------------------------------------
    try {
      await tx.prescription.create({
        data: {
          id: prescriptionId,
          organizationId: tenantId,
          clinicId: input.clinicId,
          patientId: input.patientId,
          providerId: input.providerId,
          rxNumber,
          rxNumberBi,
          drugNdc,
          drugName: input.drugName,
          ...(input.drugStrength === undefined ? {} : { drugStrength: input.drugStrength }),
          ...(input.drugForm === undefined ? {} : { drugForm: input.drugForm }),
          quantityAuthorized: new Prisma.Decimal(input.quantityAuthorized),
          daysSupply: input.daysSupply,
          refillsAuthorized: input.refillsAuthorized,
          refillsRemaining: input.refillsAuthorized,
          originalDateWritten: writtenDate,
          expiresAt,
          daw: input.daw,
          controlledSubstanceSchedule: schedule,
          ...(earliestFillDate === null ? {} : { earliestFillDate }),
          ...(input.sigStructureKind === undefined
            ? {}
            : { sigStructureKind: input.sigStructureKind }),
          ...(input.doseAmount === undefined
            ? {}
            : { doseAmount: new Prisma.Decimal(input.doseAmount) }),
          ...(input.doseUnit === undefined ? {} : { doseUnit: input.doseUnit }),
          ...(input.dosesPerDay === undefined
            ? {}
            : { dosesPerDay: new Prisma.Decimal(input.dosesPerDay) }),
          sigEnc,
          ...(noteToPharmacistEnc === null ? {} : { noteToPharmacistEnc }),
          ...(noteToPatientEnc === null ? {} : { noteToPatientEnc }),
          ...(indicationEnc === null ? {} : { indicationEnc }),
          status: PrescriptionStatus.ACTIVE,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // `prescription(organizationId, clinicId, rxNumber)`. The
        // allocator should make this unreachable; reaching it means
        // the counter drifted behind the series (a restore from an
        // older snapshot is the realistic way). Surfacing a conflict
        // lets the caller retry into a fresh number instead of
        // silently overwriting a real prescription.
        throw new errors.ConflictError({
          code: RX_NUMBER_COLLISION,
          cause: err,
          message: "The allocated prescription number is already in use. Retry the transcription.",
          metadata: { clinicId: input.clinicId, rxNumber },
        });
      }
      throw err;
    }

    // ---- Step 8: audit + outbox ------------------------------------
    return {
      output: {
        prescriptionId,
        rxNumber,
        controlledSubstanceSchedule: schedule,
        expiresAt: toDateString(expiresAt),
      },
      audit: {
        action: "prescription.created",
        resourceType: "Prescription",
        resourceId: prescriptionId,
        metadata: {
          clinicId: input.clinicId,
          patientId: input.patientId,
          providerId: input.providerId,
          rxNumber,
          drugNdc,
          controlledSubstanceSchedule: schedule,
          scheduleSource: product === null ? "declared" : "catalog",
          refillsAuthorized: input.refillsAuthorized,
          daysSupply: input.daysSupply,
          originalDateWritten: input.originalDateWritten,
          expiresAt: toDateString(expiresAt),
          hasNoteToPharmacist: input.noteToPharmacist !== undefined,
          hasNoteToPatient: input.noteToPatient !== undefined,
          hasIndication: input.indication !== undefined,
          // The kind alone — a coded workflow fact ("was this
          // transcription structured, and how") that coverage
          // reporting reads. The dose VALUES stay off the audit row:
          // the row's reader asks whether capture happened, not what
          // the regimen was, and the regimen is one join away for a
          // reader entitled to it.
          sigStructureKind: input.sigStructureKind ?? null,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "prescription.created.v1",
          aggregateType: "Prescription",
          aggregateId: prescriptionId,
          payload: {
            prescriptionId,
            organizationId: tenantId,
            clinicId: input.clinicId,
            patientId: input.patientId,
            providerId: input.providerId,
            drugNdc,
            controlledSubstanceSchedule: schedule,
            refillsAuthorized: input.refillsAuthorized,
            daysSupply: input.daysSupply,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Decide the schedule snapshot to store.
 *
 * The catalog wins when it has an opinion. A caller-supplied value is
 * accepted only when it agrees, or when the NDC is uncatalogued and
 * the caller is the only source available.
 */
function resolveSchedule(args: {
  catalogSchedule: ControlledSubstanceSchedule | null;
  declared: ControlledSubstanceSchedule | null;
  drugNdc: string;
}): ControlledSubstanceSchedule {
  const { catalogSchedule, declared, drugNdc } = args;

  if (catalogSchedule === null) {
    if (declared === null) {
      throw new errors.ValidationError({
        code: RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC,
        message:
          "This NDC is not in the product catalog, so its DEA schedule must be stated explicitly.",
        issues: [
          {
            path: ["controlledSubstanceSchedule"],
            message: "required when the NDC is not catalogued",
          },
        ],
        metadata: { drugNdc },
      });
    }
    return declared;
  }

  if (declared !== null && declared !== catalogSchedule) {
    throw new errors.ValidationError({
      code: RX_SCHEDULE_CATALOG_MISMATCH,
      message: `The product catalog lists this NDC as ${catalogSchedule}, not ${declared}.`,
      issues: [
        { path: ["controlledSubstanceSchedule"], message: "disagrees with the product catalog" },
      ],
      metadata: { drugNdc, catalogSchedule, declared },
    });
  }

  return catalogSchedule;
}

/**
 * The cross-field rules a structured sig must satisfy, mirrored by
 * the `prescription_structured_sig_shape` CHECK constraint:
 *
 *   - No kind → no values. A dose amount with no kind has no defined
 *     reading and must not be storable.
 *   - FIXED and RANGE promise a computable daily figure, so amount,
 *     unit and frequency are all required.
 *   - PRN and TAPER may be bare — "structured, with no single
 *     comparable number" is an honest and legal state — but what IS
 *     supplied must cohere: an amount and a unit travel together, and
 *     a frequency without an amount computes nothing.
 */
function validateStructuredSigShape(input: CreatePrescriptionInput): void {
  const { sigStructureKind: kind, doseAmount, doseUnit, dosesPerDay } = input;

  const refuse = (message: string, paths: ReadonlyArray<string>): never => {
    throw new errors.ValidationError({
      code: RX_STRUCTURED_SIG_SHAPE_INVALID,
      message,
      issues: paths.map((path) => ({ path: [path], message })),
      metadata: { sigStructureKind: kind ?? null },
    });
  };

  if (kind === undefined) {
    if (doseAmount !== undefined || doseUnit !== undefined || dosesPerDay !== undefined) {
      refuse(
        "Structured dose values require a sig structure kind; without one they have no defined reading.",
        ["sigStructureKind"]
      );
    }
    return;
  }

  switch (kind) {
    case SigStructureKind.FIXED:
    case SigStructureKind.RANGE: {
      if (doseAmount === undefined || doseUnit === undefined || dosesPerDay === undefined) {
        refuse(
          `A ${kind} structured sig requires a dose amount, a unit and a doses-per-day frequency.`,
          ["doseAmount", "doseUnit", "dosesPerDay"].filter(
            (field) => (input as Record<string, unknown>)[field] === undefined
          )
        );
      }
      return;
    }
    case SigStructureKind.PRN:
    case SigStructureKind.TAPER: {
      if ((doseAmount === undefined) !== (doseUnit === undefined)) {
        refuse("A dose amount and its unit must be supplied together.", [
          doseAmount === undefined ? "doseAmount" : "doseUnit",
        ]);
      }
      if (dosesPerDay !== undefined && doseAmount === undefined) {
        refuse(
          "A doses-per-day value without a dose amount computes nothing; supply the amount or omit the frequency.",
          ["doseAmount"]
        );
      }
      return;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`unreachable sig structure kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Units in which `quantityAuthorized` is conventionally denominated,
 * making quantity ÷ (dose × frequency) a days figure rather than a
 * category error. A dose in MG against a quantity in tablets is not
 * cross-checkable without the product's strength, which this command
 * does not resolve — so those transcriptions are simply not checked.
 */
const QUANTITY_DENOMINATED_DOSE_UNITS: ReadonlySet<DoseUnit> = new Set([
  DoseUnit.TABLET,
  DoseUnit.CAPSULE,
  DoseUnit.ML,
  DoseUnit.PATCH,
]);

/**
 * The days-supply cross-check: quantityAuthorized ÷ (doseAmount ×
 * dosesPerDay) against the stated daysSupply, for a FIXED sig in a
 * quantity-denominated unit.
 *
 * A HARD ERROR, not a captured warning, decided on three grounds:
 * the operator is holding the script when it fires, so the fix is one
 * field edit now versus a review queue nobody owns later; the
 * structured dose flows into clinical screening as fact, so an
 * arithmetic contradiction is exactly the transcription error that
 * becomes a wrong label; and the band is wide enough (2x either way)
 * that no legitimate rounding — "dispense 30, 28 days supply",
 * partial-unit doses — can reach it. Only FIXED is checked: PRN and
 * TAPER have no fixed consumption rate, and a RANGE's upper bound
 * legitimately implies a shorter duration than the stated supply.
 */
function validateDaysSupplyConsistency(input: CreatePrescriptionInput): void {
  if (input.sigStructureKind !== SigStructureKind.FIXED) return;
  if (input.doseAmount === undefined || input.doseUnit === undefined) return;
  if (input.dosesPerDay === undefined) return;
  if (!QUANTITY_DENOMINATED_DOSE_UNITS.has(input.doseUnit)) return;

  const dailyConsumption = Number(input.doseAmount) * Number(input.dosesPerDay);
  const impliedDays = Number(input.quantityAuthorized) / dailyConsumption;

  if (impliedDays > input.daysSupply * 2 || impliedDays < input.daysSupply / 2) {
    throw new errors.ValidationError({
      code: RX_STRUCTURED_SIG_DAYS_SUPPLY_INCONSISTENT,
      message:
        `At ${input.doseAmount} ${input.doseUnit} x ${input.dosesPerDay}/day, the authorized ` +
        `quantity lasts about ${Math.round(impliedDays)} day(s), not the stated ${input.daysSupply}. ` +
        `One of quantity, dose, frequency or days supply was mistranscribed.`,
      issues: [{ path: ["daysSupply"], message: "contradicts quantity x dose x frequency" }],
      metadata: { impliedDaysSupply: Math.round(impliedDays), daysSupply: input.daysSupply },
    });
  }
}

/**
 * Operator-facing wording for a DEA refusal.
 *
 * One sentence per reason, each naming the action that resolves it.
 * "No DEA registration on file" sends someone to record one; it is the
 * wrong instruction when the real problem is that the registration
 * lapsed last month, and worse when the registration is fine but does
 * not cover Schedule II.
 */
function deaRefusalMessage(
  code: DeaAuthorityRefusalCode,
  schedule: ControlledSubstanceSchedule
): string {
  switch (code) {
    case DEA_AUTHORITY_NO_REGISTRATION:
      return `Prescriber has no DEA registration on file and cannot authorize a ${schedule} prescription. Record their registration first.`;
    case DEA_AUTHORITY_EXPIRED:
      return `Prescriber's DEA registration has expired and cannot authorize a ${schedule} prescription. Record the renewed registration.`;
    case DEA_AUTHORITY_NOT_ACTIVE:
      return `Prescriber's DEA registration is revoked or suspended and cannot authorize a ${schedule} prescription.`;
    case DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED:
      return `Prescriber's DEA registration does not cover ${schedule}. Check which schedules their registration authorizes.`;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * Default validity window when the caller does not state one.
 *
 * Six months for anything controlled, one year otherwise. Neither
 * number is a federal rule for every schedule — CII has no federal
 * expiry at all — so both are conservative defaults chosen to be no
 * longer than the strictest common state limit. A state overlay that
 * needs something shorter should pass `expiresAt` explicitly.
 */
function deriveExpiry(writtenDate: Date, schedule: ControlledSubstanceSchedule): Date {
  const months = isControlled(schedule)
    ? DEFAULT_CONTROLLED_VALIDITY_MONTHS
    : DEFAULT_NON_CONTROLLED_VALIDITY_MONTHS;
  return addUtcCalendarMonths(writtenDate, months);
}

/** `YYYY-MM-DD` → midnight UTC, matching the `@db.Date` columns. */
function toUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
