// StartFinalVerification — a pharmacist claims an order from the
// FINAL queue and begins the SECOND pharmacist verification, the
// last safety check before the order is released to shipping.
//
// Why this is a meaningful "first" in the codebase:
//
//   It is the FIRST FINAL-STAGE COMMAND, opening the verification
//   loop that closes when `ApproveFinalVerification` releases the
//   order to ship (or `RejectFinalVerification` bounces it back to
//   FILL for rework). Structurally identical to `StartPV1` — same
//   `lockTarget` + `loadPolicy: { from: "target" }` + `bumpVersion`
//   triad, different edge of the same v1 engine, different
//   destination state and error vocabulary.
//
//   This command introduces the FINAL-stage error vocabulary
//   (`FINAL_POLICY_UNSUPPORTED`, `FINAL_INVALID_TRANSITION`,
//   `FINAL_ORDER_TERMINAL`, `FINAL_ORDER_STATE_UNKNOWN`) that
//   `ApproveFinalVerification` and `RejectFinalVerification` will
//   REUSE — same "one stable code per failure class per stage"
//   convention as the typing and PV1 stages. It also introduces
//   `FINAL_BUCKET_NOT_CONFIGURED` for the destination bucket
//   misconfiguration; that code will be REUSED across the FINAL
//   stage just as `PV1_BUCKET_NOT_CONFIGURED` is across the PV1
//   stage.
//
// What this handler does inside the bus's tx (post-lock, post-policy):
//
//   1. Reject if the loaded policy isn't `order.standard@v1`. Same
//      replay-correctness guarantee as every other state-transition
//      command in this codebase.
//   2. Validate the (currentState, START_FINAL_VERIFICATION)
//      transition via the pure engine. Result codes map to typed
//      `PharmaxError` instances with the FINAL-stage vocabulary.
//   3. Resolve the destination bucket from `target.siteId` and the
//      canonical bucket code for `FINAL_VERIFICATION_IN_PROGRESS`
//      via the shared `BUCKET_CODE_FOR_STATUS` map. Missing bucket
//      → `FINAL_BUCKET_NOT_CONFIGURED` (new code; will be REUSED
//      by `ApproveFinalVerification` / `RejectFinalVerification`).
//      The lookup happens unconditionally because
//      `FILL_COMPLETED_READY_FOR_FINAL` ALSO maps to `"FINAL"`
//      (the order is already in the FINAL bucket on entry); the
//      shared map is the source of truth and writing
//      `currentBucketId` keeps the column in a deterministic
//      end-state if an admin re-pointed the bucket mid-flight.
//   4. `order.update` — set `currentStatus =
//      FINAL_VERIFICATION_IN_PROGRESS`, `currentBucketId = <final
//      bucket>`, and `currentAssigneeUserId = ctx.actor.userId`.
//      The order has been sitting unassigned in the FINAL queue
//      since `CompleteFill` (when that command lands; today the
//      transition arrow exists in the engine but the fill stage
//      is unimplemented); this command claims it for the
//      verifying pharmacist. From now until
//      `ApproveFinalVerification` / `RejectFinalVerification` /
//      `PlaceHold`, the pharmacist "owns" the order.
//   5. The factory's `bumpVersion` CAS-bumps `version` — same
//      atomicity guarantee as every other state-transition
//      command.
//
// SoD invariant — read carefully before changing:
//
//   This command does NOT declare a `sodRules` clause. The SoD
//   registry (`@pharmax/rbac/separation-of-duties.ts`) has two
//   rules whose `attempted` permission is `FINAL_APPROVE`:
//
//     - `sod.pv1-final-same-actor`: forbids prior `PV1_APPROVE`
//       by the same actor on the same order.
//     - `sod.fill-final-same-actor`: forbids prior `FILL_COMPLETE`
//       by the same actor on the same order.
//
//   There is NO rule whose `attempted` is `FINAL_START`, and that
//   is deliberate: the SoD violation is the SIGN-OFF, not the act
//   of opening the review. A pharmacist may legitimately START a
//   final verification on an order they previously PV1-approved
//   or fill-completed — to read the data and immediately reject
//   the fill for being wrong, for example. What they MUST NOT do
//   is APPROVE that final verification. That constraint lands on
//   `ApproveFinalVerification` (which will declare TWO `sodRules`
//   entries — one for each prior-act forbid).
//
//   Declaring `sodRules: [{ attempted: FINAL_START, ... }]` here
//   would trigger an unnecessary `order_event.findMany` history
//   read inside this transaction for zero enforcement value — the
//   bus's `RULES_BY_ATTEMPTED.get(FINAL_START)` returns undefined
//   and `checkSoD` returns null without inspecting the history.
//   The test suite pins the absence of `findMany` to prevent the
//   regression. Same pattern as `StartPV1` and `RejectPV1`.
//
// Assignee semantics:
//
//   Symmetric to `StartPV1`: the actor takes ownership of the
//   order. `CompleteFill` will have cleared the assignee to NULL
//   when the order entered the FINAL queue; this command sets it
//   to the verifying pharmacist. `ApproveFinalVerification` /
//   `RejectFinalVerification` will each clear it again as the
//   order moves on (to SHIPPING for approval, back to FILL for
//   rejection).
//
// Two-pharmacist invariant (the safety promise this stage exists for):
//
//   A pharmacy operating system's reason-to-exist is the
//   two-pharmacist check: TWO different humans confirm the
//   prescription before it leaves the building. PV1 is check #1
//   (right typing); FINAL is check #2 (right vial, right label,
//   right lot, right count). SoD is enforced at APPROVAL of
//   final, not at the start — see the SoD note above.
//   Operationally this means a pharmacist who PV1-approved an
//   order CAN open it for final review (to coach a junior, or to
//   notice an upstream error worth rejecting), but CANNOT sign
//   off. The bus enforces this asymmetry; the command handler
//   just opens the review.
//
// SLA interval invariant:
//
//   Same as every state-transition command shipped so far — no
//   `order_stage_interval` row is written here. Phase 3 will
//   retrofit every command in lockstep to close
//   `WAIT_BEFORE_FINAL_VERIFICATION` and open
//   `FINAL_VERIFICATION_ACTIVE`. The per-stage timestamps
//   recorded today (`audit_log.occurredAt`,
//   `order_event.occurredAt`) are sufficient backfill input
//   when the interval table lands.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   pharmacistUserId, bucketIdAfter) and workflow identity
//   (fromState, toState, transitionId, policyId, policyVersion)
//   — zero patient PHI.

import { defineCommand, ORDER_VERSION_MISMATCH } from "@pharmax/command-bus";
import { OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { applyCommandStageIntervalTransition } from "@pharmax/sla";
import {
  applyTransition,
  BUCKET_CODE_FOR_STATUS,
  ORDER_STANDARD_V1,
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  isOrderState,
  type OrderState,
} from "@pharmax/workflow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
//
// The FINAL-stage error vocabulary mirrors the typing-stage and
// PV1-stage shapes. These codes will be SHARED across every
// FINAL-stage command (`ApproveFinalVerification`,
// `RejectFinalVerification`) — the next commands to land here
// will import them from this file the same way `ApprovePV1` /
// `RejectPV1` import the PV1-stage codes from `start-pv1.js`.
//
// `FINAL_BUCKET_NOT_CONFIGURED` is the destination-bucket-
// missing code for the FINAL bucket, paralleling
// `PV1_BUCKET_NOT_CONFIGURED` / `FILL_BUCKET_NOT_CONFIGURED`. It
// will be REUSED by `ApproveFinalVerification` (which resolves
// the SHIPPING bucket — different code there) and by
// `RejectFinalVerification` (which resolves the FILL bucket for
// rework — different code there) ONLY for the failure mode where
// the FINAL bucket itself is missing from the site
// configuration. Per-destination bucket-missing codes stay
// separate so operators reading dashboards know which bucket the
// site is missing.
// ---------------------------------------------------------------------------

export const FINAL_POLICY_UNSUPPORTED = "FINAL_POLICY_UNSUPPORTED";
export const FINAL_ORDER_STATE_UNKNOWN = "FINAL_ORDER_STATE_UNKNOWN";
export const FINAL_INVALID_TRANSITION = "FINAL_INVALID_TRANSITION";
export const FINAL_ORDER_TERMINAL = "FINAL_ORDER_TERMINAL";
export const FINAL_BUCKET_NOT_CONFIGURED = "FINAL_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type StartFinalVerificationInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface StartFinalVerificationOutput {
  readonly orderId: string;
  readonly currentStatus: "FINAL_VERIFICATION_IN_PROGRESS";
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const StartFinalVerification = defineCommand<
  StartFinalVerificationInput,
  StartFinalVerificationOutput
>({
  name: "StartFinalVerification",
  inputSchema,
  permission: PERMISSIONS.FINAL_START,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  // INTENTIONALLY EMPTY. See the SoD-invariant comment in the
  // header — the SoD registry has rules only for `attempted:
  // FINAL_APPROVE`. The two-pharmacist invariant is enforced at
  // SIGN-OFF (ApproveFinalVerification), not at OPEN-REVIEW
  // (this command). Adding `sodRules` here would cost a
  // findMany() per start without enforcing anything.
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "START_FINAL_VERIFICATION_NO_TARGET",
        message: "Locked target was not provided to StartFinalVerification handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "START_FINAL_VERIFICATION_NO_POLICY",
        message: "Workflow policy was not loaded for StartFinalVerification.",
      });
    }

    // Policy version gate. Same shape as every prior
    // state-transition command. FINAL-stage commands share their
    // own `FINAL_POLICY_UNSUPPORTED` code so operators reading
    // dashboards distinguish "the FINAL-stage handlers don't
    // recognize this policy" from "the PV1-stage handlers don't".
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: FINAL_POLICY_UNSUPPORTED,
        message:
          "StartFinalVerification handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: FINAL_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    // Pure-engine guard. The engine's tagged-union result codes
    // are mapped to PharmaxError with the FINAL-stage vocabulary.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "START_FINAL_VERIFICATION",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: FINAL_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: FINAL_INVALID_TRANSITION,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    // Destination bucket: FILL_COMPLETED_READY_FOR_FINAL → "FINAL"
    // AND FINAL_VERIFICATION_IN_PROGRESS → "FINAL" — same bucket
    // on both sides of this transition. The lookup still runs
    // because the shared `BUCKET_CODE_FOR_STATUS` map is the
    // source of truth.
    const finalBucketCode = BUCKET_CODE_FOR_STATUS.FINAL_VERIFICATION_IN_PROGRESS;
    const finalBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: finalBucketCode,
      },
      select: { id: true },
    });
    if (finalBucket === null) {
      throw new errors.InternalError({
        code: FINAL_BUCKET_NOT_CONFIGURED,
        message: `No ${finalBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: finalBucketCode },
      });
    }

    const pharmacistUserId = ctx.actor.userId;

    // Domain write: state + bucket + ASSIGNEE-SET. CompleteFill
    // (when it lands) will have cleared the assignee to NULL when
    // the order entered the FINAL queue; this command claims it
    // for the verifying pharmacist. ApproveFinalVerification /
    // RejectFinalVerification will each clear it again as the
    // order moves on. Symmetric to StartPV1's assignee-set.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.FINAL_VERIFICATION_IN_PROGRESS,
        currentBucketId: finalBucket.id,
        currentAssigneeUserId: pharmacistUserId,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "StartFinalVerification",
      tx,
      organizationId: ctx.organizationId,
      orderId: target.id,
      siteId: target.siteId,
      at: now,
      commandLogId,
      actorUserId: ctx.actor.userId,
    });

    return {
      output: {
        orderId: target.id,
        currentStatus: "FINAL_VERIFICATION_IN_PROGRESS" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.final.started",
        resourceType: "Order",
        resourceId: target.id,
        metadata: {
          orderId: target.id,
          fromState: transition.fromState,
          toState: transition.toState,
          transitionId: transition.transitionId,
          workflowPolicyId: policy.id,
          workflowPolicyVersion: policy.version,
          siteId: target.siteId,
          bucketIdAfter: finalBucket.id,
          pharmacistUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.final.started.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            pharmacistUserId,
            bucketId: finalBucket.id,
            transitionId: transition.transitionId,
            fromState: transition.fromState,
            toState: transition.toState,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
});

// Re-export the bus's CAS error code so callers of
// `@pharmax/verification` don't have to import `@pharmax/command-bus`
// just to handle a 409 from StartFinalVerification.
export { ORDER_VERSION_MISMATCH };
