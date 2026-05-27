// org.user_role.granted.v1 — a role grant was added to a user.
//
// Producer: `AssignRole` (`@pharmax/orgs`).
// Consumers: SOC 2 access-review report; future RBAC cache
//   invalidation; access-grant notification.
//
// PHI: none. Ids + role code + scope only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const ROLE_SCOPES = ["ORGANIZATION", "SITE", "CLINIC", "TEAM"] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    roleId: z.uuid(),
    /**
     * Role identifier (e.g. `Pharmacist`, `PharmacyTechnician`).
     * Carried in the payload so audit consumers don't need to
     * dereference the role row to render the grant.
     */
    roleCode: z.string().min(1).max(64),
    roleScope: z.enum(ROLE_SCOPES),
    /**
     * Site scope target — `null` when the role is org-wide or
     * scoped to clinic/team only.
     */
    siteId: z.uuid().nullable(),
    clinicId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgUserRoleGrantedV1 = defineEvent({
  name: "org.user_role.granted",
  version: 1,
  aggregateType: "UserRole",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by AssignRole after a new UserRole row is persisted. Anchors the SOC 2 access-review report and triggers RBAC cache invalidation.",
});

export type OrgUserRoleGrantedV1Payload = z.infer<typeof payloadSchema>;
