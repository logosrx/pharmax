// user.invite_issued.v1 — an invite token was issued for a user.
//
// Producer: `IssueInvite` command (`@pharmax/auth`). The invite
// token NEVER rides on the payload — ids only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserInviteIssuedV1 = defineEvent({
  name: "user.invite_issued",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by IssueInvite when an invite token row is created for an INVITED user. Ids only — the token material never leaves the row.",
});

export type UserInviteIssuedV1Payload = z.infer<typeof payloadSchema>;
