// CreateBucket — admin "mint a custom operational queue".
//
// Why this command exists:
//   `ProvisionDefaultBuckets` seeds the seven canonical buckets every
//   org needs to run the primary workflow. Everything past that — a
//   COMPOUNDING_QUEUE, a PRIOR_AUTH hold, a CLINIC_CALLBACK exception
//   lane — is org-specific and has never had a writer. This is it.
//
// What a custom bucket IS:
//   A named queue an operator can move an order into by hand, count on
//   a dashboard, and filter a saved view by.
//
// What a custom bucket is NOT:
//   A workflow stage. The engine's stage->bucket routing is a static
//   map in `@pharmax/workflow` (`BUCKET_CODE_FOR_STATUS`), resolved by
//   CODE; nothing in it is data-driven, so creating a bucket cannot and
//   does not teach the engine a new stage. Custom buckets are operated
//   manually. That is a real product limitation, not an oversight of
//   this command — making stage routing per-tenant needs the workflow
//   overlay to grow a bucket dimension, which is its own slice.
//
// Guards, in the order they fire:
//   1. `code` shape (SCREAMING_SNAKE) — schema boundary.
//   2. `code` not reserved by the workflow engine / canonical set.
//   3. `kind` not one a platform subsystem selects on.
//   4. Any supplied site / clinic / team scope belongs to the actor's org.
//   5. `(organizationId, code)` uniqueness — P2002 mapped to a clean
//      domain conflict rather than a raw Prisma error.
//
// `isSystem` is NOT an input. It is hard-coded false: only
// ProvisionDefaultBuckets mints system buckets, and letting an admin
// self-declare one would hand them a row that DeleteBucket refuses to
// remove and UpdateBucket refuses to fully edit.
//
// Permission: `org.manage_buckets` (ORGANIZATION scope; OrgAdmin by
// default via ALL_PERMS).
//
// PHI: none. Bucket identifiers and scope ids only.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { BucketKind, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  BUCKET_CODE_REGEX,
  isReservedBucketCode,
  isReservedBucketKind,
} from "../buckets/bucket-guards.js";

export const CREATE_BUCKET_CODE_ALREADY_EXISTS = "CREATE_BUCKET_CODE_ALREADY_EXISTS";
export const CREATE_BUCKET_CODE_RESERVED = "CREATE_BUCKET_CODE_RESERVED";
export const CREATE_BUCKET_KIND_RESERVED = "CREATE_BUCKET_KIND_RESERVED";
export const CREATE_BUCKET_SITE_NOT_IN_ORG = "CREATE_BUCKET_SITE_NOT_IN_ORG";
export const CREATE_BUCKET_CLINIC_NOT_IN_ORG = "CREATE_BUCKET_CLINIC_NOT_IN_ORG";
export const CREATE_BUCKET_TEAM_NOT_IN_ORG = "CREATE_BUCKET_TEAM_NOT_IN_ORG";

const inputSchema = z
  .object({
    /** Org-unique queue identifier, SCREAMING_SNAKE (e.g. `PRIOR_AUTH`). */
    code: z
      .string()
      .trim()
      .regex(
        BUCKET_CODE_REGEX,
        "code must be SCREAMING_SNAKE: start with an uppercase letter, then uppercase letters, digits, or `_` (2-64 chars)"
      ),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(BucketKind),
    /**
     * Position on the queue rail. Canonical buckets are seeded at
     * 10/20/.../70, so a custom bucket lands between two defaults
     * without renumbering anything.
     */
    sortOrder: z.number().int().min(0).max(10_000).default(100),
    /** Optional narrowing scope. Omitted / null = visible org-wide. */
    siteId: z.uuid().nullish(),
    clinicId: z.uuid().nullish(),
    teamId: z.uuid().nullish(),
  })
  .strict();

export type CreateBucketInput = z.infer<typeof inputSchema>;

export interface CreateBucketOutput {
  readonly bucketId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: BucketKind;
  readonly sortOrder: number;
}

export const CreateBucket: Command<CreateBucketInput, CreateBucketOutput> = {
  name: "CreateBucket",
  inputSchema,
  permission: PERMISSIONS.ORG_MANAGE_BUCKETS,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<CreateBucketOutput>> {
    if (isReservedBucketCode(input.code)) {
      throw new errors.ValidationError({
        code: CREATE_BUCKET_CODE_RESERVED,
        message: `Bucket code "${input.code}" is reserved by the workflow engine. Orders are routed into it automatically on a stage transition; pick a different code.`,
        metadata: { code: input.code },
      });
    }

    if (isReservedBucketKind(input.kind)) {
      throw new errors.ValidationError({
        code: CREATE_BUCKET_KIND_RESERVED,
        message: `Bucket kind "${input.kind}" is reserved for buckets the platform provisions. Custom buckets may be CUSTOM, HOLD, or EXCEPTION.`,
        metadata: { kind: input.kind },
      });
    }

    // Scope narrowers are operator-supplied uuids. Each must be proven
    // to live in the actor's org before it is written — otherwise an
    // admin could pin their bucket to another tenant's site, and the
    // resulting row would leak that site id into every queue read.
    const siteId = input.siteId ?? null;
    if (siteId !== null) {
      const site = await tx.pharmacySite.findFirst({
        where: { id: siteId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (site === null) {
        throw new errors.ValidationError({
          code: CREATE_BUCKET_SITE_NOT_IN_ORG,
          message: "Pharmacy site not found in this organization.",
          metadata: { siteId },
        });
      }
    }

    const clinicId = input.clinicId ?? null;
    if (clinicId !== null) {
      const clinic = await tx.clinic.findFirst({
        where: { id: clinicId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (clinic === null) {
        throw new errors.ValidationError({
          code: CREATE_BUCKET_CLINIC_NOT_IN_ORG,
          message: "Clinic not found in this organization.",
          metadata: { clinicId },
        });
      }
    }

    const teamId = input.teamId ?? null;
    if (teamId !== null) {
      const team = await tx.team.findFirst({
        where: { id: teamId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (team === null) {
        throw new errors.ValidationError({
          code: CREATE_BUCKET_TEAM_NOT_IN_ORG,
          message: "Team not found in this organization.",
          metadata: { teamId },
        });
      }
    }

    let bucketId: string;
    try {
      const created = await tx.bucket.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          kind: input.kind,
          sortOrder: input.sortOrder,
          siteId,
          clinicId,
          teamId,
          isSystem: false,
        },
        select: { id: true },
      });
      bucketId = created.id;
    } catch (cause) {
      // `@@unique([organizationId, code])`. A resubmitted form must
      // read as a conflict the operator can act on, not a 500.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new errors.ConflictError({
          code: CREATE_BUCKET_CODE_ALREADY_EXISTS,
          message: `A bucket with code "${input.code}" already exists in this organization.`,
          metadata: { code: input.code },
          cause,
        });
      }
      throw cause;
    }

    const occurredAt = clock.now();

    return {
      output: Object.freeze({
        bucketId,
        code: input.code,
        name: input.name,
        kind: input.kind,
        sortOrder: input.sortOrder,
      }),
      audit: {
        action: "org.bucket.created",
        resourceType: "Bucket",
        resourceId: bucketId,
        metadata: {
          code: input.code,
          name: input.name,
          kind: input.kind,
          sortOrder: input.sortOrder,
          siteId,
          clinicId,
          teamId,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.bucket.created.v1",
          aggregateType: "Bucket",
          aggregateId: bucketId,
          payload: {
            organizationId: ctx.organizationId,
            bucketId,
            code: input.code,
            name: input.name,
            kind: input.kind,
            sortOrder: input.sortOrder,
            siteId,
            clinicId,
            teamId,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
