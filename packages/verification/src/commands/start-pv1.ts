// StartPV1 — a pharmacist claims an order from the PV1 queue and
// begins the first pharmacist verification.
//
// Why this is the third in-flight verification command (after
// StartTyping + CompleteTypingReview):
//
//   With this command shipped, the typing stage is end-to-end and
//   the PV1 stage is half-shipped (StartPV1 ↔ ApprovePV1/RejectPV1
//   remaining). Structurally identical to StartTyping — same lock +
//   load-policy-from-target + applyTransition + bumpVersion triad,
//   different edge of the same v1 engine, different destination
//   bucket and assignee semantics.
//
// What this handler does inside the bus's tx (post-lock, post-policy):
//
//   1. Reject if the loaded policy isn't `order.standard@v1`. Same
//      replay-correctness guarantee as the typing-stage commands.
//   2. Validate the (currentState, START_PV1) transition via the
//      pure engine. Result codes map to typed PharmaxError instances
//      with the PV1-stage error vocabulary (new this command;
//      shared with `ApprovePV1` / `RejectPV1` when they ship).
//   3. Resolve the destination bucket from `target.siteId` and the
//      canonical bucket code for `PV1_IN_PROGRESS` (which happens
//      to be "PV1" — the same bucket the order was already in for
//      `TYPED_READY_FOR_PV1`). The lookup still runs because (a)
//      it's cheap, (b) the shared `BUCKET_CODE_FOR_STATUS` map is
//      the source of truth, and (c) writing `currentBucketId`
//      unconditionally keeps the column in a deterministic
//      end-state regardless of whether an admin shuffled a bucket
//      between transitions.
//   4. `order.update` — set `currentStatus = PV1_IN_PROGRESS`,
//      `currentBucketId = <pv1 bucket>`, and `currentAssigneeUserId
//      = ctx.actor.userId`. The CompleteTypingReview step had
//      cleared the assignee to NULL; this command claims the order
//      for the pharmacist. From this point until ApprovePV1 /
//      RejectPV1 / PlaceHold, the pharmacist "owns" the order.
//   5. The factory's `bumpVersion` CAS-bumps `version` in a
//      separate updateMany — same atomicity guarantee as the
//      typing-stage commands.
//
// SoD invariant — read carefully:
//
//   This command does NOT declare a `sodRules` clause. The SoD
//   registry (`@pharmax/rbac/separation-of-duties.ts`) has rules
//   only for `attempted: PV1_APPROVE` (forbids prior
//   `TYPING_COMPLETE` by same actor) and `attempted: FINAL_APPROVE`
//   (forbids prior `PV1_APPROVE` / `FILL_COMPLETE`). There is no
//   rule whose `attempted` is `PV1_START`, and that is deliberate:
//   the SoD violation is the SIGN-OFF, not the act of opening the
//   review. A pharmacist may START a PV1 on an order they typed
//   (e.g., to read the data and immediately reject it for being
//   wrong) — what they MUST NOT do is approve it. That constraint
//   lands on `ApprovePV1` (the next command), which IS the first
//   `sodRules`-bearing command in the codebase.
//
//   Declaring `sodRules: [{ attempted: PV1_START, ... }]` here
//   would trigger an unnecessary `order_event` history read inside
//   this transaction for zero enforcement value — the bus's
//   `RULES_BY_ATTEMPTED.get(PV1_START)` returns `undefined` and
//   `checkSoD` returns null without inspecting the history. Keep
//   the declaration absent until the registry grows a matching
//   rule.
//
// Assignee semantics:
//
//   Symmetric to StartTyping: the actor takes ownership of the
//   order. CompleteTypingReview cleared the assignee to NULL; this
//   command sets it to the pharmacist. ApprovePV1 / RejectPV1 will
//   each clear it again as the order moves to the next queue.
//
// SLA interval invariant:
//
//   Same as the typing-stage commands — no `order_stage_interval`
//   row is written here. Phase 3 retrofits every command in
//   lockstep to close `WAIT_BEFORE_PV1` and open `PV1_ACTIVE`. The
//   per-stage timestamps recorded today (audit `occurredAt`,
//   `order_event.occurredAt`) are sufficient backfill input when
//   that table lands.
//
// PHI invariant:
//
//   Input carries `orderId` only. Audit metadata + outbox payload
//   reference scope (orderId, organizationId, siteId,
//   pharmacistUserId, bucketIdAfter) and workflow identity
//   (fromState, toState, transitionId, policyId, policyVersion) —
//   zero patient PHI.

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

import { PV1_BUCKET_NOT_CONFIGURED } from "./complete-typing-review.js";

// ---------------------------------------------------------------------------
// Error codes — stable, public, machine-matched.
//
// The PV1-stage error vocabulary mirrors the typing-stage shape
// (`PV1_POLICY_UNSUPPORTED`, `PV1_INVALID_TRANSITION`,
// `PV1_ORDER_TERMINAL`, `PV1_ORDER_STATE_UNKNOWN`). These will be
// SHARED across every PV1-stage command (`ApprovePV1`, `RejectPV1`)
// — the next command to land here will import them from this file
// the same way `CompleteTypingReview` imports the typing-stage
// codes from `start-typing.js`.
//
// The destination-bucket-missing code is REUSED from
// `complete-typing-review.js` — same site misconfiguration, same
// operator remediation, same stable code regardless of which
// command surfaces it.
// ---------------------------------------------------------------------------

export const PV1_POLICY_UNSUPPORTED = "PV1_POLICY_UNSUPPORTED";
export const PV1_ORDER_STATE_UNKNOWN = "PV1_ORDER_STATE_UNKNOWN";
export const PV1_INVALID_TRANSITION = "PV1_INVALID_TRANSITION";
export const PV1_ORDER_TERMINAL = "PV1_ORDER_TERMINAL";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type StartPV1Input = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface StartPV1Output {
  readonly orderId: string;
  readonly currentStatus: "PV1_IN_PROGRESS";
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const StartPV1 = defineCommand<StartPV1Input, StartPV1Output>({
  name: "StartPV1",
  inputSchema,
  permission: PERMISSIONS.PV1_START,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "START_PV1_NO_TARGET",
        message: "Locked target was not provided to StartPV1 handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "START_PV1_NO_POLICY",
        message: "Workflow policy was not loaded for StartPV1.",
      });
    }

    // Policy version gate. Same shape as the typing-stage commands;
    // PV1-stage commands share their own `PV1_POLICY_UNSUPPORTED`
    // code because operators reading dashboards need to know "the
    // PV1-stage handlers don't recognize this policy" distinctly
    // from "the typing-stage handlers don't recognize this policy".
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: PV1_POLICY_UNSUPPORTED,
        message:
          "StartPV1 handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: PV1_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    // Pure-engine guard. The engine's tagged-union result codes are
    // mapped to PharmaxError with the PV1-stage code vocabulary.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "START_PV1",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: PV1_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: PV1_INVALID_TRANSITION,
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

    // Destination bucket: TYPED_READY_FOR_PV1 → "PV1" AND
    // PV1_IN_PROGRESS → "PV1" — same bucket on both sides of this
    // transition. The lookup still runs because the shared
    // status→bucket map is the source of truth; writing
    // `currentBucketId` unconditionally keeps the column in a
    // deterministic end-state if an admin re-pointed a bucket
    // mid-flight.
    const pv1BucketCode = BUCKET_CODE_FOR_STATUS.PV1_IN_PROGRESS;
    const pv1Bucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: pv1BucketCode,
      },
      select: { id: true },
    });
    if (pv1Bucket === null) {
      throw new errors.InternalError({
        code: PV1_BUCKET_NOT_CONFIGURED,
        message: `No ${pv1BucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: pv1BucketCode },
      });
    }

    const pharmacistUserId = ctx.actor.userId;

    // Domain write: state + bucket + ASSIGNEE-SET. CompleteTypingReview
    // had cleared the assignee to NULL when the order entered the
    // PV1 queue; this command claims it for the pharmacist. ApprovePV1
    // / RejectPV1 will each clear it again as the order moves on.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.PV1_IN_PROGRESS,
        currentBucketId: pv1Bucket.id,
        currentAssigneeUserId: pharmacistUserId,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "StartPV1",
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
        currentStatus: "PV1_IN_PROGRESS" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.pv1.started",
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
          bucketIdAfter: pv1Bucket.id,
          pharmacistUserId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.pv1.started.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            pharmacistUserId,
            bucketId: pv1Bucket.id,
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
// just to handle a 409 from StartPV1.
export { ORDER_VERSION_MISMATCH };
