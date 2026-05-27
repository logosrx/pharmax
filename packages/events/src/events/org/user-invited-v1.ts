// org.user.invited.v1 — operator invited a new user into the org.
//
// Producer: `InviteUser` (`@pharmax/orgs`).
// Consumers: invitation-email handler (future); SOC 2 access-grant
//   audit feed.
//
// PHI: none — email and display name are operator identity, not
// patient data. Email IS classified as confidential for spam /
// phishing risk; it stays in the payload because the invitation
// handler needs it. Downstream consumers must treat the payload
// as need-to-know.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    /**
     * Operator email. Lower-cased and validated at the command
     * boundary; the unique constraint on `(organizationId, email)`
     * is the structural anti-duplicate guarantee.
     */
    email: z.string().email().max(254),
    displayName: z.string().min(1).max(200),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrgUserInvitedV1 = defineEvent({
  name: "org.user.invited",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "orgs",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.user",
  description:
    "Emitted by InviteUser after a User row in INVITED status is created. Drives the invitation-email handler and seeds the SOC 2 access-grant audit feed.",
});

export type OrgUserInvitedV1Payload = z.infer<typeof payloadSchema>;
