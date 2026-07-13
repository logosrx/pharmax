// user.invite_accepted.v1 — an invited user completed onboarding.
//
// Producer: `AcceptInvite` command (`@pharmax/auth`).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserInviteAcceptedV1 = defineEvent({
  name: "user.invite_accepted",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by AcceptInvite when the invited user sets a password and activates. Ids only.",
});

export type UserInviteAcceptedV1Payload = z.infer<typeof payloadSchema>;
