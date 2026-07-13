// user.deactivated.v1 — an admin suspended or terminated a user.
//
// Producer: `DeactivateUser` command (`@pharmax/auth`). Every
// active session for the target is revoked in the same
// transaction; the count rides on the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    targetUserId: z.uuid(),
    status: z.enum(["SUSPENDED", "TERMINATED"]),
    sessionsRevoked: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserDeactivatedV1 = defineEvent({
  name: "user.deactivated",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.targetUserId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by DeactivateUser after the status flips and the target's sessions are revoked. Ids + status + counts only.",
});

export type UserDeactivatedV1Payload = z.infer<typeof payloadSchema>;
