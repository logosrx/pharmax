// org.role.created.v1 — a custom role was created in an organization.
//
// Producer: `CreateRole` (`@pharmax/orgs`).
// Consumers: SOC 2 access-review report (the role vocabulary an org
//   can grant is itself review evidence); admin activity feed.
//
// PHI: none. Role identifiers + permission codes only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ROLE_SCOPES = ["ORGANIZATION", "SITE", "CLINIC", "TEAM"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    roleId: z.uuid(),
    /** Role identifier unique within the org (e.g. `NightShiftLead`). */
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    scope: z.enum(ROLE_SCOPES),
    /**
     * The full permission-code set the role was created with.
     * Carried in the payload so access-review consumers don't need
     * to dereference role_permission rows as of a past timestamp.
     */
    permissionCodes: z.array(z.string().min(1).max(128)).max(200),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgRoleCreatedV1 = defineEvent({
  name: "org.role.created",
  version: 1,
  aggregateType: "Role",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.roleId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by CreateRole after a custom (non-system) role row and its permission grants are persisted. Anchors the SOC 2 access-review trail for org-local privilege sets.",
});

export type OrgRoleCreatedV1Payload = z.infer<typeof payloadSchema>;
