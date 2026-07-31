// CreateRole — admin "mint a custom privilege set" path.
//
// Creates an org-local, NON-system role (`isSystem: false`) plus its
// `RolePermission` grants in one transaction. Positions (the system
// role templates cloned at CreateOrganization time) stay
// template-managed; this command exists for the "custom" half of the
// privilege model — e.g. a `NightShiftLead` that combines typing +
// fill + shipping-release without the full technician set.
//
// Permission-code validation is two-layered:
//   1. `isPermissionCode` against the typed registry — rejects codes
//      the platform doesn't recognize (typos, stale admin UI).
//   2. A `permission` table lookup — rejects registry/seed drift
//      (a recognized code whose row was never seeded), which would
//      otherwise fail the FK on the grant insert with an opaque error.
//
// Escalation note: an actor holding `roles.manage` can already grant
// the OrgAdmin role, so restricting WHICH codes a custom role may
// carry adds no security boundary — the boundary is `roles.manage`
// itself (MFA-floored at the route).
//
// Idempotency:
//   - DB unique constraint on `(organizationId, code)` rejects a
//     duplicate role code; we catch P2002 and surface
//     `ROLE_CODE_ALREADY_EXISTS` so a re-submitted form reads as a
//     conflict, not a crash.
//
// Permission: `roles.manage` (ORGANIZATION scope).
//
// PHI: none. Role identifiers + permission codes only.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma, RoleScope } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { isPermissionCode, PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const CREATE_ROLE_CODE_ALREADY_EXISTS = "CREATE_ROLE_CODE_ALREADY_EXISTS";
export const CREATE_ROLE_UNKNOWN_PERMISSION = "CREATE_ROLE_UNKNOWN_PERMISSION";
export const CREATE_ROLE_PERMISSION_NOT_SEEDED = "CREATE_ROLE_PERMISSION_NOT_SEEDED";

const inputSchema = z
  .object({
    /** Org-unique role identifier, PascalCase-ish (e.g. `NightShiftLead`). */
    code: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z][A-Za-z0-9_-]{1,63}$/,
        "code must start with a letter and contain only letters, digits, `_`, or `-` (2-64 chars)"
      ),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    scope: z.enum(RoleScope),
    /**
     * Initial permission-code set. MAY be empty — a blank custom role
     * is a valid draft the admin fills in via UpdateRolePermissions.
     */
    permissions: z.array(z.string().trim().min(1).max(128)).max(200),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof inputSchema>;

export interface CreateRoleOutput {
  readonly roleId: string;
  readonly code: string;
  readonly name: string;
  readonly scope: RoleScope;
  readonly permissionCount: number;
}

export const CreateRole: Command<CreateRoleInput, CreateRoleOutput> = {
  name: "CreateRole",
  inputSchema,
  permission: PERMISSIONS.ROLES_MANAGE,
  redactFields: [],

  async handle({ input, ctx, tx, commandLogId }): Promise<HandlerResult<CreateRoleOutput>> {
    // Registry validation + dedupe. Order is preserved for the audit
    // payload but is otherwise meaningless.
    const codes = [...new Set(input.permissions)];
    const unknown = codes.filter((c) => !isPermissionCode(c));
    if (unknown.length > 0) {
      throw new errors.ValidationError({
        code: CREATE_ROLE_UNKNOWN_PERMISSION,
        message: `Unrecognized permission code(s): ${unknown.join(", ")}.`,
        metadata: { unknown },
      });
    }

    // Seed-drift validation: every recognized code must have a
    // `permission` row (the FK target of the grant insert).
    const permissionRows =
      codes.length > 0
        ? await tx.permission.findMany({
            where: { code: { in: codes } },
            select: { id: true, code: true },
          })
        : [];
    if (permissionRows.length !== codes.length) {
      const seeded = new Set(permissionRows.map((r) => r.code));
      const missing = codes.filter((c) => !seeded.has(c));
      throw new errors.InternalError({
        code: CREATE_ROLE_PERMISSION_NOT_SEEDED,
        message: `Permission code(s) recognized by the registry but missing from the database: ${missing.join(", ")}. Run the seed.`,
        metadata: { missing },
      });
    }

    let roleId: string;
    try {
      const created = await tx.role.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          scope: input.scope,
          isSystem: false,
        },
        select: { id: true },
      });
      roleId = created.id;
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new errors.ConflictError({
          code: CREATE_ROLE_CODE_ALREADY_EXISTS,
          message: `A role with code "${input.code}" already exists in this organization.`,
          metadata: { code: input.code },
          cause,
        });
      }
      throw cause;
    }

    if (permissionRows.length > 0) {
      await tx.rolePermission.createMany({
        data: permissionRows.map((p) => ({ roleId, permissionId: p.id })),
      });
    }

    return {
      output: Object.freeze({
        roleId,
        code: input.code,
        name: input.name,
        scope: input.scope,
        permissionCount: permissionRows.length,
      }),
      audit: {
        action: "org.role.created",
        resourceType: "Role",
        resourceId: roleId,
        metadata: {
          code: input.code,
          name: input.name,
          scope: input.scope,
          permissionCodes: codes,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.role.created.v1",
          aggregateType: "Role",
          aggregateId: roleId,
          payload: {
            organizationId: ctx.organizationId,
            roleId,
            code: input.code,
            name: input.name,
            scope: input.scope,
            permissionCodes: codes,
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    };
  },
};
