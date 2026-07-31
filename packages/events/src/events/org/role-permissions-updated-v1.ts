// org.role.permissions_updated.v1 — a custom role's permission set
// was changed.
//
// Producer: `UpdateRolePermissions` (`@pharmax/orgs`).
// Consumers: SOC 2 access-review report (a permission-set change
//   silently changes the effective access of EVERY holder of the
//   role — reviewers need the diff, not just the end state); RBAC
//   cache invalidation.
//
// PHI: none. Role identifiers + permission codes only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    roleId: z.uuid(),
    code: z.string().min(1).max(64),
    /** Permission codes granted by this change. */
    addedPermissions: z.array(z.string().min(1).max(128)).max(200),
    /** Permission codes revoked by this change. */
    removedPermissions: z.array(z.string().min(1).max(128)).max(200),
    /** Size of the role's permission set AFTER the change. */
    permissionCount: z.number().int().nonnegative(),
    /** How many users held the role when the change landed. */
    affectedUserCount: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgRolePermissionsUpdatedV1 = defineEvent({
  name: "org.role.permissions_updated",
  version: 1,
  aggregateType: "Role",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.roleId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by UpdateRolePermissions after a custom role's permission grants change. Carries the added/removed diff because the change alters the effective access of every current holder of the role.",
});

export type OrgRolePermissionsUpdatedV1Payload = z.infer<typeof payloadSchema>;
