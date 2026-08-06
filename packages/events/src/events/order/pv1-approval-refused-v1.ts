// order.pv1.approval.refused.v1 — a pharmacist tried to sign off and
// the clinical-screening gate refused.
//
// Producer: `ApprovePV1` (`@pharmax/verification`).
// Consumers: the order timeline (a refused sign-off is something the
//   next person to open the order needs to see); rework and
//   alert-fatigue reporting, which cannot tell "screened and approved"
//   from "screened, refused, resolved, approved" without this.
//
// This event exists because the refusal now COMMITS. ApprovePV1 writes
// the screen its gate judged before raising the refusal, so the
// pharmacist can read and acknowledge exactly what blocked them; the
// same transaction is the natural place to say out loud that an
// approval was attempted and declined. Without it the only trace of
// the attempt is a `command_log` row, which is not on the order's
// timeline and is not something a report reads.
//
// Deliberately lean: `order.pv1.screening.recorded.v1` is emitted from
// the same transaction and already carries every finding's identity
// and grading. Repeating them here would be two sources for one fact.
// What this adds is the verdict — which code refused, and how many
// findings of each blocking kind stood behind it.
//
// PHI: codes and counts. No patient identifier, no drug name, no free
// text — the same posture as every other screening surface.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    /** The pharmacist whose sign-off was refused. */
    pharmacistUserId: z.uuid(),
    /**
     * `PV1_SCREENING_HARD_STOP` or
     * `PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED`. Kept as a string
     * rather than an enum for the same reason the finding vocabulary
     * is TEXT: the refusal list is designed to grow, and a new code
     * must not require a consumer redeploy to be readable.
     */
    refusalCode: z.string().min(1),
    workflowPolicyId: z.uuid(),
    workflowPolicyVersion: z.number().int().positive(),
    hardStopCount: z.number().int().nonnegative(),
    requiresAcknowledgementCount: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1ApprovalRefusedV1 = defineEvent({
  name: "order.pv1.approval.refused",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ApprovePV1 when the clinical-screening gate refuses a sign-off. The order does not transition; the screen the refusal was made against is recorded in the same transaction and is emitted alongside as order.pv1.screening.recorded.v1.",
});

export type OrderPv1ApprovalRefusedV1Payload = z.infer<typeof payloadSchema>;
