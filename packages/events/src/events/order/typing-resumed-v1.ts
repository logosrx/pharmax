// order.typing.resumed.v1 — typist picked the order back up after
// the missing-info blocker resolved.
//
// Producer: `ResumeTyping` (`@pharmax/verification`).
//   Transitions TYPING_PENDING_MISSING_INFO → TYPING_IN_PROGRESS,
//   sets `currentAssigneeUserId` to the resuming typist (who may
//   or may not be the original pausing typist — multiple typists
//   share a queue).
//
// Consumers (current):
//   - SLA timer: closes WAIT_BEFORE_RESUMING_TYPING / opens
//     TYPING_ACTIVE_RESUMED (handled inside the command tx via
//     `applyCommandStageIntervalTransition`, not via this event).
//   - Typist queue card: removes the amber "missing info" banner
//     from `/ops/typing` once the order leaves
//     TYPING_PENDING_MISSING_INFO.
//
// Consumers (future):
//   - Rework analytics: pair-join with the prior
//     order.typing.missing_info.v1 row on `orderId` to compute
//     "average time blocked per missing-info reason" — the
//     symmetric pair is the structural primitive for that report.
//
// PHI invariant: no PHI in this payload. The pausing/resuming
// typist identity pair is operational metadata.
//
// Symmetric pair: `order.typing.missing_info.v1`. The two events
// together form the structured pause/resume audit on the typing
// stage; consumers that care about the loop (rework dashboards,
// pharmacist-callback reconciliation) MUST handle both.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    /** Operator who reopened the order after the blocker cleared.
     *  Does NOT have to equal the prior event's
     *  `pausingTypistUserId` — whoever notices the blocker is
     *  resolved picks the order up. */
    resumingTypistUserId: z.uuid(),
    /** Site-scoped TYPING bucket the order is now back in as an
     *  in-progress row (same bucket id as during the pause; the
     *  status change moves it out of the exception-row partition). */
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    toState: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderTypingResumedV1 = defineEvent({
  name: "order.typing.resumed",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by ResumeTyping when a typist reopens an order parked in TYPING_PENDING_MISSING_INFO. Symmetric pair to order.typing.missing_info.v1; consumers that track rework analytics MUST handle both.",
});

export type OrderTypingResumedV1Payload = z.infer<typeof payloadSchema>;
