// RecordAccessReviewSnapshot — tenant command that freezes an
// AccessReviewReport into an immutable, digest-sealed
// `access_review_snapshot` row for SOC 2 CC6.2 evidence.
//
// Why a tenant command (NOT a SystemCommand):
//   - The snapshot row carries a NOT NULL FK to `command_log`. The
//     tenant executor writes `command_log` PRE-transaction, so the
//     handler can immediately insert a row that references it. The
//     system executor writes `command_log` mid-tx AFTER the handler
//     returns — there's no row yet for the handler to point a FK at.
//   - Snapshots are per-organization evidence. The operator who
//     produces evidence (security officer at the quarterly review,
//     future scheduled-worker service user) belongs to that org;
//     running under that operator's tenancy context is exactly the
//     security model SOC 2 expects.
//   - Tenant-scoped RLS naturally gates reads of the resulting row.
//
// What this command guarantees:
//   1. The persisted `report` JSONB is exactly what the caller
//      passed in — never re-shaped, never re-keyed, never enriched.
//      Canonical JSON serialization of `report` SHA-256s to
//      `digestSha256` on the same row.
//   2. Cross-tenant rejection: the operator's tenancy `ctx.organizationId`
//      MUST equal both `input.organizationId` and `input.report.organizationId`.
//      Mismatch surfaces as `errors.ForbiddenError` BEFORE any DB write.
//   3. The snapshot id is generated server-side (UUID v4 via Node's
//      Web Crypto). Callers receive it on the result so they can
//      cross-reference local JSON copies to the persisted row.
//
// PHI invariant: the report passed in contains operator identity
// (email, displayName) but NEVER patient data — enforced by
// `generateAccessReview` upstream. This command treats the report
// as opaque JSON for hashing and persistence; it does not parse the
// principals array or surface any per-principal field into audit /
// outbox payloads beyond the summary scalars.

import { createHash, randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// `input.report` is deliberately validated structurally (top-level
// keys + summary scalars) rather than re-parsed from scratch.
// `generateAccessReview` is the single producer and its TypeScript
// return type is the source of truth; re-encoding the full Zod
// schema here would create two registries to keep in sync. The
// structural checks below catch obvious shape regressions without
// duplicating type information.

const summarySchema = z
  .object({
    totalPrincipals: z.int().min(0),
    principalsWithElevatedRoles: z.array(z.string()).readonly(),
    inactivePrincipals: z.array(z.string()).readonly(),
    staleAssignments: z
      .array(
        z
          .object({
            userId: z.string(),
            userRoleId: z.string(),
            roleCode: z.string(),
            ageDays: z.int(),
          })
          .passthrough()
      )
      .readonly(),
    cryptoShredCapableRoles: z.array(z.string()).readonly(),
  })
  .passthrough();

const reportSchema = z
  .object({
    organizationId: z.uuid(),
    organizationSlug: z.string().min(1).max(200),
    generatedAt: z.iso.datetime({ offset: true }),
    period: z
      .object({
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
      })
      .passthrough(),
    principals: z.array(z.unknown()).readonly(),
    summary: summarySchema,
  })
  .passthrough();

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    report: reportSchema,
    /** Schema version of the persisted `report` JSONB. Default 1. */
    reportVersion: z.int().min(1).max(255).default(1),
  })
  .strict();

/**
 * Parsed input shape (post-Zod, defaults applied). Callers building
 * an input object can use the raw shape `z.input<typeof inputSchema>`
 * directly — `reportVersion` is optional on the wire and defaults to 1.
 */
export type RecordAccessReviewSnapshotInput = z.infer<typeof inputSchema>;

export interface RecordAccessReviewSnapshotOutput {
  readonly snapshotId: string;
  readonly digestSha256: string;
  readonly organizationId: string;
  readonly generatedAt: string;
  readonly reportVersion: number;
  readonly totalPrincipals: number;
  readonly elevatedPrincipalCount: number;
  readonly inactivePrincipalCount: number;
  readonly staleAssignmentCount: number;
  readonly cryptoShredCapableRoleCount: number;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ACCESS_REVIEW_REPORT_ORG_MISMATCH = "ACCESS_REVIEW_REPORT_ORG_MISMATCH";
export const ACCESS_REVIEW_TENANCY_MISMATCH = "ACCESS_REVIEW_TENANCY_MISMATCH";

// ---------------------------------------------------------------------------
// Canonical JSON + SHA-256 digest
// ---------------------------------------------------------------------------
//
// Canonical = recursively sort object keys, then JSON.stringify with
// default formatting (no spaces). This matches the semantics in
// `@pharmax/command-bus/hash.ts` and `@pharmax/audit/chain/encoder.ts`;
// kept as a local helper to avoid a hard dep on the bus's hash module.
//
// IMPORTANT: arrays are preserved in declared order. Reordering an
// array would change the persisted JSON shape AND the digest, which
// is the right semantics: array order is part of the canonical
// content, not metadata.

function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown): unknown => {
    if (val === null || val === undefined) return val;
    if (typeof val !== "object" || Array.isArray(val)) return val;
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

export function computeAccessReviewDigest(report: unknown): string {
  return createHash("sha256").update(canonicalStringify(report)).digest("hex");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const RecordAccessReviewSnapshot: Command<
  RecordAccessReviewSnapshotInput,
  RecordAccessReviewSnapshotOutput
> = {
  name: "RecordAccessReviewSnapshot",
  inputSchema,
  permission: PERMISSIONS.COMPLIANCE_ACCESS_REVIEW_RECORD,
  // The report is non-PHI by construction (`generateAccessReview`
  // returns operator identity only). Redacting nothing here keeps
  // the audit chain inspectable for SOC 2 reviewers; should the
  // report ever embed PHI (future expansion), this list MUST be
  // updated to redact the relevant subtree.
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RecordAccessReviewSnapshotOutput>> {
    // The bus has already validated `input` via `inputSchema.safeParse`
    // and passed the PARSED data here. `reportVersion` is the defaulted
    // value (1 if the caller omitted it).
    const parsed = input;

    // Cross-tenant rejection. RLS on `access_review_snapshot` would
    // surface a write to another org as a NOT NULL or row-policy
    // failure deep in the stack; rejecting up-front gives the
    // operator a precise error and avoids burning a `command_log`
    // RUNNING row on a malformed request.
    if (parsed.organizationId !== ctx.organizationId) {
      throw new errors.AuthorizationError({
        code: ACCESS_REVIEW_TENANCY_MISMATCH,
        message:
          "RecordAccessReviewSnapshot: input.organizationId does not match the operator's tenancy.",
        metadata: {
          inputOrganizationId: parsed.organizationId,
          actorOrganizationId: ctx.organizationId,
        },
      });
    }
    if (parsed.report.organizationId !== parsed.organizationId) {
      throw new errors.ValidationError({
        code: ACCESS_REVIEW_REPORT_ORG_MISMATCH,
        message:
          "RecordAccessReviewSnapshot: report.organizationId does not match input.organizationId; refusing to persist mismatched evidence.",
        metadata: {
          inputOrganizationId: parsed.organizationId,
          reportOrganizationId: parsed.report.organizationId,
        },
      });
    }

    const snapshotId = randomUUID();
    const digestSha256 = computeAccessReviewDigest(parsed.report);
    const now = clock.now();
    const summary = parsed.report.summary;

    const totalPrincipals = summary.totalPrincipals;
    const elevatedPrincipalCount = summary.principalsWithElevatedRoles.length;
    const inactivePrincipalCount = summary.inactivePrincipals.length;
    const staleAssignmentCount = summary.staleAssignments.length;
    const cryptoShredCapableRoleCount = summary.cryptoShredCapableRoles.length;

    await tx.accessReviewSnapshot.create({
      data: {
        id: snapshotId,
        organizationId: parsed.organizationId,
        organizationSlug: parsed.report.organizationSlug,
        periodStart: new Date(parsed.report.period.start),
        periodEnd: new Date(parsed.report.period.end),
        generatedAt: new Date(parsed.report.generatedAt),
        totalPrincipals,
        elevatedPrincipalCount,
        inactivePrincipalCount,
        staleAssignmentCount,
        cryptoShredCapableRoleCount,
        report: parsed.report as unknown as Prisma.InputJsonValue,
        digestSha256,
        reportVersion: parsed.reportVersion,
        recordedByUserId: ctx.actor.userId,
        commandLogId,
      },
    });

    const output: RecordAccessReviewSnapshotOutput = {
      snapshotId,
      digestSha256,
      organizationId: parsed.organizationId,
      generatedAt: parsed.report.generatedAt,
      reportVersion: parsed.reportVersion,
      totalPrincipals,
      elevatedPrincipalCount,
      inactivePrincipalCount,
      staleAssignmentCount,
      cryptoShredCapableRoleCount,
    };

    return {
      output,
      audit: {
        action: "compliance.access_review_snapshot.recorded",
        resourceType: "AccessReviewSnapshot",
        resourceId: snapshotId,
        metadata: {
          commandLogId,
          digestSha256,
          reportVersion: parsed.reportVersion,
          periodStart: parsed.report.period.start,
          periodEnd: parsed.report.period.end,
          generatedAt: parsed.report.generatedAt,
          totalPrincipals,
          elevatedPrincipalCount,
          inactivePrincipalCount,
          staleAssignmentCount,
          cryptoShredCapableRoleCount,
        },
      },
      outboxEvents: [
        {
          eventType: "compliance.access_review_snapshot.recorded.v1",
          aggregateType: "AccessReviewSnapshot",
          aggregateId: snapshotId,
          payload: {
            snapshotId,
            organizationId: parsed.organizationId,
            organizationSlug: parsed.report.organizationSlug,
            periodStart: parsed.report.period.start,
            periodEnd: parsed.report.period.end,
            generatedAt: parsed.report.generatedAt,
            reportVersion: parsed.reportVersion,
            totalPrincipals,
            elevatedPrincipalCount,
            inactivePrincipalCount,
            staleAssignmentCount,
            cryptoShredCapableRoleCount,
            digestSha256,
            recordedByUserId: ctx.actor.userId,
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
