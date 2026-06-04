// EscalateOrderForSlaBreach — move an order into the EMERGENCY
// bucket because it has blown its SLA deadline.
//
// The order-domain counterpart to shipping's
// `EscalateOrderToEmergencyBucket` (which can't be reused — that
// command requires shipment/tracking/carrier fields and a
// shipping-only reason enum). Triggered by the worker's SLA
// breach-evaluator tick
// (`apps/worker/src/drains/sla-breach-evaluator.ts`), which scans
// for orders past `slaDeadlineAt` in a non-terminal status and
// dispatches this command under the per-org machine identity.
//
// What this does:
//   1. Lock the order row.
//   2. Resolve the org's EMERGENCY bucket by code.
//   3. Already in EMERGENCY → audit "reaffirmed" + noop event, no
//      mutation (the evaluator's claim query excludes already-
//      escalated orders, so this branch is a belt-and-suspenders
//      guard against a race between claim and dispatch).
//   4. Otherwise → CAS `currentBucketId = EMERGENCY` (version
//      bumped), emit `order.sla_breach_escalated.v1`.
//
// What this does NOT do:
//   - Mutate `currentStatus`. The order keeps the workflow state
//     it breached in; the bucket move is an OPERATIONAL signal,
//     not a workflow transition (identical stance to the shipping
//     escalation). The operator dispositions it out of EMERGENCY
//     via the existing ResolveOrderEscalation flow.
//
// Idempotency: the evaluator keys the dispatch on
// `"sla-escalate:{orderId}:{slaDeadlineMs}"` so a re-tick before
// the bucket move commits is a bus-level no-op; the already-in-
// EMERGENCY branch is the second line of defense.
//
// PHI invariant: no PHI read or written. Order id + deadline +
// bucket ids only.

import { defineCommand, type OutboxEventDraft } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const SLA_ESCALATE_BUCKET_NOT_CONFIGURED = "SLA_ESCALATE_BUCKET_NOT_CONFIGURED";

const EMERGENCY_BUCKET_CODE = "EMERGENCY";

const inputSchema = z
  .object({
    orderId: z.uuid(),
    /** The deadline the order blew, echoed onto the audit row +
     *  event for the timeline. */
    slaDeadlineAt: z.iso.datetime({ offset: true }),
    /** When the evaluator observed the breach (the tick's `now`). */
    breachedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type EscalateOrderForSlaBreachInput = z.infer<typeof inputSchema>;

export interface EscalateOrderForSlaBreachOutput {
  readonly orderId: string;
  readonly bucketId: string;
  readonly alreadyEscalated: boolean;
  readonly previousBucketId: string | null;
  readonly version: number;
}

export const EscalateOrderForSlaBreach = defineCommand<
  EscalateOrderForSlaBreachInput,
  EscalateOrderForSlaBreachOutput
>({
  name: "EscalateOrderForSlaBreach",
  inputSchema,
  permission: PERMISSIONS.ORDERS_ESCALATE_SLA,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "SLA_ESCALATE_NO_TARGET",
        message: "Locked target was not provided to EscalateOrderForSlaBreach handler.",
      });
    }

    const bucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: ctx.organizationId,
          code: EMERGENCY_BUCKET_CODE,
        },
      },
      select: { id: true },
    });
    if (bucket === null) {
      throw new errors.InternalError({
        code: SLA_ESCALATE_BUCKET_NOT_CONFIGURED,
        message:
          "EMERGENCY bucket is not provisioned for this organization. Run ProvisionDefaultBuckets.",
        metadata: { organizationId: ctx.organizationId },
      });
    }

    const slaDeadlineAt = new Date(input.slaDeadlineAt);
    const breachedAt = new Date(input.breachedAt);
    const now = clock.now();

    // ---- Already-in-EMERGENCY branch (race guard) ----
    if (bucket.id === target.currentBucketId) {
      return {
        output: {
          orderId: target.id,
          bucketId: bucket.id,
          alreadyEscalated: true,
          previousBucketId: null,
          version: target.version,
        },
        targetOrderId: target.id,
        audit: {
          action: "order.sla_breach_escalation_reaffirmed",
          resourceType: "Order",
          resourceId: target.id,
          metadata: {
            orderId: target.id,
            slaDeadlineAt: slaDeadlineAt.toISOString(),
            breachedAt: breachedAt.toISOString(),
            recordedAt: now.toISOString(),
            commandLogId,
          },
        },
        emits: [reaffirmEvent(target.id, ctx.organizationId, slaDeadlineAt, breachedAt, now)],
      };
    }

    // ---- First-time escalation ----
    const previousBucketId = target.currentBucketId;
    const nextVersion = target.version + 1;

    await tx.order.update({
      where: { id: target.id },
      data: { currentBucketId: bucket.id },
    });

    return {
      output: {
        orderId: target.id,
        bucketId: bucket.id,
        alreadyEscalated: false,
        previousBucketId,
        version: nextVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.escalated_for_sla_breach",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          slaDeadlineAt: slaDeadlineAt.toISOString(),
          breachedAt: breachedAt.toISOString(),
          previousBucketId,
          newBucketId: bucket.id,
          recordedAt: now.toISOString(),
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.sla_breach_escalated.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            slaDeadlineAt: slaDeadlineAt.toISOString(),
            breachedAt: breachedAt.toISOString(),
            previousBucketId,
            newBucketId: bucket.id,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

function reaffirmEvent(
  orderId: string,
  organizationId: string,
  slaDeadlineAt: Date,
  breachedAt: Date,
  recordedAt: Date
): OutboxEventDraft {
  return {
    eventType: "order.sla_breach_escalation_reaffirmed.v1",
    aggregateType: "Order",
    aggregateId: orderId,
    payload: {
      orderId,
      organizationId,
      slaDeadlineAt: slaDeadlineAt.toISOString(),
      breachedAt: breachedAt.toISOString(),
      recordedAt: recordedAt.toISOString(),
    },
  };
}
