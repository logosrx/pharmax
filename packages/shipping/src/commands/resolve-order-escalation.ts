// ResolveOrderEscalation — operator disposition action that moves
// an order OUT of the EMERGENCY bucket back into a workflow bucket
// after a shipping clerk has triaged the carrier exception.
//
// This is the inverse of `EscalateOrderToEmergencyBucket`. Where
// the escalation command is machine-driven (outbox handler firing
// on `EXCEPTION` / `FAILED_DELIVERY` / `RETURN_TO_SENDER` tracking
// events), the resolution is human-driven (a shipping clerk picks
// the order off the EMERGENCY queue, dispositions it, and routes
// it onward).
//
// Disposition modes:
//
//   - `RETURN_TO_SHIPPING` — re-ship attempt. The order goes back
//     to the `SHIPPING` workflow bucket; the clerk is expected to
//     trigger a new label purchase via the existing `PurchaseShipmentLabel`
//     flow. `currentStatus` stays as-is (`SHIPPED` typically).
//
//   - `RETURN_TO_FILL` — physical re-fill needed (returned package
//     contents compromised, etc.). The order goes to `FILL`. Note
//     this does NOT mutate `currentStatus` — a follow-up workflow
//     command (a future `ReopenForRefill` or the existing
//     `ReopenForCorrection` family) handles the workflow state
//     transition. This command JUST moves the queue position so
//     the order is visible to the right operator.
//
//   - `KEEP_IN_EMERGENCY` — explicit acknowledgement that the
//     escalation is being worked on but routing decision deferred.
//     Writes audit + outbox so the timeline records the triage
//     touch but leaves bucket and status unchanged.
//
// Why this command does NOT touch `currentStatus`:
//
//   - The order's workflow status reflects what the workflow
//     engine knows happened. Tracking events are post-workflow
//     telemetry; the escalation flow uses BUCKET placement as the
//     operational signal, not status.
//
//   - Mutating status here would conflate the operational
//     "exception triage" axis with the workflow "where in the
//     pipeline" axis. A future `ReopenForRefill` workflow command
//     is the right place to flip status; this command is the
//     operational handoff.
//
// Guard rails:
//
//   - The order MUST currently be in EMERGENCY. Resolving an order
//     that isn't escalated is a programmer / UI bug; surface a
//     typed `ORDER_NOT_IN_EMERGENCY` error so the UI can refresh
//     instead of silently rewriting state.
//
//   - The target bucket MUST exist for the org and MUST be of a
//     reasonable kind (`WORKFLOW` for return-to-shipping/fill,
//     not another EMERGENCY/HOLD/CUSTOM). We resolve by code, so
//     callers ask for `"SHIPPING"` / `"FILL"`; the workflow
//     bucket constants live in `@pharmax/orgs`.
//
// PHI invariant: no PHI is read or written. `reasonText` is a
// free-text field that MAY contain operator notes (and possibly
// PHI by accident); it is redacted from `command_log.requestPayload`
// and replaced with a boolean `hasReasonText` in audit + outbox
// — same pattern as `PlaceHold` / `CancelOrder`.

import { defineCommand } from "@pharmax/command-bus";
import { BucketKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const RESOLVE_ESCALATION_NOT_IN_EMERGENCY = "RESOLVE_ESCALATION_NOT_IN_EMERGENCY";
export const RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND =
  "RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND";
export const RESOLVE_ESCALATION_TARGET_BUCKET_INVALID_KIND =
  "RESOLVE_ESCALATION_TARGET_BUCKET_INVALID_KIND";

const EMERGENCY_BUCKET_CODE = "EMERGENCY";

export const ESCALATION_DISPOSITIONS = [
  "RETURN_TO_SHIPPING",
  "RETURN_TO_FILL",
  "KEEP_IN_EMERGENCY",
] as const;
export type EscalationDisposition = (typeof ESCALATION_DISPOSITIONS)[number];

const DISPOSITION_TARGET_BUCKET: Readonly<
  Record<Exclude<EscalationDisposition, "KEEP_IN_EMERGENCY">, string>
> = Object.freeze({
  RETURN_TO_SHIPPING: "SHIPPING",
  RETURN_TO_FILL: "FILL",
});

const inputSchema = z
  .object({
    orderId: z.uuid(),
    disposition: z.enum(ESCALATION_DISPOSITIONS),
    /**
     * Optional operator note. MAY contain PHI by accident; redacted
     * from `command_log.requestPayload` and replaced with a boolean
     * `hasReasonText` flag in audit + outbox.
     */
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type ResolveOrderEscalationInput = z.infer<typeof inputSchema>;

export interface ResolveOrderEscalationOutput {
  readonly orderId: string;
  readonly disposition: EscalationDisposition;
  readonly previousBucketId: string;
  readonly newBucketId: string;
  /** `true` only when `disposition === KEEP_IN_EMERGENCY`. */
  readonly bucketUnchanged: boolean;
  readonly version: number;
}

export const ResolveOrderEscalation = defineCommand<
  ResolveOrderEscalationInput,
  ResolveOrderEscalationOutput
>({
  name: "ResolveOrderEscalation",
  inputSchema,
  permission: PERMISSIONS.SHIP_RESOLVE_ESCALATION,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  redactFields: ["reasonText"],

  async exec({ tx, ctx, input, target, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "RESOLVE_ESCALATION_NO_TARGET",
        message: "Locked target was not provided to ResolveOrderEscalation handler.",
      });
    }

    // Resolve EMERGENCY bucket so we can confirm the order is
    // actually escalated. Skipping this check would let the
    // operator silently re-bucket an order that was never in
    // EMERGENCY — a UI bug becomes a workflow corruption.
    const emergencyBucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: ctx.organizationId,
          code: EMERGENCY_BUCKET_CODE,
        },
      },
      select: { id: true },
    });
    if (emergencyBucket === null || target.currentBucketId !== emergencyBucket.id) {
      throw new errors.ConflictError({
        code: RESOLVE_ESCALATION_NOT_IN_EMERGENCY,
        message:
          "Order is not currently in the EMERGENCY bucket. Refresh the queue — another operator may have already dispositioned it.",
        metadata: {
          orderId: target.id,
          currentBucketId: target.currentBucketId,
          emergencyBucketId: emergencyBucket?.id ?? null,
        },
      });
    }

    const now = clock.now();
    const reasonText =
      typeof input.reasonText === "string" && input.reasonText.trim().length > 0
        ? input.reasonText
        : null;
    const hasReasonText = reasonText !== null;

    // ---- KEEP_IN_EMERGENCY branch: audit-only ----
    if (input.disposition === "KEEP_IN_EMERGENCY") {
      return {
        output: {
          orderId: target.id,
          disposition: input.disposition,
          previousBucketId: target.currentBucketId,
          newBucketId: target.currentBucketId,
          bucketUnchanged: true,
          version: target.version,
        },
        targetOrderId: target.id,
        audit: {
          action: "order.escalation_acknowledged",
          resourceType: "Order",
          resourceId: target.id,
          metadata: {
            orderId: target.id,
            disposition: input.disposition,
            hasReasonText,
            recordedAt: now.toISOString(),
            commandLogId,
          },
        },
        emits: [
          {
            eventType: "order.escalation_acknowledged.v1",
            aggregateType: "Order",
            aggregateId: target.id,
            payload: {
              orderId: target.id,
              organizationId: ctx.organizationId,
              disposition: input.disposition,
              hasReasonText,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    }

    // ---- Bucket-move branch ----
    const targetBucketCode = DISPOSITION_TARGET_BUCKET[input.disposition];
    const targetBucket = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: ctx.organizationId,
          code: targetBucketCode,
        },
      },
      select: { id: true, kind: true },
    });
    if (targetBucket === null) {
      throw new errors.InternalError({
        code: RESOLVE_ESCALATION_TARGET_BUCKET_NOT_FOUND,
        message: `Target bucket "${targetBucketCode}" is not provisioned for this organization. Run ProvisionDefaultBuckets.`,
        metadata: { organizationId: ctx.organizationId, targetBucketCode },
      });
    }
    if (targetBucket.kind !== BucketKind.WORKFLOW) {
      // Belt-and-braces: the disposition map only points at
      // SHIPPING + FILL today, both of which are seeded WORKFLOW.
      // This guard catches a future operator (or admin UI bug)
      // pointing the map at a CUSTOM/HOLD bucket.
      throw new errors.InternalError({
        code: RESOLVE_ESCALATION_TARGET_BUCKET_INVALID_KIND,
        message: `Target bucket "${targetBucketCode}" is not a WORKFLOW bucket (kind=${targetBucket.kind}).`,
        metadata: {
          organizationId: ctx.organizationId,
          targetBucketCode,
          actualKind: targetBucket.kind,
        },
      });
    }

    const previousBucketId = target.currentBucketId;
    const nextVersion = target.version + 1;

    await tx.order.update({
      where: { id: target.id },
      data: { currentBucketId: targetBucket.id },
    });

    return {
      output: {
        orderId: target.id,
        disposition: input.disposition,
        previousBucketId,
        newBucketId: targetBucket.id,
        bucketUnchanged: false,
        version: nextVersion,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: nextVersion },
      audit: {
        action: "order.escalation_resolved",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          disposition: input.disposition,
          previousBucketId,
          newBucketId: targetBucket.id,
          targetBucketCode,
          hasReasonText,
          recordedAt: now.toISOString(),
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.escalation_resolved.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            disposition: input.disposition,
            previousBucketId,
            newBucketId: targetBucket.id,
            targetBucketCode,
            hasReasonText,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});
