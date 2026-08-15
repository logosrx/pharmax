// UpdateBucket — admin "relabel / reorder a queue".
//
// ---------------------------------------------------------------------
// `code` is immutable on EVERY bucket, system or custom
// ---------------------------------------------------------------------
//
// It is not in `inputSchema`, and the schema is `.strict()`, so a
// request carrying one is rejected at the boundary before the handler
// runs.
//
//   - On a SYSTEM bucket, `code` is the routing key. `@pharmax/workflow`
//     maps each stage to a code and ~20 handlers resolve the row with
//     `findFirst({ where: { organizationId, siteId, code } })`. Rename
//     `TYPING` and every typing transition in the org throws
//     `<STAGE>_BUCKET_NOT_CONFIGURED` until someone renames it back.
//     This one is not close, and it is not up for revisiting.
//
//   - On a CUSTOM bucket the argument is much weaker, and it was
//     re-examined when per-tenant stage routing landed. Re-examining it
//     first corrected the record: the consumers this comment used to
//     cite — "saved views, dashboards, and scanner macros" — do not
//     exist. There is no `SavedView` model and no column anywhere in
//     `schema.prisma` that stores a bucket code. The only real risk the
//     old rationale named was collision into a reserved code, and that
//     is trivially guardable against `RESERVED_BUCKET_CODES` plus the
//     `@@unique([organizationId, code])` constraint.
//
// So why is it STILL refused? Two concrete blockers, neither of which
// is about the merit of the feature:
//
//   1. The `org.bucket.updated.v1` payload pins
//      `fieldsChanged: z.array(z.enum(["name", "sortOrder", "kind"]))`
//      inside a `.strict()` schema, and the event's own description
//      states "The bucket code is immutable and never appears in
//      fieldsChanged". Emitting a rename means widening a registered,
//      versioned, 7-year-retention event contract — a change to the
//      event vocabulary, not to this command.
//
//   2. Since per-tenant routing landed, a rename strands a routing
//      override exactly the way a DELETE does: overrides name a bucket
//      by CODE (`bucket-routing.ts` explains why that is the right
//      key), so renaming `TYPING_REWORK` silently drops every stage
//      routed there back to its canonical bucket. This is now the
//      strongest "stable handle" argument, and it is the one the old
//      comment was reaching for without having a real referent.
//
// Unblocking it is a small, well-defined follow-up, in this order:
// widen `fieldsChanged` to include "code" in the event contract; add a
// `code` field to `inputSchema` accepted only when `isSystem` is false;
// guard it with `BUCKET_CODE_REGEX`, `isReservedBucketCode`, a P2002
// catch for the unique constraint, and a
// `findActiveOverlaysRoutingToCode` refusal on the OLD code — the same
// refusal `DeleteBucket` now carries, for the same reason. Every piece
// except the event change already exists in this package.
//
// What an admin MAY change, by bucket type:
//
//   system  →  name, sortOrder                (display plane only)
//   custom  →  name, sortOrder, kind          (kind, minus reserved kinds)
//
// `kind` is control-plane on a system bucket: the emergency SLA report
// selects buckets purely by `kind: EMERGENCY`, so clearing it off the
// seeded EMERGENCY bucket silently zeroes the report ops watches during
// a breach. `name` and `sortOrder` are selected on by nothing, which is
// why they are safe to open up even on the seeded seven.
//
// Idempotent by construction: the handler diffs against the current row
// and reports `fieldsChanged`. Re-submitting an unchanged form is a
// successful no-op write with an empty diff, not a conflict.
//
// Permission: `org.manage_buckets` (ORGANIZATION scope).
//
// PHI: none. Bucket identifiers and attribute names only.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { BucketKind } from "@pharmax/database";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { isReservedBucketKind, SYSTEM_BUCKET_MUTABLE_FIELDS } from "../buckets/bucket-guards.js";

export const UPDATE_BUCKET_NOT_FOUND = "UPDATE_BUCKET_NOT_FOUND";
export const UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE = "UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE";
export const UPDATE_BUCKET_KIND_RESERVED = "UPDATE_BUCKET_KIND_RESERVED";

const inputSchema = z
  .object({
    bucketId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    sortOrder: z.number().int().min(0).max(10_000),
    /**
     * Optional. Omit to leave the kind alone — which is what the admin
     * form does for system buckets, where the field is not rendered.
     * Supplying the CURRENT kind is always accepted (a form that echoes
     * back what it was shown must not fail); supplying a DIFFERENT kind
     * on a system bucket is refused.
     */
    kind: z.enum(BucketKind).optional(),
  })
  .strict();

export type UpdateBucketInput = z.infer<typeof inputSchema>;

/** The attributes `UpdateBucket` is capable of changing. */
export type UpdateBucketField = "name" | "sortOrder" | "kind";

export interface UpdateBucketOutput {
  readonly bucketId: string;
  readonly code: string;
  readonly isSystem: boolean;
  readonly fieldsChanged: ReadonlyArray<UpdateBucketField>;
}

export const UpdateBucket: Command<UpdateBucketInput, UpdateBucketOutput> = {
  name: "UpdateBucket",
  inputSchema,
  permission: PERMISSIONS.ORG_MANAGE_BUCKETS,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<UpdateBucketOutput>> {
    // Org-scoped read. `findFirst` with the org predicate rather than
    // `findUnique` by id: a bare id lookup would let an operator who
    // guessed another tenant's bucket uuid confirm its existence, and
    // then edit it.
    const bucket = await tx.bucket.findFirst({
      where: { id: input.bucketId, organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, kind: true, sortOrder: true, isSystem: true },
    });
    if (bucket === null) {
      throw new errors.NotFoundError({
        code: UPDATE_BUCKET_NOT_FOUND,
        message: "Bucket not found in this organization.",
        metadata: { bucketId: input.bucketId },
      });
    }

    const kindChanging = input.kind !== undefined && input.kind !== bucket.kind;

    if (bucket.isSystem && kindChanging) {
      throw new errors.ConflictError({
        code: UPDATE_BUCKET_SYSTEM_FIELD_IMMUTABLE,
        message: `Bucket "${bucket.code}" is a system bucket; only ${SYSTEM_BUCKET_MUTABLE_FIELDS.join(" and ")} may be changed. Its kind drives emergency SLA reporting and stays fixed.`,
        metadata: {
          bucketId: bucket.id,
          code: bucket.code,
          field: "kind",
          mutableFields: [...SYSTEM_BUCKET_MUTABLE_FIELDS],
        },
      });
    }

    // Reserved kinds stay off custom buckets even when the actor is an
    // OrgAdmin: this is a data-integrity rule, not a privilege one.
    if (kindChanging && input.kind !== undefined && isReservedBucketKind(input.kind)) {
      throw new errors.ValidationError({
        code: UPDATE_BUCKET_KIND_RESERVED,
        message: `Bucket kind "${input.kind}" is reserved for buckets the platform provisions. Custom buckets may be CUSTOM, HOLD, or EXCEPTION.`,
        metadata: { bucketId: bucket.id, kind: input.kind },
      });
    }

    const fieldsChanged: UpdateBucketField[] = [];
    if (bucket.name !== input.name) fieldsChanged.push("name");
    if (bucket.sortOrder !== input.sortOrder) fieldsChanged.push("sortOrder");
    if (kindChanging) fieldsChanged.push("kind");

    const nextKind = kindChanging && input.kind !== undefined ? input.kind : bucket.kind;

    await tx.bucket.update({
      where: { id: bucket.id },
      data: {
        name: input.name,
        sortOrder: input.sortOrder,
        kind: nextKind,
      },
    });

    const occurredAt = clock.now();

    return {
      output: Object.freeze({
        bucketId: bucket.id,
        code: bucket.code,
        isSystem: bucket.isSystem,
        fieldsChanged: Object.freeze([...fieldsChanged]),
      }),
      audit: {
        action: "org.bucket.updated",
        resourceType: "Bucket",
        resourceId: bucket.id,
        metadata: {
          code: bucket.code,
          name: input.name,
          kind: nextKind,
          sortOrder: input.sortOrder,
          isSystem: bucket.isSystem,
          fieldsChanged: fieldsChanged satisfies Prisma.InputJsonValue,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.bucket.updated.v1",
          aggregateType: "Bucket",
          aggregateId: bucket.id,
          payload: {
            organizationId: ctx.organizationId,
            bucketId: bucket.id,
            code: bucket.code,
            name: input.name,
            kind: nextKind,
            sortOrder: input.sortOrder,
            isSystem: bucket.isSystem,
            fieldsChanged: fieldsChanged satisfies Prisma.InputJsonValue,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
