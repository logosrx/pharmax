// ProvisionDefaultBuckets — per-site queue bucket bootstrap.
//
// Why this command exists:
//   Every workflow transition resolves the next-stage bucket by
//   code (see `@pharmax/workflow/status-bucket-map.ts`):
//
//     RECEIVED                                  → INBOX
//     TYPING_IN_PROGRESS                        → TYPING
//     TYPED_READY_FOR_PV1, PV1_IN_PROGRESS      → PV1
//     PV1_APPROVED_READY_FOR_FILL,
//     FILL_IN_PROGRESS                          → FILL
//     FILL_COMPLETED_READY_FOR_FINAL,
//     FINAL_VERIFICATION_IN_PROGRESS            → FINAL
//     READY_TO_SHIP, SHIPPED                    → SHIPPING
//     PV1_REJECTED                              → TYPING (rework)
//
//   If those bucket rows do not exist for the org, EVERY workflow
//   command from CreateOrder onwards fails with a
//   `<STAGE>_BUCKET_NOT_CONFIGURED` error. The demo seed
//   (`prisma/seed.ts`) creates them for the DEMO org; production
//   orgs bootstrapped via `scripts/bootstrap-org.ts` do not get
//   them until this command runs.
//
// What this command does:
//   For one (organizationId, siteId), upsert the canonical
//   per-stage bucket rows. Idempotent — running it twice produces
//   the same final state. Safe to invoke as part of bootstrap AND
//   as an admin backfill for existing orgs that were created
//   before this command existed.
//
// Why a SystemCommand:
//   - During org bootstrap, no admin user exists yet to check
//     RBAC against.
//   - During backfill, the operator is running it as system
//     anyway (no PHI involved; tenancy is established by the
//     caller).
//   The system-context reason is captured into `audit_log`
//   metadata for traceability.
//
// What this command does NOT do:
//   - Create custom org-specific buckets (handled by the admin
//     UI / a future `CreateBucket` command).
//   - Re-shape bucket codes (uniqueness is `[organizationId, code]`
//     today; multi-site orgs needing per-site bucket codes is a
//     separate schema slice).

import type { PrismaTxClient, SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

const inputSchema = z
  .object({
    organizationId: z.uuid(),
    siteId: z.uuid(),
  })
  .strict();

export type ProvisionDefaultBucketsInput = z.infer<typeof inputSchema>;

export interface ProvisionDefaultBucketsOutput {
  /** Map of bucket code → bucket id, for every code in the canonical set. */
  readonly bucketIdsByCode: Readonly<Record<DefaultBucketCode, string>>;
  /** How many bucket rows were newly created (vs. already-present). */
  readonly created: number;
  /** How many bucket rows were already present and left untouched. */
  readonly alreadyPresent: number;
}

/**
 * The canonical bucket set. Order in this array determines the
 * `sortOrder` column (multiplied by 10 so an org admin can later
 * insert custom buckets between defaults without renumbering).
 *
 * Keep this aligned with `BUCKET_CODE_FOR_STATUS` /
 * `BUCKET_CODE_FOR_EXCEPTION_STATE` in `@pharmax/workflow`. The
 * status-to-bucket map is the source of truth; this list mirrors
 * it for the per-site provisioning side. A regression test
 * (below in `provision-default-buckets.test.ts`) asserts every
 * code referenced by the workflow map exists here.
 */
const CANONICAL_BUCKETS = [
  { code: "INBOX", name: "Inbox", kind: "WORKFLOW" as const },
  { code: "TYPING", name: "Typing", kind: "WORKFLOW" as const },
  { code: "PV1", name: "PV1", kind: "WORKFLOW" as const },
  { code: "FILL", name: "Fill", kind: "WORKFLOW" as const },
  { code: "FINAL", name: "Final Verification", kind: "WORKFLOW" as const },
  { code: "SHIPPING", name: "Shipping", kind: "WORKFLOW" as const },
  { code: "EMERGENCY", name: "Emergency", kind: "EMERGENCY" as const },
] as const;

export type DefaultBucketCode = (typeof CANONICAL_BUCKETS)[number]["code"];

/**
 * Set of canonical bucket codes — exported so other commands /
 * tests can assert "the workflow expects this code to exist."
 */
export const DEFAULT_BUCKET_CODES: ReadonlySet<DefaultBucketCode> = new Set(
  CANONICAL_BUCKETS.map((b) => b.code)
);

/**
 * Reusable, transaction-scoped helper that performs the actual
 * bucket upserts. Extracted from the bus command so:
 *
 *   - The `ProvisionDefaultBuckets` SystemCommand can call it
 *     (the operator entry point, used during backfill).
 *
 *   - `CreateOrganization` can call it for its initialSite path
 *     without nesting `executeSystemCommand` calls (nesting opens
 *     a second transaction, breaks audit-chain atomicity, and
 *     deadlocks against `audit_chain_state`).
 *
 * Both call sites share the same SQL surface — same `bucket`
 * inserts, same `pharmacy_site` validation, same `sortOrder`
 * stepping — so the on-disk shape is identical no matter how the
 * buckets were provisioned. That uniformity is what makes the
 * "fail loud if a workflow stage's bucket is missing" invariant
 * tractable: there is exactly one writer.
 *
 * NOT exported as part of the public package surface — callers
 * should always go through either `ProvisionDefaultBuckets` (the
 * bus command, which gets idempotency, audit, outbox for free) or
 * `CreateOrganization` (which threads bucket provisioning into
 * the org-create audit row). Anyone else wanting buckets is a
 * sign of an architectural smell.
 */
export async function provisionDefaultBucketsForSite(
  tx: PrismaTxClient,
  input: { organizationId: string; siteId: string }
): Promise<ProvisionDefaultBucketsOutput> {
  // Verify the site belongs to the org. Cross-org wiring would
  // be a system-context bug that would silently misroute every
  // future order; fail loudly here.
  const site = await tx.pharmacySite.findUnique({
    where: { id: input.siteId },
    select: { id: true, organizationId: true },
  });
  if (site === null) {
    throw new errors.NotFoundError({
      code: "PROVISION_BUCKETS_SITE_NOT_FOUND",
      message: `Site "${input.siteId}" not found.`,
      metadata: { siteId: input.siteId, organizationId: input.organizationId },
    });
  }
  if (site.organizationId !== input.organizationId) {
    throw new errors.ValidationError({
      code: "PROVISION_BUCKETS_SITE_ORG_MISMATCH",
      message: `Site "${input.siteId}" does not belong to organization "${input.organizationId}".`,
      metadata: { siteId: input.siteId, organizationId: input.organizationId },
    });
  }

  // For each canonical bucket, look up by `(organizationId, code)`
  // (the live unique constraint) and create only the missing rows.
  const bucketIdsByCode: Partial<Record<DefaultBucketCode, string>> = {};
  let created = 0;
  let alreadyPresent = 0;

  for (let i = 0; i < CANONICAL_BUCKETS.length; i++) {
    const def = CANONICAL_BUCKETS[i];
    if (def === undefined) continue;
    const existing = await tx.bucket.findUnique({
      where: {
        organizationId_code: {
          organizationId: input.organizationId,
          code: def.code,
        },
      },
      select: { id: true, siteId: true },
    });

    if (existing !== null) {
      bucketIdsByCode[def.code] = existing.id;
      alreadyPresent += 1;
      // If an existing bucket is attached to a DIFFERENT site
      // than the one we're provisioning for, that's a multi-site
      // situation the current schema constraint doesn't model
      // cleanly. The follow-up migration that switches the
      // unique constraint to `(organizationId, siteId, code)`
      // will make this a real per-site bucket; until then,
      // single-site orgs are first-class and multi-site is a
      // documented limitation. We don't mutate the existing row.
      continue;
    }

    const inserted = await tx.bucket.create({
      data: {
        organizationId: input.organizationId,
        siteId: input.siteId,
        code: def.code,
        name: def.name,
        kind: def.kind,
        sortOrder: (i + 1) * 10,
        isSystem: true,
      },
      select: { id: true },
    });
    bucketIdsByCode[def.code] = inserted.id;
    created += 1;
  }

  // Should never trip — but fail loud rather than return a
  // partial map. A missing code here means the workflow engine
  // would resolve a bucketCodeForStatus -> non-existent row,
  // and the next order command would explode with a
  // foreign-key violation. That's a P0 incident shape; catch
  // it at provisioning time.
  for (const def of CANONICAL_BUCKETS) {
    if (bucketIdsByCode[def.code] === undefined) {
      throw new errors.InternalError({
        code: "PROVISION_BUCKETS_INCOMPLETE",
        message: `ProvisionDefaultBuckets did not produce an id for canonical bucket "${def.code}".`,
        metadata: { code: def.code },
      });
    }
  }

  return {
    bucketIdsByCode: bucketIdsByCode as Readonly<Record<DefaultBucketCode, string>>,
    created,
    alreadyPresent,
  };
}

export const ProvisionDefaultBuckets: SystemCommand<
  ProvisionDefaultBucketsInput,
  ProvisionDefaultBucketsOutput
> = {
  name: "ProvisionDefaultBuckets",
  inputSchema,

  async handle({
    input,
    tx,
    clock,
    commandLogId,
  }): Promise<SystemHandlerResult<ProvisionDefaultBucketsOutput>> {
    const result = await provisionDefaultBucketsForSite(tx, input);
    const occurredAt = clock.now();
    return {
      output: result,
      targetOrganizationId: input.organizationId,
      audit: {
        action: "org.buckets.provisioned",
        resourceType: "PharmacySite",
        resourceId: input.siteId,
        metadata: {
          siteId: input.siteId,
          organizationId: input.organizationId,
          created: result.created,
          alreadyPresent: result.alreadyPresent,
          commandLogId,
          occurredAt: occurredAt.toISOString(),
        },
      },
      outboxEvents: [
        {
          eventType: "org.buckets.provisioned.v1",
          aggregateType: "PharmacySite",
          aggregateId: input.siteId,
          payload: {
            organizationId: input.organizationId,
            siteId: input.siteId,
            created: result.created,
            alreadyPresent: result.alreadyPresent,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
