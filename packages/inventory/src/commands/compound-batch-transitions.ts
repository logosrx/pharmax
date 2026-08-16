// Compound batch lifecycle transitions.
//
//   COMPOUNDED → TESTING      SendCompoundBatchToTesting   (transition)
//   TESTING    → RELEASED     ReleaseCompoundBatch         (release)
//   TESTING    → REJECTED     RejectCompoundBatch          (release)
//   RELEASED   → DISPENSING   StartDispensingCompoundBatch (transition)
//
// Permission split: TRANSITION covers the operational moves a
// technician makes on the floor; RELEASE covers the quality verdict
// on a lab result — accepting or rejecting a TESTING batch decides
// whether its vials reach patients, so it is pharmacist-level.
//
// Concurrency: every transition is a compare-and-swap —
// `updateMany({ where: { id, status: <expected> } })`. Two operators
// racing on the same batch produce one winner and one typed
// BATCH_INVALID_TRANSITION; the batch row is never read-then-written
// without the status guard. StartDispensing additionally leans on
// the partial unique index (one DISPENSING batch per org/site/
// product) as the database-level backstop for its demote+promote
// pair.
//
// Every transition writes audit_log and an
// `inventory.compound_batch.status_changed.v1` outbox event with the
// from/to pair, so downstream consumers (labels, dashboards, SLA
// timers on "stuck at the lab") see one uniform stream.
//
// Catalog/inventory data only — no PHI anywhere in these commands.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import type { PrismaTxClient } from "@pharmax/command-bus";
import { CompoundBatchStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  BATCH_DISPENSING_CONFLICT,
  BATCH_INVALID_TRANSITION,
  BATCH_NOT_FOUND,
  BATCH_PAST_BUD,
  COMPOUND_BATCH_REJECTION_REASONS,
} from "../shared.js";

// ---------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------

const batchIdSchema = z.object({ batchId: z.uuid() }).strict();

interface LoadedBatch {
  readonly id: string;
  readonly siteId: string;
  readonly productId: string;
  readonly batchNumber: string;
  readonly status: CompoundBatchStatus;
  readonly beyondUseDate: Date;
}

async function loadBatch(
  tx: PrismaTxClient,
  organizationId: string,
  batchId: string
): Promise<LoadedBatch> {
  const batch = await tx.compoundBatch.findFirst({
    where: { id: batchId, organizationId },
    select: {
      id: true,
      siteId: true,
      productId: true,
      batchNumber: true,
      status: true,
      beyondUseDate: true,
    },
  });
  if (batch === null) {
    throw new errors.NotFoundError({
      code: BATCH_NOT_FOUND,
      message: "Compound batch not found in this organization.",
      metadata: { batchId },
    });
  }
  return batch;
}

function invalidTransition(
  batch: LoadedBatch,
  expected: CompoundBatchStatus,
  attempted: string
): never {
  throw new errors.ConflictError({
    code: BATCH_INVALID_TRANSITION,
    message: `This batch is ${batch.status}, not ${expected}; ${attempted} is not available.`,
    metadata: {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      currentStatus: batch.status,
      expectedStatus: expected,
    },
  });
}

/** CAS the batch from `from` to `to`; throws on a concurrent change. */
async function casTransition(args: {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly batch: LoadedBatch;
  readonly from: CompoundBatchStatus;
  readonly to: CompoundBatchStatus;
  readonly now: Date;
  readonly attempted: string;
  readonly rejectionReasonCode?: string;
}): Promise<void> {
  const updated = await args.tx.compoundBatch.updateMany({
    where: { id: args.batch.id, organizationId: args.organizationId, status: args.from },
    data: {
      status: args.to,
      statusChangedAt: args.now,
      ...(args.rejectionReasonCode === undefined
        ? {}
        : { rejectionReasonCode: args.rejectionReasonCode }),
    },
  });
  if (updated.count === 0) {
    // Lost a race: someone transitioned the batch between our load
    // and this write. Report against the freshly-loaded status.
    const current = await loadBatch(args.tx, args.organizationId, args.batch.id);
    invalidTransition(current, args.from, args.attempted);
  }
}

function statusChangedResult(args: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly batch: LoadedBatch;
  readonly from: CompoundBatchStatus;
  readonly to: CompoundBatchStatus;
  readonly now: Date;
  readonly commandLogId: string;
  readonly action: string;
  readonly extraMetadata?: Readonly<Record<string, unknown>>;
  readonly reasonCode?: string;
  readonly demotedBatchId?: string;
}): HandlerResult<CompoundBatchTransitionOutput> {
  return {
    output: {
      batchId: args.batch.id,
      batchNumber: args.batch.batchNumber,
      fromStatus: args.from,
      toStatus: args.to,
    },
    audit: {
      action: args.action,
      resourceType: "CompoundBatch",
      resourceId: args.batch.id,
      metadata: {
        batchNumber: args.batch.batchNumber,
        siteId: args.batch.siteId,
        productId: args.batch.productId,
        fromStatus: args.from,
        toStatus: args.to,
        commandLogId: args.commandLogId,
        ...(args.extraMetadata ?? {}),
      },
    },
    outboxEvents: [
      {
        eventType: "inventory.compound_batch.status_changed.v1",
        aggregateType: "CompoundBatch",
        aggregateId: args.batch.id,
        payload: {
          organizationId: args.organizationId,
          batchId: args.batch.id,
          siteId: args.batch.siteId,
          productId: args.batch.productId,
          batchNumber: args.batch.batchNumber,
          fromStatus: args.from,
          toStatus: args.to,
          ...(args.reasonCode === undefined ? {} : { reasonCode: args.reasonCode }),
          ...(args.demotedBatchId === undefined ? {} : { demotedBatchId: args.demotedBatchId }),
          changedByUserId: args.actorUserId,
          occurredAt: args.now.toISOString(),
        },
      },
    ],
  };
}

export interface CompoundBatchTransitionOutput {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly fromStatus: CompoundBatchStatus;
  readonly toStatus: CompoundBatchStatus;
}

// ---------------------------------------------------------------------
// SendCompoundBatchToTesting — COMPOUNDED → TESTING
// ---------------------------------------------------------------------

export type SendCompoundBatchToTestingInput = z.infer<typeof batchIdSchema>;

export const SendCompoundBatchToTesting: Command<
  SendCompoundBatchToTestingInput,
  CompoundBatchTransitionOutput
> = {
  name: "SendCompoundBatchToTesting",
  inputSchema: batchIdSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_TRANSITION,

  async handle({ input, ctx, tx, commandLogId, clock }) {
    const now = clock.now();
    const batch = await loadBatch(tx, ctx.organizationId, input.batchId);
    if (batch.status !== CompoundBatchStatus.COMPOUNDED) {
      invalidTransition(batch, CompoundBatchStatus.COMPOUNDED, "sending to testing");
    }
    await casTransition({
      tx,
      organizationId: ctx.organizationId,
      batch,
      from: CompoundBatchStatus.COMPOUNDED,
      to: CompoundBatchStatus.TESTING,
      now,
      attempted: "sending to testing",
    });
    return statusChangedResult({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actor.userId,
      batch,
      from: CompoundBatchStatus.COMPOUNDED,
      to: CompoundBatchStatus.TESTING,
      now,
      commandLogId,
      action: "inventory.compound_batch.sent_to_testing",
    });
  },
};

// ---------------------------------------------------------------------
// ReleaseCompoundBatch — TESTING → RELEASED
// ---------------------------------------------------------------------

const releaseSchema = z
  .object({
    batchId: z.uuid(),
    /** Lab report/certificate reference, e.g. a CoA number. Optional
     *  free text preserved in the audit record. */
    labReference: z.string().min(1).max(300).optional(),
  })
  .strict();

export type ReleaseCompoundBatchInput = z.infer<typeof releaseSchema>;

export const ReleaseCompoundBatch: Command<
  ReleaseCompoundBatchInput,
  CompoundBatchTransitionOutput
> = {
  name: "ReleaseCompoundBatch",
  inputSchema: releaseSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_RELEASE,

  async handle({ input, ctx, tx, commandLogId, clock }) {
    const now = clock.now();
    const batch = await loadBatch(tx, ctx.organizationId, input.batchId);
    if (batch.status !== CompoundBatchStatus.TESTING) {
      invalidTransition(batch, CompoundBatchStatus.TESTING, "releasing");
    }
    await casTransition({
      tx,
      organizationId: ctx.organizationId,
      batch,
      from: CompoundBatchStatus.TESTING,
      to: CompoundBatchStatus.RELEASED,
      now,
      attempted: "releasing",
    });
    return statusChangedResult({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actor.userId,
      batch,
      from: CompoundBatchStatus.TESTING,
      to: CompoundBatchStatus.RELEASED,
      now,
      commandLogId,
      action: "inventory.compound_batch.released",
      extraMetadata: { labReference: input.labReference ?? null },
    });
  },
};

// ---------------------------------------------------------------------
// RejectCompoundBatch — TESTING → REJECTED (terminal)
// ---------------------------------------------------------------------

const rejectSchema = z
  .object({
    batchId: z.uuid(),
    /** Why the lab failed the batch — "every rejection requires a
     *  reason code". */
    reasonCode: z.enum(COMPOUND_BATCH_REJECTION_REASONS),
    /** Free-text detail (lab report excerpt reference, etc.). Kept in
     *  audit metadata, not on the row. */
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();

export type RejectCompoundBatchInput = z.infer<typeof rejectSchema>;

export const RejectCompoundBatch: Command<RejectCompoundBatchInput, CompoundBatchTransitionOutput> =
  {
    name: "RejectCompoundBatch",
    inputSchema: rejectSchema,
    permission: PERMISSIONS.INVENTORY_BATCH_RELEASE,

    async handle({ input, ctx, tx, commandLogId, clock }) {
      const now = clock.now();
      const batch = await loadBatch(tx, ctx.organizationId, input.batchId);
      if (batch.status !== CompoundBatchStatus.TESTING) {
        invalidTransition(batch, CompoundBatchStatus.TESTING, "rejecting");
      }
      await casTransition({
        tx,
        organizationId: ctx.organizationId,
        batch,
        from: CompoundBatchStatus.TESTING,
        to: CompoundBatchStatus.REJECTED,
        now,
        attempted: "rejecting",
        rejectionReasonCode: input.reasonCode,
      });
      return statusChangedResult({
        organizationId: ctx.organizationId,
        actorUserId: ctx.actor.userId,
        batch,
        from: CompoundBatchStatus.TESTING,
        to: CompoundBatchStatus.REJECTED,
        now,
        commandLogId,
        action: "inventory.compound_batch.rejected",
        extraMetadata: { reasonCode: input.reasonCode, note: input.note ?? null },
        reasonCode: input.reasonCode,
      });
    },
  };

// ---------------------------------------------------------------------
// StartDispensingCompoundBatch — RELEASED → DISPENSING
// ---------------------------------------------------------------------

export type StartDispensingCompoundBatchInput = z.infer<typeof batchIdSchema>;

export const StartDispensingCompoundBatch: Command<
  StartDispensingCompoundBatchInput,
  CompoundBatchTransitionOutput
> = {
  name: "StartDispensingCompoundBatch",
  inputSchema: batchIdSchema,
  permission: PERMISSIONS.INVENTORY_BATCH_TRANSITION,

  async handle({ input, ctx, tx, commandLogId, clock }) {
    const now = clock.now();
    const batch = await loadBatch(tx, ctx.organizationId, input.batchId);
    if (batch.status !== CompoundBatchStatus.RELEASED) {
      invalidTransition(batch, CompoundBatchStatus.RELEASED, "starting dispensing");
    }

    // The BUD analogue of "no expired lot assignment": a batch past
    // its Beyond-Use Date must never become the dispensing batch,
    // released or not.
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (batch.beyondUseDate < today) {
      throw new errors.ValidationError({
        code: BATCH_PAST_BUD,
        message: "This batch is past its Beyond-Use Date and cannot be dispensed from.",
        metadata: {
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          beyondUseDate: batch.beyondUseDate.toISOString().slice(0, 10),
        },
      });
    }

    // Demote the incumbent (if any) back to RELEASED — "the batch we
    // dispense from" is a pointer, and this is the atomic re-point.
    const incumbent = await tx.compoundBatch.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: batch.siteId,
        productId: batch.productId,
        status: CompoundBatchStatus.DISPENSING,
        NOT: { id: batch.id },
      },
      select: { id: true, batchNumber: true },
    });
    if (incumbent !== null) {
      await tx.compoundBatch.updateMany({
        where: {
          id: incumbent.id,
          organizationId: ctx.organizationId,
          status: CompoundBatchStatus.DISPENSING,
        },
        data: { status: CompoundBatchStatus.RELEASED, statusChangedAt: now },
      });
    }

    try {
      await casTransition({
        tx,
        organizationId: ctx.organizationId,
        batch,
        from: CompoundBatchStatus.RELEASED,
        to: CompoundBatchStatus.DISPENSING,
        now,
        attempted: "starting dispensing",
      });
    } catch (err) {
      // The partial unique index (one DISPENSING batch per org/site/
      // product) is the backstop for a concurrent promote that our
      // demote above did not see.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new errors.ConflictError({
          code: BATCH_DISPENSING_CONFLICT,
          cause: err,
          message:
            "Another batch was concurrently made the dispensing batch for this product; reload and retry.",
          metadata: { batchId: batch.id, batchNumber: batch.batchNumber },
        });
      }
      throw err;
    }

    return statusChangedResult({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actor.userId,
      batch,
      from: CompoundBatchStatus.RELEASED,
      to: CompoundBatchStatus.DISPENSING,
      now,
      commandLogId,
      action: "inventory.compound_batch.dispensing_started",
      extraMetadata: {
        demotedBatchId: incumbent?.id ?? null,
        demotedBatchNumber: incumbent?.batchNumber ?? null,
      },
      ...(incumbent === null ? {} : { demotedBatchId: incumbent.id }),
    });
  },
};
