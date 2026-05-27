// org.user_role.revoked.v1 — a role grant was removed from a user.
//
// Producer: `RevokeUserRole` (`@pharmax/orgs`).
// Consumers: SOC 2 access-review report; RBAC cache invalidation;
//   access-revocation audit feed.
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
    roleCode: z.string().min(1).max(64),
    roleScope: z.enum(ROLE_SCOPES),
    /**
     * Scope of the revoked grant. Mirrors the shape of
     * `org.user_role.granted.v1` so consumers can subscribe to
     * both events under a single union projector.
     */
    siteId: z.uuid().nullable(),
    clinicId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgUserRoleRevokedV1 = defineEvent({
  name: "org.user_role.revoked",
  version: 1,
  aggregateType: "UserRole",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.access",
  description:
    "Emitted by RevokeUserRole after a UserRole grant is deleted. Anchors the SOC 2 access-revocation report and triggers RBAC cache invalidation.",
});

export type OrgUserRoleRevokedV1Payload = z.infer<typeof payloadSchema>;
