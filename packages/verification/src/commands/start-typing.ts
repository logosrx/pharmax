// StartTyping — the first workflow-progression command.
//
// Why this command is structurally important (and what makes it
// distinct from `CreateOrder`):
//
//   `CreateOrder` exercises `defineCommand`'s "create" path:
//   no `lockTarget`, policy resolved by `(code, version)`, no version
//   CAS (the row is born at version 0). Every subsequent command in
//   the workflow chain — typing, PV1, fill, final, ship — operates
//   on an EXISTING order row. StartTyping is the reference
//   implementation of that "in-flight" path:
//
//     1. `lockTarget: { table: "order", by: (i) => ({ id: i.orderId }) }`
//        — the factory issues `SELECT … FOR UPDATE` on the order row
//        before any other write inside the tx. Concurrent writers
//        for the same order serialize against this lock.
//     2. `loadPolicy: { from: "target" }` — the factory reads the
//        policy id + version OFF the locked row, not from a hardcoded
//        lookup. This is the policy-replay-correctness guarantee:
//        an order created under v1 stays under v1 even if v2 is
//        activated mid-flight.
//     3. `applyTransition({ policy: engine, currentState, command:
//        "START_TYPING" })` — the pure workflow engine validates the
//        (state, command) pair against the in-memory policy. The
//        engine returns a tagged-union result; we map workflow
//        error codes to `PharmaxError` instances here, which is
//        the engine's contract (the engine doesn't import error
//        classes — keeps it dependency-light and UI-reusable).
//     4. `bumpVersion: { from: target.version, to: target.version + 1 }`
//        — the factory issues a `updateMany where: { id, version:
//        from }` CAS at the end of the handler. Mismatched count
//        throws `ConflictError(ORDER_VERSION_MISMATCH)`. Belt-and-
//        braces under the row lock from step 1: a concurrent writer
//        cannot interleave inside this tx, but the CAS guards
//        against a programmer who forgot to lock somewhere upstream.
//
// What this handler does inside the bus's tx (post-lock, post-policy):
//
//   1. Reject if the loaded policy isn't `order.standard@v1`. v2 will
//      land its own command set with a v2-aware handler.
//   2. Resolve the in-memory engine policy (`ORDER_STANDARD_V1`).
//   3. Validate the (currentState, START_TYPING) transition via
//      `applyTransition`. On failure, map the engine's error code
//      to a Pharmax error and throw — the tx rolls back and the
//      caller sees a stable error code.
//   4. Resolve the typing bucket from `target.siteId` and the
//      canonical bucket code for `TYPING_IN_PROGRESS`
//      (`BUCKET_CODE_FOR_STATUS` from `@pharmax/workflow` — same
//      source-of-truth `CreateOrder` uses). Missing bucket →
//      `TYPING_BUCKET_NOT_CONFIGURED` — a misconfigured org is a
//      loud failure, not a silent orphaning of the order.
//   5. `order.update` — set `currentStatus`, `currentBucketId`,
//      `currentAssigneeUserId`. The factory's `bumpVersion` then
//      CAS-bumps `version` in a separate updateMany (both writes
//      are atomic under the same row lock).
//
// `siteId` and `clinicId` are read off the locked row by the factory's
// `lockOrderRow` projection (`LockedOrderTarget`) — there's no extra
// `findUnique` here. One SELECT, one UPDATE, one CAS, all under the
// same row lock.
//
// SLA interval invariant: closes `WAIT_BEFORE_TYPING` and opens
// `TYPING_ACTIVE` via `@pharmax/sla`. Remaining workflow commands
// will be retrofitted in lockstep using the same recorder.
//
// SoD invariant: this command does NOT declare a `sodRules` clause.
// The current SoD registry has no rule with `attempted: TYPING_START`
// — the typist may be the same actor who created the order. Where
// the typist IS constrained is at PV1_APPROVE (the typist cannot
// approve their own typing); that rule fires on `ApprovePV1`, not
// here. See `@pharmax/rbac/separation-of-duties.ts` for the canonical
// rule registry.
//
// PHI invariant: input carries `orderId` only. Audit metadata + outbox
// payload reference scope (orderId, organizationId, siteId,
// typistUserId, bucketId) and workflow identity (fromState, toState,
// transitionId, policyId, policyVersion) — zero patient PHI.

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
// ---------------------------------------------------------------------------

export const TYPING_POLICY_UNSUPPORTED = "TYPING_POLICY_UNSUPPORTED";
export const TYPING_ORDER_STATE_UNKNOWN = "TYPING_ORDER_STATE_UNKNOWN";
export const TYPING_INVALID_TRANSITION = "TYPING_INVALID_TRANSITION";
export const TYPING_ORDER_TERMINAL = "TYPING_ORDER_TERMINAL";
export const TYPING_BUCKET_NOT_CONFIGURED = "TYPING_BUCKET_NOT_CONFIGURED";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
//
// `.strict()` rejects unknown keys at the boundary — keeps a future
// client from sneaking PHI into `command_log.requestPayload` by
// adding an undeclared field.

const inputSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type StartTypingInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface StartTypingOutput {
  readonly orderId: string;
  readonly currentStatus: "TYPING_IN_PROGRESS";
  readonly version: number;
  readonly transitionId: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const StartTyping = defineCommand<StartTypingInput, StartTypingOutput>({
  name: "StartTyping",
  inputSchema,
  permission: PERMISSIONS.TYPING_START,
  lockTarget: {
    table: "order",
    by: (input) => ({ id: input.orderId }),
  },
  loadPolicy: { from: "target" },
  redactFields: [],

  async exec({ tx, ctx, target, policy, clock, commandLogId }) {
    if (target === undefined) {
      throw new errors.InternalError({
        code: "START_TYPING_NO_TARGET",
        message: "Locked target was not provided to StartTyping handler.",
      });
    }
    if (policy === undefined) {
      throw new errors.InternalError({
        code: "START_TYPING_NO_POLICY",
        message: "Workflow policy was not loaded for StartTyping.",
      });
    }

    // Resolve the in-memory engine policy. The locked order carries a
    // (code, version) pair that pins which version's transition table
    // governs this row. Only v1 ships today; v2 will be a separate
    // command file in this package that consumes its own engine.
    if (policy.code !== "order.standard" || policy.version !== 1) {
      throw new errors.InternalError({
        code: TYPING_POLICY_UNSUPPORTED,
        message:
          "StartTyping handler is wired only for order.standard v1. " +
          "Add a v2 handler before activating a v2 workflow policy.",
        metadata: { policyCode: policy.code, policyVersion: policy.version },
      });
    }

    if (!isOrderState(target.currentStatus)) {
      throw new errors.InternalError({
        code: TYPING_ORDER_STATE_UNKNOWN,
        message: "Order has an unrecognized currentStatus value.",
        metadata: { currentStatus: target.currentStatus, orderId: target.id },
      });
    }
    const currentState: OrderState = target.currentStatus;

    // Pure-engine guard — TOTAL function, no I/O, no clock. The
    // result codes are the workflow-error-code vocabulary; we map
    // each to the Pharmax error class with a stable command-level
    // code so the API surface is consistent.
    const transition = applyTransition({
      policy: ORDER_STANDARD_V1,
      currentState,
      command: "START_TYPING",
    });
    if (!transition.ok) {
      switch (transition.code) {
        case WORKFLOW_STATE_TERMINAL:
          throw new errors.ConflictError({
            code: TYPING_ORDER_TERMINAL,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_INVALID_TRANSITION:
          throw new errors.ConflictError({
            code: TYPING_INVALID_TRANSITION,
            message: transition.reason,
            metadata: { orderId: target.id, currentStatus: currentState },
          });
        case WORKFLOW_UNKNOWN_COMMAND:
          // Programmer error: the engine has no row for START_TYPING.
          // Means policy and command vocabulary fell out of sync —
          // not a runtime caller failure.
          throw new errors.InternalError({
            code: WORKFLOW_UNKNOWN_COMMAND,
            message: transition.reason,
          });
        default:
          // The remaining workflow codes (WORKFLOW_PARAM_*) do not
          // apply to START_TYPING. Anything that lands here is an
          // unforeseen engine outcome — fail loudly.
          throw new errors.InternalError({
            code: transition.code,
            message: transition.reason,
          });
      }
    }

    // The locked target carries siteId (lockOrderRow's projection
    // includes it). Bucket scope is per (organizationId, siteId, code);
    // the bucket code is the canonical one for the post-transition
    // state, so the lookup stays in sync with `CreateOrder` and every
    // future workflow command via the shared status→bucket map.
    const typingBucketCode = BUCKET_CODE_FOR_STATUS.TYPING_IN_PROGRESS;
    const typingBucket = await tx.bucket.findFirst({
      where: {
        organizationId: ctx.organizationId,
        siteId: target.siteId,
        code: typingBucketCode,
      },
      select: { id: true },
    });
    if (typingBucket === null) {
      throw new errors.InternalError({
        code: TYPING_BUCKET_NOT_CONFIGURED,
        message: `No ${typingBucketCode} bucket configured for this site.`,
        metadata: { siteId: target.siteId, expectedBucketCode: typingBucketCode },
      });
    }

    // Domain write: state, bucket, assignee. The version column is
    // intentionally NOT updated here — the factory's `bumpVersion`
    // step performs the CAS in a separate updateMany so a missed
    // increment surfaces as a stable ORDER_VERSION_MISMATCH instead
    // of a silent overwrite.
    await tx.order.update({
      where: { id: target.id },
      data: {
        currentStatus: OrderStatus.TYPING_IN_PROGRESS,
        currentBucketId: typingBucket.id,
        currentAssigneeUserId: ctx.actor.userId,
      },
    });

    const now = clock.now();

    await applyCommandStageIntervalTransition({
      commandName: "StartTyping",
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
        currentStatus: "TYPING_IN_PROGRESS" as const,
        version: target.version + 1,
        transitionId: transition.transitionId,
      },
      targetOrderId: target.id,
      bumpVersion: { from: target.version, to: target.version + 1 },
      audit: {
        action: "order.typing.started",
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
          bucketIdAfter: typingBucket.id,
          typistUserId: ctx.actor.userId,
          commandLogId,
        },
      },
      emits: [
        {
          eventType: "order.typing.started.v1",
          aggregateType: "Order",
          aggregateId: target.id,
          payload: {
            orderId: target.id,
            organizationId: ctx.organizationId,
            siteId: target.siteId,
            typistUserId: ctx.actor.userId,
            bucketId: typingBucket.id,
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

// Re-export the bus's CAS error code so callers of `@pharmax/verification`
// don't have to import `@pharmax/command-bus` just to handle a 409 from
// StartTyping. Keeps the package surface self-contained.
export { ORDER_VERSION_MISMATCH };
