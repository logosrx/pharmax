// CreateOrganization — the first end-to-end command.
//
// Why this is a SYSTEM command:
//   - When the org doesn't exist yet, there are no users, no roles,
//     and no UserRole grants to check RBAC against. Tenant rules
//     don't apply because there is no tenant.
//   - Runs from an ops-driven CLI or supervisor process inside
//     `withSystemContext("bootstrap:CreateOrganization")`. The
//     system-context reason is captured into `audit_log.metadata`.
//
// What this handler does, atomically inside the bus's tx:
//   1. Insert Organization (relies on unique slug — duplicate slug
//      surfaces as ConflictError via P2002 mapping).
//   2. For each of the 6 system role templates, insert a Role row
//      and the matching RolePermission rows (one per permission
//      the template grants).
//   3. Insert the initial admin User (INVITED status; password is
//      set by the future accept-invite flow).
//   4. Insert the OrgAdmin UserRole grant (org-wide, all scope
//      columns null).
//   5. Insert the v1 `order.standard` WorkflowPolicy stub. The
//      transition graph and SLA defaults will be authored when
//      `@pharmax/workflow` lands; the row exists now so subsequent
//      verification records can carry workflowPolicyId + version.
//
// The bus then writes (in the same tx):
//   - command_log (RUNNING; flipped to SUCCEEDED post-tx)
//   - audit_log entry with action "organization.created"
//   - event_outbox row `organization.created.v1`
//
// PHI rule: NO PHI in inputs (this is an org-creation command). We
// still apply the bus's redaction allowlist to `password`-shaped
// fields as defense in depth — there are none on this input today.

import { errors } from "@pharmax/platform-core";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import {
  OrganizationStatus,
  Prisma,
  SiteStatus,
  UserStatus,
  WorkflowPolicyStatus,
} from "@pharmax/database";
import { ROLE_TEMPLATES } from "@pharmax/rbac";
import { z } from "zod";

import {
  DEFAULT_BUCKET_CODES,
  provisionDefaultBucketsForSite,
  type DefaultBucketCode,
} from "./provision-default-buckets.js";

const inputSchema = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      // Lowercase letters, numbers, hyphens. No leading/trailing hyphen.
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    name: z.string().min(2).max(200),
    initialAdmin: z.object({
      email: z.email().max(320),
      displayName: z.string().min(1).max(200),
    }),
    /**
     * Optional first pharmacy site to create alongside the org.
     *
     * Why optional, not required:
     *   Multi-site orgs may want to wire sites up explicitly via
     *   a future `CreateSite` command (e.g. a chain pharmacy
     *   ramping locations one at a time). Single-site orgs — the
     *   overwhelming majority of pharmacies we'll see — get a
     *   fully-bootstrapped, order-ready tenant in one command.
     *
     * When provided:
     *   - PharmacySite row is inserted with status=ACTIVE.
     *   - The 7 canonical workflow buckets (INBOX, TYPING, PV1,
     *     FILL, FINAL, SHIPPING, EMERGENCY) are provisioned for
     *     that site in the same tx — so the very first CreateOrder
     *     call can resolve `bucketCodeForStatus(RECEIVED) → INBOX`
     *     to a real row.
     *   - An additional outbox event `org.buckets.provisioned.v1`
     *     fires alongside `organization.created.v1`.
     */
    initialSite: z
      .object({
        code: z
          .string()
          .min(2)
          .max(32)
          .regex(/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/),
        name: z.string().min(2).max(200),
        timezone: z.string().min(3).max(64).optional(),
      })
      .optional(),
  })
  .strict();

export type CreateOrganizationInput = z.infer<typeof inputSchema>;

export interface CreateOrganizationOutput {
  readonly organizationId: string;
  readonly adminUserId: string;
  readonly roleCount: number;
  /** Site id of the initial site, if `initialSite` was provided. */
  readonly initialSiteId?: string;
  /** Bucket-code → bucket-id map for the initial site, if provisioned. */
  readonly initialBucketIdsByCode?: Readonly<Record<DefaultBucketCode, string>>;
}

export const CreateOrganization: SystemCommand<CreateOrganizationInput, CreateOrganizationOutput> =
  {
    name: "CreateOrganization",
    inputSchema,

    async handle({
      input,
      tx,
      commandLogId,
      clock,
    }): Promise<SystemHandlerResult<CreateOrganizationOutput>> {
      const now = clock.now();

      // Step 1 — Organization (slug-unique).
      let organizationId: string;
      try {
        const org = await tx.organization.create({
          data: {
            slug: input.slug,
            name: input.name,
            status: OrganizationStatus.ACTIVE,
          },
        });
        organizationId = org.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new errors.ConflictError({
            code: "ORG_SLUG_TAKEN",
            message: `An organization with slug "${input.slug}" already exists.`,
            metadata: { slug: input.slug },
          });
        }
        throw err;
      }

      // Step 2 — System role templates → Role + RolePermission rows.
      // Pre-fetch system permissions (immutable; seeded once at
      // platform install). We look them up by code rather than
      // assuming a stable id.
      const permissions = await tx.permission.findMany();
      const permissionIdByCode = new Map(permissions.map((p) => [p.code, p.id]));

      let roleCount = 0;
      let adminRoleId: string | null = null;
      for (const tmpl of ROLE_TEMPLATES) {
        const role = await tx.role.create({
          data: {
            organizationId,
            code: tmpl.code,
            name: tmpl.name,
            description: tmpl.description,
            scope: tmpl.scope,
            isSystem: true,
          },
        });
        roleCount += 1;
        if (tmpl.code === "OrgAdmin") {
          adminRoleId = role.id;
        }

        // Map the template's permission codes to the registry's
        // ids. Missing rows mean the seed didn't run (or the
        // platform installed a newer template referencing an
        // unknown permission). Fail loudly — it's a config error.
        const missing: string[] = [];
        const grants: Array<{ roleId: string; permissionId: string }> = [];
        for (const code of tmpl.permissions) {
          const permId = permissionIdByCode.get(code);
          if (permId === undefined) {
            missing.push(code);
          } else {
            grants.push({ roleId: role.id, permissionId: permId });
          }
        }
        if (missing.length > 0) {
          throw new errors.InternalError({
            code: "ORG_BOOTSTRAP_MISSING_PERMISSIONS",
            message:
              "Cannot bootstrap organization: required permission rows are missing from the system registry.",
            metadata: { missing, roleCode: tmpl.code },
          });
        }
        if (grants.length > 0) {
          await tx.rolePermission.createMany({ data: grants });
        }
      }

      if (adminRoleId === null) {
        // Should be unreachable: ROLE_TEMPLATES contains OrgAdmin.
        throw new errors.InternalError({
          code: "ORG_BOOTSTRAP_NO_ADMIN_ROLE",
          message: "Internal: OrgAdmin role template missing from registry.",
        });
      }

      // Step 3 — Initial admin user (INVITED; no password until
      // accept-invite lands).
      const user = await tx.user.create({
        data: {
          organizationId,
          email: input.initialAdmin.email,
          displayName: input.initialAdmin.displayName,
          status: UserStatus.INVITED,
        },
      });

      // Step 4 — OrgAdmin UserRole grant (org-wide; site/clinic/team all null).
      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: adminRoleId,
          organizationId,
        },
      });

      // Step 5 — v1 workflow policy stub.
      await tx.workflowPolicy.create({
        data: {
          organizationId,
          code: "order.standard",
          version: 1,
          status: WorkflowPolicyStatus.ACTIVE,
          description: "Default order workflow (Phase 1 stub).",
          definition: {
            states: [
              "RECEIVED",
              "TYPING_IN_PROGRESS",
              "TYPED_READY_FOR_PV1",
              "PV1_IN_PROGRESS",
              "PV1_APPROVED_READY_FOR_FILL",
              "FILL_IN_PROGRESS",
              "FILL_COMPLETED_READY_FOR_FINAL",
              "FINAL_VERIFICATION_IN_PROGRESS",
              "FINAL_VERIFICATION_APPROVED_READY_FOR_SHIP",
              "READY_TO_SHIP",
              "SHIPPED",
            ],
            transitions: [],
          } as Prisma.InputJsonValue,
          publishedAt: now,
        },
      });

      // Step 6 — Optional initial site + default workflow buckets.
      //
      // Done in the SAME tx as the org/role/policy inserts. If
      // bucket provisioning fails, the entire org create rolls
      // back; we never leave a half-bootstrapped tenant where
      // CreateOrder would explode on `bucket not found`.
      let initialSiteId: string | undefined;
      let bucketProvisioning:
        | {
            readonly siteCode: string;
            readonly siteId: string;
            readonly created: number;
            readonly alreadyPresent: number;
            readonly bucketIdsByCode: Readonly<Record<DefaultBucketCode, string>>;
          }
        | undefined;

      if (input.initialSite !== undefined) {
        const siteRow = await tx.pharmacySite.create({
          data: {
            organizationId,
            code: input.initialSite.code,
            name: input.initialSite.name,
            timezone: input.initialSite.timezone ?? "UTC",
            status: SiteStatus.ACTIVE,
          },
          select: { id: true },
        });
        initialSiteId = siteRow.id;

        const provisioned = await provisionDefaultBucketsForSite(tx, {
          organizationId,
          siteId: siteRow.id,
        });

        // Defense-in-depth: every canonical code must be present.
        // The helper already asserts this, but verifying again at
        // the call site means a future refactor of the helper
        // can't silently weaken the contract for org bootstrap.
        for (const code of DEFAULT_BUCKET_CODES) {
          if (provisioned.bucketIdsByCode[code] === undefined) {
            throw new errors.InternalError({
              code: "ORG_BOOTSTRAP_BUCKET_MISSING",
              message: `Initial-site bucket provisioning did not produce id for canonical bucket "${code}".`,
              metadata: { code, siteId: siteRow.id, organizationId },
            });
          }
        }

        bucketProvisioning = {
          siteCode: input.initialSite.code,
          siteId: siteRow.id,
          created: provisioned.created,
          alreadyPresent: provisioned.alreadyPresent,
          bucketIdsByCode: provisioned.bucketIdsByCode,
        };
      }

      const outboxEvents: Array<{
        readonly eventType: string;
        readonly aggregateType: string;
        readonly aggregateId: string;
        readonly payload: Record<string, unknown>;
      }> = [
        {
          eventType: "organization.created.v1",
          aggregateType: "Organization",
          aggregateId: organizationId,
          payload: {
            organizationId,
            slug: input.slug,
            name: input.name,
            adminUserId: user.id,
            initialSiteId: initialSiteId ?? null,
            occurredAt: now.toISOString(),
          },
        },
      ];
      if (bucketProvisioning !== undefined) {
        outboxEvents.push({
          eventType: "org.buckets.provisioned.v1",
          aggregateType: "PharmacySite",
          aggregateId: bucketProvisioning.siteId,
          payload: {
            organizationId,
            siteId: bucketProvisioning.siteId,
            created: bucketProvisioning.created,
            alreadyPresent: bucketProvisioning.alreadyPresent,
            occurredAt: now.toISOString(),
          },
        });
      }

      const output: CreateOrganizationOutput = {
        organizationId,
        adminUserId: user.id,
        roleCount,
        ...(initialSiteId !== undefined ? { initialSiteId } : {}),
        ...(bucketProvisioning !== undefined
          ? { initialBucketIdsByCode: bucketProvisioning.bucketIdsByCode }
          : {}),
      };

      return {
        output,
        targetOrganizationId: organizationId,
        audit: {
          action: "organization.created",
          resourceType: "Organization",
          resourceId: organizationId,
          metadata: {
            slug: input.slug,
            adminUserId: user.id,
            roleCount,
            commandLogId,
            // PHI-safe site/bucket bootstrap metadata. We
            // intentionally do NOT include the per-bucket id
            // map here — that's high-cardinality and uninteresting
            // to ops; the outbox event payload carries the counts,
            // and the bucket-id map is in the command output for
            // the caller to use directly.
            initialSite:
              bucketProvisioning !== undefined
                ? {
                    siteId: bucketProvisioning.siteId,
                    siteCode: bucketProvisioning.siteCode,
                    bucketsCreated: bucketProvisioning.created,
                    bucketsAlreadyPresent: bucketProvisioning.alreadyPresent,
                  }
                : null,
          },
        },
        outboxEvents,
      };
    },
  };
