// order.typing.missing_info.v1 — typist paused typing because a
// blocker (prescriber callback, illegible Rx, missing field, etc.)
// needs to clear before the transcription can continue.
//
// Producer: `MarkTypingMissingInfo` (`@pharmax/verification`).
//   Transitions TYPING_IN_PROGRESS → TYPING_PENDING_MISSING_INFO,
//   clears `currentAssigneeUserId` (the resuming typist may be a
//   different person on a different shift), moves the order to the
//   site-scoped TYPING bucket as an exception-styled row.
//
// Consumers (current):
//   - SLA timer: closes TYPING_ACTIVE / opens
//     WAIT_BEFORE_RESUMING_TYPING (handled by `@pharmax/sla`'s
//     `applyCommandStageIntervalTransition` directly inside the
//     command tx, not via this event — the event drives downstream
//     read models).
//   - Typist queue card: renders the amber "Resolve the gap and
//     resume typing" banner on `/ops/typing` for any row in this
//     state.
//
// Consumers (future):
//   - Pharmacist-intervention queue: PRESCRIBER_CALLBACK_REQUIRED
//     reason routes the order to a pharmacist callback worklist.
//   - Ops dashboard: "what % of typing pauses are
//     prescriber-callback this month?" — the closed `reasonCode`
//     enum is the GROUP BY column.
//
// PHI invariant: no PHI in this payload. `reasonCode` is
// operational vocabulary (see `MISSING_INFO_REASONS` in
// `@pharmax/verification`). The optional free-text note that may
// land in a future slice will live on an encrypted column on
// `typing_missing_info_record` (the schema is not yet defined; the
// audit row alone is the structured record today) and never on
// this event.
//
// Reason-code source-of-truth: the `MISSING_INFO_REASONS` const in
// `@pharmax/verification/src/missing-info-reasons.ts`. The local
// mirror below MUST stay in sync — the parity test
// `reason-code-mirror.test.ts` in `@pharmax/verification` pins
// both lists to be equal, so a drift fails CI loudly before any
// payload could be misrouted.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

/**
 * Mirror of `MISSING_INFO_REASONS` from
 * `@pharmax/verification/src/missing-info-reasons.ts`.
 *
 * Inlined (vs. importing) so `@pharmax/events` stays a leaf
 * dependency of every domain package — flipping the dependency
 * would create a cycle (verification depends on events to emit;
 * events depending on verification would close the loop).
 *
 * Parity: a sync test in `@pharmax/verification` asserts these
 * two arrays are deep-equal. Update both in lockstep.
 */
const MISSING_INFO_REASONS = [
  "PRESCRIBER_CALLBACK_REQUIRED",
  "PATIENT_CONTACT_REQUIRED",
  "INSURANCE_VERIFICATION_REQUIRED",
  "PRESCRIPTION_ILLEGIBLE",
  "MISSING_QUANTITY",
  "MISSING_DAYS_SUPPLY",
  "MISSING_REFILLS",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    /** Operator who hit the missing-info wall and paused typing.
     *  `currentAssigneeUserId` on the order row is CLEARED at the
     *  same time; the historical pausing-typist identity survives
     *  on this event and on `audit_log.metadata`. */
    pausingTypistUserId: z.uuid(),
    /** Site-scoped TYPING bucket the order is now parked in (the
     *  exception-state map routes TYPING_PENDING_MISSING_INFO back
     *  to the typing bucket as an exception row, not a separate
     *  bucket). */
    bucketId: z.uuid(),
    transitionId: z.string().min(1),
    fromState: z.string().min(1),
    /** Literal — kept as a `z.string()` (vs. `z.literal`) so a
     *  future workflow-policy slice that maps the same command to
     *  a different terminal state for a v2 policy does not silently
     *  fail validation. The payload's `toState` is informational;
     *  consumers branch on `eventType` for routing. */
    toState: z.string().min(1),
    reasonCode: z.enum(MISSING_INFO_REASONS),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderTypingMissingInfoV1 = defineEvent({
  name: "order.typing.missing_info",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by MarkTypingMissingInfo when a typist parks an order in TYPING_PENDING_MISSING_INFO. Carries the closed reasonCode so ops dashboards can group pauses by cause; the symmetric resume event is order.typing.resumed.v1.",
});

export type OrderTypingMissingInfoV1Payload = z.infer<typeof payloadSchema>;
