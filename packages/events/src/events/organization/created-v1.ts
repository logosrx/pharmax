// organization.created.v1 — a new tenant organization was created.
//
// Producer: `CreateOrganization` system command (`@pharmax/orgs`).
// Consumers: outbox handler `handleOrganizationCreatedV1` in
//   `apps/worker/src/drains/outbox-handlers.ts` (today: logs only;
//   Phase 2+ will fan out admin invitation email, billing-provider
//   registration, etc.).
//
// PHI: the producer admin's name + email are deliberately NOT in
// this payload. Only ids and the non-PHI org slug + display name.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    slug: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    adminUserId: z.uuid(),
    initialSiteId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrganizationCreatedV1 = defineEvent({
  name: "organization.created",
  version: 1,
  aggregateType: "Organization",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.organizationId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.lifecycle",
  description:
    "Emitted by CreateOrganization after the org, system roles, admin user, and v1 workflow policy are persisted. Drives invitation email + downstream tenant provisioning.",
});

export type OrganizationCreatedV1Payload = z.infer<typeof payloadSchema>;
