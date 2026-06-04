// CreateOrder — the first order-aggregate command.
//
// Why this is the reference implementation:
//
//   Every subsequent Phase 2 command (`StartTyping`, `ApprovePV1`,
//   `CompleteFill`, etc.) is a re-application of this same shape:
//   declare via `defineCommand`, validate by Zod, scope by tenancy,
//   gate by RBAC, mutate inside the tx with the factory writing
//   `order_event` + bus writing `audit_log` + outbox. CreateOrder is
//   the simplest possible instance of that pattern — no row lock
//   (the order doesn't exist yet), no SoD (no prior acts), no
//   version CAS (the new row is born at version 0).
//
// What this handler does inside the bus's tx:
//
//   1. Verify the referenced clinic exists in scope.
//      (Tenant RLS already guarantees cross-org reads return 0
//      rows; we additionally narrow by clinicId so a stale id
//      surfaces as ORDER_CLINIC_NOT_FOUND, not a generic NOT FOUND.)
//   2. Verify the referenced site exists in scope and is linked
//      to the clinic via `clinic_site`.
//   3. Verify every referenced prescription exists for that clinic
//      and patient. Mismatched prescriptions → CONFLICT (a fixable
//      caller error, not a privacy violation).
//   4. Resolve the intake bucket for `(siteId, RECEIVED)`. The
//      Phase 1 seed creates one system bucket per workflow stage
//      per site; admins can later add custom buckets and re-bind
//      this resolution.
//   5. Insert the Order row. `currentStatus = RECEIVED`, `version
//      = 0`, `slaDeadlineAt = computeOrderSlaDeadline(receivedAt,
//      priority)` from `@pharmax/sla`.
//   6. Insert one OrderLine per prescription.
//
// Outside the handler, the factory + bus together:
//
//   - Write `order_event { eventType: order.received.v1,
//     sequenceNumber: 1, payload: {...} }`.
//   - Write `event_outbox { eventType: order.received.v1, ... }`
//     so downstream consumers (billing event projection, queue
//     counters, notifications) see the order land.
//   - Write `audit_log { action: order.created, ... }` via the
//     hash-chained writer.
//   - Write `command_log` (RUNNING → SUCCEEDED).
//
// PHI invariant: this command does NOT carry decrypted PHI. The
// patient identity already exists on the `patient` row (encrypted
// at intake time by a separate `RegisterPatient` command that
// lands alongside the prescription intake API). CreateOrder takes
// only the `patientId` UUID, which is a system identifier — not
// PHI.

import { defineCommand } from "@pharmax/command-bus";
import { IntakeSourceKind, OrderPriority, OrderStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { computeOrderSlaDeadline, openInitialWaitBeforeTyping } from "@pharmax/sla";
import { BUCKET_CODE_FOR_STATUS } from "@pharmax/workflow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
// ---------------------------------------------------------------------------

export const ORDER_CLINIC_NOT_FOUND = "ORDER_CLINIC_NOT_FOUND";
export const ORDER_SITE_NOT_FOUND = "ORDER_SITE_NOT_FOUND";
export const ORDER_SITE_NOT_LINKED_TO_CLINIC = "ORDER_SITE_NOT_LINKED_TO_CLINIC";
export const ORDER_PATIENT_NOT_FOUND = "ORDER_PATIENT_NOT_FOUND";
export const ORDER_PATIENT_CLINIC_MISMATCH = "ORDER_PATIENT_CLINIC_MISMATCH";
export const ORDER_PRESCRIPTION_NOT_FOUND = "ORDER_PRESCRIPTION_NOT_FOUND";
export const ORDER_PRESCRIPTION_MISMATCH = "ORDER_PRESCRIPTION_MISMATCH";
export const ORDER_INTAKE_BUCKET_NOT_CONFIGURED = "ORDER_INTAKE_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// `.strict()` rejects extra fields — defense against the
// "client added a new property to leak data into command_log"
// failure mode. Strictness is also what catches typos at the
// boundary, before the handler runs.

const orderLineSchema = z
  .object({
    prescriptionId: z.uuid(),
    // Decimal-like; Prisma will accept the string and store as
    // Decimal(18,4). We keep the validation simple: positive,
    // up to 4 decimal places.
    quantityToFill: z.coerce
      .number()
      .positive()
      .refine((n) => Number.isFinite(n), "must be finite"),
    daysSupplyToFill: z.int().positive(),
  })
  .strict();

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    siteId: z.uuid(),
    patientId: z.uuid(),
    /**
     * Optional clinic-assigned external order number. NOT a PHI
     * carrier by convention; clinics that put PHI in their
     * external ids must be onboarded with a different field shape.
     */
    externalOrderNumber: z.string().min(1).max(120).optional(),
    /**
     * How this order entered the system. Driven by the upstream
     * route (`POST /api/orders` ⇒ API; CSV importer ⇒ CSV; etc.).
     */
    intakeSourceKind: z.enum([
      IntakeSourceKind.MANUAL,
      IntakeSourceKind.CSV,
      IntakeSourceKind.API,
      IntakeSourceKind.EHR_INTEGRATION,
      IntakeSourceKind.TRANSFERRED_IN,
    ]),
    /**
     * Optional upstream identifier (EHR encounter id, CSV batch
     * row id). Not a PHI carrier by convention.
     */
    intakeSourceRefId: z.string().min(1).max(120).optional(),
    priority: z
      .enum([OrderPriority.NORMAL, OrderPriority.RUSH, OrderPriority.EMERGENCY])
      .default(OrderPriority.NORMAL),
    lines: z.array(orderLineSchema).min(1).max(50),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CreateOrderOutput {
  readonly orderId: string;
  readonly orderLineIds: ReadonlyArray<string>;
  readonly currentStatus: "RECEIVED";
  readonly version: 0;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const CreateOrder = defineCommand<CreateOrderInput, CreateOrderOutput>({
  name: "CreateOrder",
  inputSchema,
  permission: PERMISSIONS.ORDERS_CREATE,
  // No `lockTarget` — the order doesn't exist yet.
  // Phase 2 commands that operate on an existing order (StartTyping,
  // ApprovePV1, …) will declare `lockTarget: { table: "order", by:
  // (i) => ({ id: i.orderId }) }`.
  loadPolicy: { code: "order.standard", version: 1 },
  redactFields: [],

  async exec({ tx, ctx, input, policy, clock, commandLogId }) {
    if (policy === undefined) {
      // Unreachable: loadPolicy is declared above. Defensive — if
      // the factory contract ever changes, the failure mode is
      // loud, not a NULL FK insert.
      throw new errors.InternalError({
        code: "CREATE_ORDER_NO_POLICY",
        message: "Workflow policy was not loaded for CreateOrder.",
      });
    }

    const orgId = ctx.organizationId;

    // ---- Step 1: clinic scope check ----
    const clinic = await tx.clinic.findFirst({
      where: { id: input.clinicId, organizationId: orgId },
      select: { id: true, status: true },
    });
    if (clinic === null) {
      throw new errors.NotFoundError({
        code: ORDER_CLINIC_NOT_FOUND,
        message: "Clinic not found for the active organization.",
        metadata: { clinicId: input.clinicId, organizationId: orgId },
      });
    }

    // ---- Step 2: site scope + clinic↔site link ----
    const site = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: orgId },
      select: { id: true, status: true },
    });
    if (site === null) {
      throw new errors.NotFoundError({
        code: ORDER_SITE_NOT_FOUND,
        message: "Pharmacy site not found for the active organization.",
        metadata: { siteId: input.siteId, organizationId: orgId },
      });
    }
    const link = await tx.clinicSite.findFirst({
      where: { clinicId: input.clinicId, siteId: input.siteId },
      select: { id: true },
    });
    if (link === null) {
      throw new errors.ConflictError({
        code: ORDER_SITE_NOT_LINKED_TO_CLINIC,
        message:
          "Selected site does not serve the selected clinic. Configure a clinic_site link before submitting.",
        metadata: { clinicId: input.clinicId, siteId: input.siteId },
      });
    }

    // ---- Step 3: patient scope check ----
    // Patient identity is scoped to (organizationId, clinicId);
    // mismatched clinicId surfaces as PATIENT_CLINIC_MISMATCH, not
    // a generic NOT FOUND. That distinction matters in production:
    // "wrong clinic" usually means the caller picked the wrong
    // clinic dropdown, while NOT FOUND usually means a stale id.
    const patient = await tx.patient.findFirst({
      where: { id: input.patientId, organizationId: orgId },
      select: { id: true, clinicId: true, status: true },
    });
    if (patient === null) {
      throw new errors.NotFoundError({
        code: ORDER_PATIENT_NOT_FOUND,
        message: "Patient not found for the active organization.",
        metadata: { patientId: input.patientId, organizationId: orgId },
      });
    }
    if (patient.clinicId !== input.clinicId) {
      throw new errors.ConflictError({
        code: ORDER_PATIENT_CLINIC_MISMATCH,
        message: "Patient is registered at a different clinic.",
        metadata: { patientId: input.patientId, clinicId: input.clinicId },
      });
    }

    // ---- Step 4: prescription bulk fetch + cross-check ----
    const prescriptionIds = input.lines.map((l) => l.prescriptionId);
    const prescriptions = await tx.prescription.findMany({
      where: {
        id: { in: prescriptionIds },
        organizationId: orgId,
        clinicId: input.clinicId,
        patientId: input.patientId,
      },
      select: { id: true, patientId: true, clinicId: true, status: true },
    });
    if (prescriptions.length !== prescriptionIds.length) {
      const found = new Set(prescriptions.map((p) => p.id));
      const missing = prescriptionIds.filter((id) => !found.has(id));
      throw new errors.ConflictError({
        code: ORDER_PRESCRIPTION_MISMATCH,
        message:
          "One or more prescriptions are missing, belong to a different patient, or live in a different clinic.",
        metadata: { missing },
      });
    }

    // ---- Step 5: resolve intake bucket ----
    // Intake bucket code = `BUCKET_CODE_FOR_STATUS.RECEIVED` (today
    // = "INBOX"). The map lives in `@pharmax/workflow` so every
    // workflow command — CreateOrder, StartTyping, ApprovePV1, …
    // — resolves the per-stage bucket from the same source of
    // truth. The Phase 1 seed creates one bucket per code per site
    // at the demo org (`prisma/seed.ts` BUCKETS list); newly created
    // orgs need an onboarding step that seeds the same set before
    // intake can begin. Missing bucket → loud `ORDER_INTAKE_BUCKET_NOT_CONFIGURED`
    // rather than orphan the order in a nonexistent queue.
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

    // ---- Step 6: insert Order ----
    // `slaDeadlineAt` is computed once at intake from the SLA
    // engine: `receivedAt + endToEndBudget × priorityMultiplier`
    // (RUSH / EMERGENCY compress the budget). The breach-evaluator
    // tick + the queue-row badges both classify against this single
    // deadline via `classifySlaStatus`.
    const now = clock.now();
    const slaDeadlineAt = computeOrderSlaDeadline({ receivedAt: now, priority: input.priority });
    const order = await tx.order.create({
      data: {
        organizationId: orgId,
        clinicId: input.clinicId,
        siteId: input.siteId,
        patientId: input.patientId,
        currentStatus: OrderStatus.RECEIVED,
        currentBucketId: intakeBucket.id,
        workflowPolicyId: policy.id,
        workflowPolicyVersion: policy.version,
        version: 0,
        priority: input.priority,
        intakeSourceKind: input.intakeSourceKind,
        receivedAt: now,
        slaDeadlineAt,
        ...(input.externalOrderNumber === undefined
          ? {}
          : { externalOrderNumber: input.externalOrderNumber }),
        ...(input.intakeSourceRefId === undefined
          ? {}
          : { intakeSourceRefId: input.intakeSourceRefId }),
      },
      select: { id: true },
    });

    // ---- Step 7: insert OrderLine rows ----
    const orderLineIds: string[] = [];
    for (const line of input.lines) {
      const created = await tx.orderLine.create({
        data: {
          organizationId: orgId,
          clinicId: input.clinicId,
          orderId: order.id,
          prescriptionId: line.prescriptionId,
          quantityToFill: new Prisma.Decimal(line.quantityToFill),
          daysSupplyToFill: line.daysSupplyToFill,
        },
        select: { id: true },
      });
      orderLineIds.push(created.id);
    }

    await openInitialWaitBeforeTyping({
      tx,
      organizationId: orgId,
      orderId: order.id,
      siteId: input.siteId,
      startedAt: now,
      commandLogId,
    });

    return {
      output: {
        orderId: order.id,
        orderLineIds,
        currentStatus: "RECEIVED" as const,
        version: 0 as const,
      },
      targetOrderId: order.id,
      audit: {
        action: "order.created",
        resourceType: "Order",
        resourceId: order.id,
        metadata: {
          clinicId: input.clinicId,
          siteId: input.siteId,
          intakeSourceKind: input.intakeSourceKind,
          priority: input.priority,
          lineCount: input.lines.length,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
        },
      },
      emits: [
        {
          eventType: "order.received.v1",
          aggregateType: "Order",
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            organizationId: orgId,
            clinicId: input.clinicId,
            siteId: input.siteId,
            patientId: input.patientId,
            priority: input.priority,
            intakeSourceKind: input.intakeSourceKind,
            lineCount: input.lines.length,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
