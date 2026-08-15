// DeleteBucket — admin "retire a custom queue".
//
// ---------------------------------------------------------------------
// Why this is a hard delete and not a soft archive
// ---------------------------------------------------------------------
//
// The `bucket` model has no `isActive` / `archivedAt` / `status` column,
// and adding one is a migration. The alternatives without a migration
// were all worse:
//
//   - Encode "archived" in `code` (prefix `ARCHIVED_`). Corrupts the
//     `@@unique([organizationId, code])` key's meaning, breaks the
//     reserved-code guard's assumptions, and leaves a row the workflow
//     engine's `findFirst({ code })` could still match on a near-miss.
//   - Encode it in `kind`. `kind` is already read as a selector by the
//     emergency SLA report; overloading it invents a second meaning for
//     a column that has one.
//   - Encode it in `sortOrder` (e.g. negative). Invisible, undiscoverable,
//     and a lie to every consumer that sorts by it.
//
// So: delete the row, and REFUSE the delete whenever any order still
// references it. That refusal is what makes the hard delete safe, and it
// is what most systems do — "move the orders out first" is a sentence an
// operator can act on, where "this bucket is archived but 40 orders are
// still in it" is a state nobody can reason about.
//
// The audit row and `org.bucket.deleted.v1` carry a full attribute
// snapshot, so the bucket's history survives the row.
//
// Three guards, all refusals:
//
//   1. `isSystem` — the seeded seven are load-bearing. The workflow
//      engine resolves them by code on every transition and the SLA
//      breach evaluator escalates into EMERGENCY. Deleting one does not
//      degrade the org, it stops it: the next transition throws
//      `<STAGE>_BUCKET_NOT_CONFIGURED` and intake halts.
//
//   2. Referencing orders — `Order.currentBucketId` is NON-NULLABLE with
//      `onDelete: Restrict`, so the database would refuse this anyway.
//      We check first so the operator gets `DELETE_BUCKET_HAS_ORDERS`
//      with a COUNT they can act on, instead of a raw P2003 foreign-key
//      violation surfaced as a 500. Belt and braces: if this check ever
//      races a concurrent order landing in the bucket, the FK still
//      holds the line inside the same transaction.
//
//   3. Referencing ROUTING OVERRIDES — an ACTIVE workflow policy overlay
//      that routes a workflow stage into this bucket. Unlike (2) there
//      is NO foreign key here and there cannot be one: the reference is
//      a bucket CODE inside `workflow_policy_overlay.overlayJson`, a
//      `Json` column. So guard (2) does not cover it, and an EMPTY
//      custom bucket — zero orders, refusal (2) silent — could be
//      deleted out from under a live route. See
//      `../buckets/bucket-route-references.ts` for why this refuses
//      rather than letting the route lapse, and for the runtime
//      fallback that keeps orders moving if a row disappears anyway.
//
// Permission: `org.manage_buckets` (ORGANIZATION scope).
//
// PHI: none. Bucket identifiers, an order COUNT (never order ids), and
// overlay/clinic ids.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import type { BucketKind } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  findActiveOverlaysRoutingToCode,
  referencedStateNames,
} from "../buckets/bucket-route-references.js";

export const DELETE_BUCKET_NOT_FOUND = "DELETE_BUCKET_NOT_FOUND";
export const DELETE_BUCKET_IS_SYSTEM = "DELETE_BUCKET_IS_SYSTEM";
export const DELETE_BUCKET_HAS_ORDERS = "DELETE_BUCKET_HAS_ORDERS";
export const DELETE_BUCKET_HAS_ROUTING_OVERRIDE = "DELETE_BUCKET_HAS_ROUTING_OVERRIDE";

const inputSchema = z
  .object({
    bucketId: z.uuid(),
  })
  .strict();

export type DeleteBucketInput = z.infer<typeof inputSchema>;

export interface DeleteBucketOutput {
  readonly bucketId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: BucketKind;
}

export const DeleteBucket: Command<DeleteBucketInput, DeleteBucketOutput> = {
  name: "DeleteBucket",
  inputSchema,
  permission: PERMISSIONS.ORG_MANAGE_BUCKETS,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<DeleteBucketOutput>> {
    const bucket = await tx.bucket.findFirst({
      where: { id: input.bucketId, organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, kind: true, isSystem: true },
    });
    if (bucket === null) {
      throw new errors.NotFoundError({
        code: DELETE_BUCKET_NOT_FOUND,
        message: "Bucket not found in this organization.",
        metadata: { bucketId: input.bucketId },
      });
    }

    if (bucket.isSystem) {
      throw new errors.ConflictError({
        code: DELETE_BUCKET_IS_SYSTEM,
        message: `Bucket "${bucket.code}" is a system bucket and cannot be deleted. The workflow engine routes orders into it by code on every stage transition.`,
        metadata: { bucketId: bucket.id, code: bucket.code },
      });
    }

    // Count, don't fetch: an order id set would be unbounded and would
    // put order identifiers into an error payload for no operator
    // benefit. The count is the actionable number.
    const orderCount = await tx.order.count({
      where: { organizationId: ctx.organizationId, currentBucketId: bucket.id },
    });
    if (orderCount > 0) {
      throw new errors.ConflictError({
        code: DELETE_BUCKET_HAS_ORDERS,
        message: `Bucket "${bucket.code}" still holds ${orderCount} order${orderCount === 1 ? "" : "s"}. Move them to another bucket before deleting it.`,
        metadata: { bucketId: bucket.id, code: bucket.code, orderCount },
      });
    }

    // Ordered AFTER the order-count check on purpose. A bucket that
    // holds orders AND carries a route needs the orders moved either
    // way, and "move the orders out" is the step the admin has to take
    // first; leading with the routing message would send them to the
    // overlay screen for a bucket they cannot delete yet regardless.
    const routeReferences = await findActiveOverlaysRoutingToCode(tx, {
      organizationId: ctx.organizationId,
      code: bucket.code,
    });
    if (routeReferences.length > 0) {
      const states = referencedStateNames(routeReferences);
      throw new errors.ConflictError({
        code: DELETE_BUCKET_HAS_ROUTING_OVERRIDE,
        message:
          `Bucket "${bucket.code}" is the routing target for ${states.join(", ")}. ` +
          `Re-point ${states.length === 1 ? "that stage" : "those stages"} in the workflow policy overlay before deleting it, ` +
          `or the stage silently falls back to its default bucket.`,
        metadata: {
          bucketId: bucket.id,
          code: bucket.code,
          routedStates: [...states],
          overlayIds: routeReferences.map((reference) => reference.overlayId),
        },
      });
    }

    await tx.bucket.delete({ where: { id: bucket.id } });

    const occurredAt = clock.now();

    return {
      output: Object.freeze({
        bucketId: bucket.id,
        code: bucket.code,
        name: bucket.name,
        kind: bucket.kind,
      }),
      audit: {
        action: "org.bucket.deleted",
        resourceType: "Bucket",
        resourceId: bucket.id,
        metadata: {
          code: bucket.code,
          name: bucket.name,
          kind: bucket.kind,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.bucket.deleted.v1",
          aggregateType: "Bucket",
          aggregateId: bucket.id,
          payload: {
            organizationId: ctx.organizationId,
            bucketId: bucket.id,
            code: bucket.code,
            name: bucket.name,
            kind: bucket.kind,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
