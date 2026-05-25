// AddPrescription — append an additional Rx + OrderLine to an
// existing in-flight order.
//
// Why this is the second order-aggregate command (after CreateOrder):
//
//   It is the smallest possible exercise of the `defineCommand`
//   factory's `lockTarget` + `bumpVersion` CAS path. CreateOrder
//   created the order at `version=0` without a lock; AddPrescription
//   locks an existing order row, validates the caller-supplied
//   `expectedOrderVersion` against the locked target's version (a
//   rich-metadata client-driven concurrency check), and returns
//   `bumpVersion: { from, to }` so the factory CAS-bumps the row
//   inside the same tx. If the caller had a stale view of the order,
//   the in-handler check throws `ORDER_VERSION_MISMATCH` early with
//   both expected + actual versions in metadata; the factory's CAS
//   is then defense-in-depth (it never fires when the in-handler
//   check is correct, but it would catch any future bug that bypasses
//   the check).
//
// State guard:
//
//   `ADDABLE_STATES` is a hardcoded const in this file rather than a
//   policy lookup because adding a prescription is not a workflow
//   TRANSITION — the order's `currentStatus` does NOT change. The
//   `@pharmax/workflow` engine is for state-machine transitions; the
//   "is this state mutable for adding lines" question is a separate
//   domain rule that lives with this command. Once typing review is
//   approved (TYPED_READY_FOR_PV1 onward), adding requires an
//   explicit `ReopenForCorrection` so the audit trail records the
//   reopen reason. Same goes for ON_HOLD / CANCELLED / SHIPPED.
//
// Scope cross-check:
//
//   Same pattern as CreateOrder: the prescription lookup is scoped to
//   `(orgId, order.clinicId, order.patientId)` in ONE findFirst. A
//   stale or cross-clinic rxId returns `ORDER_PRESCRIPTION_MISMATCH`
//   — telling the caller "this Rx isn't on this patient" is a fixable
//   error, not a privacy leak. RLS + the in-handler org filter are
//   belt-and-braces against a misconfigured GUC.
//
// Duplicate guard:
//
//   `OrderLine` has no DB-level unique on `(orderId, prescriptionId)`
//   because a deliberate split-fill (two lines for the same Rx with
//   different quantities) is a real future use case. For Pass 1,
//   accidental duplicate adds are by far the more likely failure
//   mode, so we reject with `ORDER_PRESCRIPTION_ALREADY_ON_ORDER`.
//   The future `SplitFillLine` command will be the explicit path for
//   the deliberate-duplicate case.
//
// PHI invariant:
//
//   Audit metadata is PHI-free by construction:
//     {orderId, prescriptionId, orderLineId, clinicId, fromVersion,
//      toVersion, quantityToFill, daysSupplyToFill}.
//   Drug identity lives on the Prescription row (plaintext, but
//   patient-identifying in context). The outbox payload mirrors the
//   audit metadata. Downstream consumers JOIN to Prescription when
//   they need drug name / NDC.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { ORDER_PRESCRIPTION_MISMATCH } from "./create-order.js";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
//
// `ORDER_VERSION_MISMATCH` is owned by `@pharmax/command-bus`
// (factory CAS path). `ORDER_PRESCRIPTION_MISMATCH` is owned by
// `CreateOrder` and reused here so callers see one stable code for
// "this Rx isn't on this patient/clinic", regardless of which
// command surfaced it. The two we own are the codes that only
// AddPrescription can throw.
// ---------------------------------------------------------------------------

export const ORDER_NOT_IN_ADDABLE_STATE = "ORDER_NOT_IN_ADDABLE_STATE";
export const ORDER_PRESCRIPTION_ALREADY_ON_ORDER = "ORDER_PRESCRIPTION_ALREADY_ON_ORDER";

// ---------------------------------------------------------------------------
// Domain rule: which order states accept a new prescription line.
// ---------------------------------------------------------------------------
//
// Frozen and exported so admin UI and tests can introspect without
// reaching into the command. Any state OUTSIDE this set requires an
// explicit `ReopenForCorrection` first.
export const ADDABLE_STATES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.RECEIVED,
  OrderStatus.TYPING_IN_PROGRESS,
  OrderStatus.TYPING_PENDING_MISSING_INFO,
]);

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
    prescriptionId: z.uuid(),
    quantityToFill: z.coerce
      .number()
      .positive()
      .refine((n) => Number.isFinite(n), "must be finite"),
    daysSupplyToFill: z.int().positive(),
    /**
     * Caller's view of the order's `version` at the moment they
     * decided to add this Rx. Used for optimistic concurrency: if
     * another command bumped the order between the caller's read
     * and this write, the handler throws `ORDER_VERSION_MISMATCH`
     * with both expected + actual versions so the UI can re-fetch
     * and prompt.
     */
    expectedOrderVersion: z.int().nonnegative(),
  })
  .strict();

export type AddPrescriptionInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface AddPrescriptionOutput {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const AddPrescription = defineCommand<AddPrescriptionInput, AddPrescriptionOutput>({
  name: "AddPrescription",
  inputSchema,
  permission: PERMISSIONS.ORDERS_ADD_PRESCRIPTION,
  lockTarget: { table: "order", by: (input) => ({ id: input.orderId }) },
  // We do NOT loadPolicy here: AddPrescription is not a state
  // transition; the order's existing workflowPolicyId/Version on the
  // locked row are the source of truth, and we don't need to mutate
  // them. Future state-transition commands (StartTyping, ApprovePV1)
  // will load policy and call the workflow engine.
  redactFields: [],

  async exec({ tx, ctx, input, target, clock }) {
    if (target === undefined) {
      // Unreachable: lockTarget is declared above. Defensive — if
      // the factory contract ever changes, fail loud rather than
      // attempt a null-target write.
      throw new errors.InternalError({
        code: "ADD_PRESCRIPTION_NO_TARGET",
        message: "Locked order target was not provided to AddPrescription.",
      });
    }

    const orgId = ctx.organizationId;

    // ---- Step 1: state guard ----
    if (!ADDABLE_STATES.has(target.currentStatus as OrderStatus)) {
      throw new errors.ConflictError({
        code: ORDER_NOT_IN_ADDABLE_STATE,
        message: `Order is in state ${target.currentStatus}; adding a prescription requires the order to be in RECEIVED, TYPING_IN_PROGRESS, or TYPING_PENDING_MISSING_INFO. Use ReopenForCorrection first.`,
        metadata: {
          orderId: target.id,
          currentStatus: target.currentStatus,
          addableStates: Array.from(ADDABLE_STATES),
        },
      });
    }

    // ---- Step 2: optimistic-concurrency check ----
    // The factory's `bumpVersion` CAS is the in-DB belt; this is the
    // pre-flight braces so the caller gets a clear error with both
    // versions, not a generic `count != 1` from the CAS path.
    if (target.version !== input.expectedOrderVersion) {
      throw new errors.ConflictError({
        code: ORDER_VERSION_MISMATCH,
        message:
          "Order was modified by another command between your read and this submission. Refetch the order and retry.",
        metadata: {
          orderId: target.id,
          expectedVersion: input.expectedOrderVersion,
          actualVersion: target.version,
        },
      });
    }

    // ---- Step 3: fetch the order's clinic + patient ids ----
    // Lock SELECT list is intentionally narrow (no clinicId/patientId)
    // to avoid surfacing PHI-adjacent ids in the lock-and-log path.
    // For the prescription cross-check we need them — read in a
    // separate scoped findFirst.
    const orderScope = await tx.order.findFirst({
      where: { id: target.id, organizationId: orgId },
      select: { clinicId: true, patientId: true, siteId: true },
    });
    if (orderScope === null) {
      // Unreachable: the row was locked one statement ago. If we
      // somehow miss it now, surface as an internal error rather
      // than swallow.
      throw new errors.InternalError({
        code: "ADD_PRESCRIPTION_ORDER_VANISHED",
        message: "Order disappeared between row lock and scope read.",
        metadata: { orderId: target.id },
      });
    }

    // ---- Step 4: prescription scope + identity ----
    const prescription = await tx.prescription.findFirst({
      where: {
        id: input.prescriptionId,
        organizationId: orgId,
        clinicId: orderScope.clinicId,
        patientId: orderScope.patientId,
      },
      select: { id: true, status: true },
    });
    if (prescription === null) {
      throw new errors.ConflictError({
        code: ORDER_PRESCRIPTION_MISMATCH,
        message:
          "Prescription is missing, belongs to a different patient, or lives in a different clinic.",
        metadata: { prescriptionId: input.prescriptionId, orderId: target.id },
      });
    }

    // ---- Step 5: duplicate-line guard ----
    const existingLine = await tx.orderLine.findFirst({
      where: {
        organizationId: orgId,
        orderId: target.id,
        prescriptionId: input.prescriptionId,
      },
      select: { id: true },
    });
    if (existingLine !== null) {
      throw new errors.ConflictError({
        code: ORDER_PRESCRIPTION_ALREADY_ON_ORDER,
        message:
          "This prescription is already attached to this order. Use SplitFillLine for deliberate partial-quantity duplicates.",
        metadata: {
          orderId: target.id,
          prescriptionId: input.prescriptionId,
          existingOrderLineId: existingLine.id,
        },
      });
    }

    // ---- Step 6: insert OrderLine ----
    const orderLine = await tx.orderLine.create({
      data: {
        organizationId: orgId,
        clinicId: orderScope.clinicId,
        orderId: target.id,
        prescriptionId: input.prescriptionId,
        quantityToFill: new Prisma.Decimal(input.quantityToFill),
        daysSupplyToFill: input.daysSupplyToFill,
      },
      select: { id: true },
    });

    const now = clock.now();
    const fromVersion = target.version;
    const toVersion = target.version + 1;

    return {
      output: {
        orderId: target.id,
        orderLineId: orderLine.id,
        fromVersion,
        toVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: fromVersion, to: toVersion },
      audit: {
        action: "order.prescription.added",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          prescriptionId: input.prescriptionId,
          orderLineId: orderLine.id,
          clinicId: orderScope.clinicId,
          fromVersion,
          toVersion,
          quantityToFill: input.quantityToFill,
          daysSupplyToFill: input.daysSupplyToFill,
        },
      },
      emits: [
        {
          eventType: "order.prescription.added.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: orgId,
            clinicId: orderScope.clinicId,
            siteId: orderScope.siteId,
            prescriptionId: input.prescriptionId,
            orderLineId: orderLine.id,
            quantityToFill: input.quantityToFill,
            daysSupplyToFill: input.daysSupplyToFill,
            fromVersion,
            toVersion,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
