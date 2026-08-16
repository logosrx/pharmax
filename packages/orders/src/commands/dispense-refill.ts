// DispenseRefill — put a refill of an existing prescription into the
// workflow (go-live program task A5).
//
// A refill is NOT a new transcription: the prescription is already
// typed, screened and numbered. What a refill needs is (1) an
// authorization check — are there refills left, is the prescription
// still alive, does federal law permit another fill — and (2) an
// atomic decrement of `refillsRemaining` tied to the creation of the
// order that will consume it. This command is the only supported way
// to do either; before it existed nothing decremented
// `refillsRemaining` at all.
//
// Shape: `defineCommand` with `loadPolicy` and no `lockTarget`,
// exactly like `CreateOrder` — the order being created does not exist
// yet, so there is nothing for the factory to lock. The row that DOES
// need locking is the prescription, and the factory cannot lock that
// table (`LockableTable = "order"`). Instead of a raw `SELECT … FOR
// UPDATE` (which would need a security-review entry in
// scripts/check-raw-sql-usage.ts), the decrement is a GUARDED ATOMIC
// UPDATE: `updateMany` with `refillsRemaining > 0` and `status =
// ACTIVE` in the WHERE. Postgres takes the row lock on the UPDATE and
// holds it to commit, so two concurrent DispenseRefills serialize on
// the prescription row, and the `> 0` guard makes over-decrement
// impossible even if they did not. `count === 0` after validation
// passed means the state changed underneath us — refuse, never guess.
//
// Controlled substances, division of labour:
//   - HERE (refill initiation): Schedule II refills are refused
//     outright (21 CFR 1306.12(a)); the CIII/IV six-month horizon is
//     re-checked (21 CFR 1306.22(a)) as defense in depth — issuance
//     already clamps `expiresAt` to that horizon; and the refill
//     counter itself was validated against the federal cap at
//     issuance (`validateControlledPrescriptionAuthorization`).
//   - AT FILL TIME: `CompleteFill` remains the authoritative Part
//     1306 gate via the dispensing ledger (`@pharmax/fill`), where
//     the fill ordinal and partial-fill windows are evaluated against
//     the moment of supply. This command deliberately does not
//     duplicate that evaluation — an order can sit in a queue for
//     days, and the dispensing-time facts are the ones that count.
//
// The refill order enters the workflow at RECEIVED and walks the full
// chain — typing review, PV1, fill, final verification — like any
// other order. Refills skip nothing: the states exist to catch
// mistakes, and a refill can carry one just as easily as an original.
//
// PHI invariant: inputs are ids and an enum. Audit metadata and the
// outbox payload carry ids, the NDC and the schedule — the same 21
// CFR 1304 recordkeeping rationale as CreatePrescription — never
// names, DOBs or directions for use.

import { defineCommand } from "@pharmax/command-bus";
import {
  addUtcCalendarMonths,
  hasSixMonthRefillHorizon,
  startOfUtcDay,
} from "@pharmax/controlled-substances";
import {
  ControlledSubstanceSchedule,
  IntakeSourceKind,
  OrderPriority,
  OrderStatus,
  PatientStatus,
  PrescriptionStatus,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { computeOrderSlaDeadline, openInitialWaitBeforeTyping } from "@pharmax/sla";
import { BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";
import { z } from "zod";

import {
  ORDER_INTAKE_BUCKET_NOT_CONFIGURED,
  ORDER_SITE_NOT_FOUND,
  ORDER_SITE_NOT_LINKED_TO_CLINIC,
} from "./create-order.js";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const REFILL_PRESCRIPTION_NOT_FOUND = "REFILL_PRESCRIPTION_NOT_FOUND";
export const REFILL_PRESCRIPTION_NOT_ACTIVE = "REFILL_PRESCRIPTION_NOT_ACTIVE";
export const REFILL_PATIENT_NOT_ACTIVE = "REFILL_PATIENT_NOT_ACTIVE";
export const REFILL_SCHEDULE_II_PROHIBITED = "REFILL_SCHEDULE_II_PROHIBITED";
export const REFILL_PRESCRIPTION_EXPIRED = "REFILL_PRESCRIPTION_EXPIRED";
export const REFILL_SIX_MONTH_HORIZON_ELAPSED = "REFILL_SIX_MONTH_HORIZON_ELAPSED";
export const REFILL_NONE_REMAINING = "REFILL_NONE_REMAINING";
export const REFILL_ORDER_ALREADY_IN_FLIGHT = "REFILL_ORDER_ALREADY_IN_FLIGHT";
export const REFILL_STATE_CHANGED_CONCURRENTLY = "REFILL_STATE_CHANGED_CONCURRENTLY";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// Deliberately minimal. The quantity and days supply are NOT inputs:
// a refill re-dispenses exactly what the prescription authorizes per
// fill (`quantityAuthorized`, `daysSupply`). Letting a caller vary
// them here would turn "dispense a refill" into "dispense an
// arbitrary quantity against this Rx", which is a different act with
// different rules — partial fills are declared at CompleteFill with a
// stated regulatory basis, not smuggled in at intake.

const inputSchema = z
  .object({
    prescriptionId: z.uuid(),
    /** The pharmacy site that will fill this refill. */
    siteId: z.uuid(),
    priority: z
      .enum([OrderPriority.NORMAL, OrderPriority.RUSH, OrderPriority.EMERGENCY])
      .default(OrderPriority.NORMAL),
  })
  .strict();

export type DispenseRefillInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface DispenseRefillOutput {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly prescriptionId: string;
  /** Ordinal of THIS refill: 1 = first refill (fill #2). */
  readonly refillNumber: number;
  /** Refills left AFTER this dispensing. */
  readonly refillsRemaining: number;
  readonly currentStatus: "RECEIVED";
  readonly version: 0;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const DispenseRefill = defineCommand<DispenseRefillInput, DispenseRefillOutput>({
  name: "DispenseRefill",
  inputSchema,
  // `orders.create` rather than a new permission: dispensing a refill
  // IS creating an order, performed by the same intake operators, and
  // the prescription-side mutation (the counter decrement) has no
  // meaning without the order it feeds. A separate code would split
  // one operational act across two grants for no isolation gain.
  permission: PERMISSIONS.ORDERS_CREATE,
  // No `lockTarget` — the order doesn't exist yet. The prescription
  // row is locked by the guarded decrement (see header).
  loadPolicy: { code: "order.standard", version: 1 },
  redactFields: [],

  async exec({ tx, ctx, input, policy, clock, commandLogId }) {
    if (policy === undefined) {
      // Unreachable: loadPolicy is declared above. Defensive — same
      // stance as CreateOrder.
      throw new errors.InternalError({
        code: "DISPENSE_REFILL_NO_POLICY",
        message: "Workflow policy was not loaded for DispenseRefill.",
      });
    }

    const orgId = ctx.organizationId;
    const now = clock.now();
    const asOfDay = startOfUtcDay(now);

    // ---- Step 1: read the prescription ----
    const prescription = await tx.prescription.findFirst({
      where: { id: input.prescriptionId, organizationId: orgId },
      select: {
        id: true,
        clinicId: true,
        patientId: true,
        status: true,
        rxNumber: true,
        drugNdc: true,
        quantityAuthorized: true,
        daysSupply: true,
        refillsAuthorized: true,
        refillsRemaining: true,
        originalDateWritten: true,
        expiresAt: true,
        controlledSubstanceSchedule: true,
      },
    });
    if (prescription === null) {
      throw new errors.NotFoundError({
        code: REFILL_PRESCRIPTION_NOT_FOUND,
        message: "Prescription not found for the active organization.",
        metadata: { prescriptionId: input.prescriptionId, organizationId: orgId },
      });
    }
    if (prescription.status !== PrescriptionStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: REFILL_PRESCRIPTION_NOT_ACTIVE,
        message: `Prescription is ${prescription.status.toLowerCase()} and cannot be refilled.`,
        metadata: { prescriptionId: prescription.id, prescriptionStatus: prescription.status },
      });
    }

    // ---- Step 2: patient must still be active ----
    // Mirrors CreatePrescription's RX_PATIENT_NOT_ACTIVE: a refill
    // for a discharged or deceased patient is an error to catch at
    // intake, not in the fill room.
    const patient = await tx.patient.findFirst({
      where: { id: prescription.patientId, organizationId: orgId },
      select: { id: true, status: true },
    });
    if (patient === null || patient.status !== PatientStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: REFILL_PATIENT_NOT_ACTIVE,
        message: "The patient on this prescription is not active and cannot receive a refill.",
        metadata: {
          prescriptionId: prescription.id,
          patientStatus: patient?.status ?? "NOT_FOUND",
        },
      });
    }

    // ---- Step 3: controlled-substance refill caps ----
    // 21 CFR 1306.12(a): a Schedule II prescription may not be
    // refilled, ever. Issuance already forces refillsAuthorized to 0
    // for CII, so `refillsRemaining` would refuse this anyway — but
    // the operator deserves the regulatory reason, not "no refills
    // left".
    if (prescription.controlledSubstanceSchedule === ControlledSubstanceSchedule.CII) {
      throw new errors.ConflictError({
        code: REFILL_SCHEDULE_II_PROHIBITED,
        message: "A Schedule II prescription cannot be refilled; a new prescription is required.",
        metadata: {
          prescriptionId: prescription.id,
          schedule: prescription.controlledSubstanceSchedule,
          citation: "21 CFR 1306.12(a)",
        },
      });
    }

    // ---- Step 4: lifecycle expiry — no refill past expiresAt ----
    // The expiry day itself is fillable; the day after is not.
    if (asOfDay.getTime() > startOfUtcDay(prescription.expiresAt).getTime()) {
      throw new errors.ConflictError({
        code: REFILL_PRESCRIPTION_EXPIRED,
        message: "This prescription has expired and cannot be refilled.",
        metadata: {
          prescriptionId: prescription.id,
          expiresAt: prescription.expiresAt.toISOString().slice(0, 10),
        },
      });
    }

    // ---- Step 5: CIII/IV six-month horizon ----
    // Defense in depth: CreatePrescription clamps `expiresAt` to this
    // horizon at issuance (RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON), so
    // step 4 normally subsumes this. Re-derived here from
    // `originalDateWritten` so a row whose expiry was widened by a
    // later migration or manual correction still cannot pass.
    if (
      hasSixMonthRefillHorizon(prescription.controlledSubstanceSchedule) &&
      asOfDay.getTime() > addUtcCalendarMonths(prescription.originalDateWritten, 6).getTime()
    ) {
      throw new errors.ConflictError({
        code: REFILL_SIX_MONTH_HORIZON_ELAPSED,
        message:
          "A Schedule III or IV prescription may not be refilled more than six months after it was written.",
        metadata: {
          prescriptionId: prescription.id,
          schedule: prescription.controlledSubstanceSchedule,
          citation: "21 CFR 1306.22(a)",
        },
      });
    }

    // ---- Step 6: refills remaining ----
    if (prescription.refillsRemaining <= 0) {
      throw new errors.ConflictError({
        code: REFILL_NONE_REMAINING,
        message: "This prescription has no refills remaining.",
        metadata: {
          prescriptionId: prescription.id,
          refillsAuthorized: prescription.refillsAuthorized,
          refillsRemaining: prescription.refillsRemaining,
        },
      });
    }

    // ---- Step 7: no second order while one is in flight ----
    // An unshipped, uncancelled order already carries this
    // prescription — dispensing another refill now would put two
    // fills for the same Rx in the building at once. The blocker is
    // named in the error so the operator can find and resolve it.
    const inFlight = await tx.orderLine.findFirst({
      where: {
        organizationId: orgId,
        prescriptionId: prescription.id,
        order: {
          currentStatus: { notIn: [OrderStatus.SHIPPED, OrderStatus.CANCELLED] },
        },
      },
      select: { orderId: true },
    });
    if (inFlight !== null) {
      throw new errors.ConflictError({
        code: REFILL_ORDER_ALREADY_IN_FLIGHT,
        message:
          "An order for this prescription is already in the workflow. Ship or cancel it before dispensing another refill.",
        metadata: { prescriptionId: prescription.id, existingOrderId: inFlight.orderId },
      });
    }

    // ---- Step 8: site scope + clinic↔site link ----
    // Same checks and same stable error codes as CreateOrder; the
    // clinic comes from the prescription row rather than the caller.
    const site = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: orgId },
      select: { id: true },
    });
    if (site === null) {
      throw new errors.NotFoundError({
        code: ORDER_SITE_NOT_FOUND,
        message: "Pharmacy site not found for the active organization.",
        metadata: { siteId: input.siteId, organizationId: orgId },
      });
    }
    const link = await tx.clinicSite.findFirst({
      where: { clinicId: prescription.clinicId, siteId: input.siteId },
      select: { id: true },
    });
    if (link === null) {
      throw new errors.ConflictError({
        code: ORDER_SITE_NOT_LINKED_TO_CLINIC,
        message:
          "Selected site does not serve this prescription's clinic. Configure a clinic_site link before dispensing.",
        metadata: { clinicId: prescription.clinicId, siteId: input.siteId },
      });
    }

    // ---- Step 9: the guarded atomic decrement ----
    // The WHERE re-asserts every fact the decrement depends on, so
    // the validations above cannot be raced stale: if another
    // transaction consumed the last refill or retired the
    // prescription between step 1 and here, the count is 0 and we
    // refuse. On success Postgres holds the row lock to commit —
    // every statement after this line runs with the prescription
    // pinned.
    const decremented = await tx.prescription.updateMany({
      where: {
        id: prescription.id,
        organizationId: orgId,
        status: PrescriptionStatus.ACTIVE,
        refillsRemaining: { gt: 0 },
      },
      data: { refillsRemaining: { decrement: 1 } },
    });
    if (decremented.count !== 1) {
      throw new errors.ConflictError({
        code: REFILL_STATE_CHANGED_CONCURRENTLY,
        message:
          "The prescription changed while this refill was being dispensed. Re-check and retry.",
        metadata: { prescriptionId: prescription.id },
      });
    }

    const refillNumber = prescription.refillsAuthorized - prescription.refillsRemaining + 1;
    const refillsRemainingAfter = prescription.refillsRemaining - 1;

    // ---- Step 10: resolve intake bucket ----
    const intakeBucketCode = BUCKET_CODE_FOR_STATUS.RECEIVED;
    const intakeBucket = await tx.bucket.findFirst({
      where: { organizationId: orgId, siteId: input.siteId, code: intakeBucketCode },
      select: { id: true },
    });
    if (intakeBucket === null) {
      throw new errors.InternalError({
        code: ORDER_INTAKE_BUCKET_NOT_CONFIGURED,
        message: "No intake bucket configured for this site.",
        metadata: { siteId: input.siteId, expectedBucketCode: intakeBucketCode },
      });
    }

    // ---- Step 11: insert the refill order + its single line ----
    // `intakeSourceRefId` carries the prescription id so reporting
    // can distinguish refill orders from originals without a schema
    // change; the audit row (step 12) is the authoritative record.
    const slaDeadlineAt = computeOrderSlaDeadline({ receivedAt: now, priority: input.priority });
    const order = await tx.order.create({
      data: {
        organizationId: orgId,
        clinicId: prescription.clinicId,
        siteId: input.siteId,
        patientId: prescription.patientId,
        currentStatus: OrderStatus.RECEIVED,
        currentBucketId: intakeBucket.id,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        version: 0,
        priority: input.priority,
        intakeSourceKind: IntakeSourceKind.MANUAL,
        intakeSourceRefId: `refill:${prescription.id}`,
        receivedAt: now,
        slaDeadlineAt,
      },
      select: { id: true },
    });

    const orderLine = await tx.orderLine.create({
      data: {
        organizationId: orgId,
        clinicId: prescription.clinicId,
        orderId: order.id,
        prescriptionId: prescription.id,
        // A refill re-dispenses the authorized per-fill quantity.
        quantityToFill: prescription.quantityAuthorized,
        daysSupplyToFill: prescription.daysSupply,
      },
      select: { id: true },
    });

    await openInitialWaitBeforeTyping({
      tx,
      organizationId: orgId,
      orderId: order.id,
      siteId: input.siteId,
      startedAt: now,
      commandLogId,
    });

    // ---- Step 12: audit + events ----
    return {
      output: {
        orderId: order.id,
        orderLineId: orderLine.id,
        prescriptionId: prescription.id,
        refillNumber,
        refillsRemaining: refillsRemainingAfter,
        currentStatus: "RECEIVED" as const,
        version: 0 as const,
      },
      targetOrderId: order.id,
      audit: {
        action: "prescription.refill_dispensed",
        resourceType: "Prescription",
        resourceId: prescription.id,
        metadata: {
          orderId: order.id,
          clinicId: prescription.clinicId,
          siteId: input.siteId,
          rxNumber: prescription.rxNumber,
          drugNdc: prescription.drugNdc,
          controlledSubstanceSchedule: prescription.controlledSubstanceSchedule,
          refillNumber,
          refillsRemaining: refillsRemainingAfter,
          priority: input.priority,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
        },
      },
      emits: [
        {
          // Same event and same payload shape CreateOrder emits, so
          // every consumer (queue counters, SLA timer, billing
          // projection) sees a refill order land exactly like an
          // original.
          eventType: "order.received.v1",
          aggregateType: "Order",
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            organizationId: orgId,
            clinicId: prescription.clinicId,
            siteId: input.siteId,
            patientId: prescription.patientId,
            priority: input.priority,
            intakeSourceKind: IntakeSourceKind.MANUAL,
            lineCount: 1,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
