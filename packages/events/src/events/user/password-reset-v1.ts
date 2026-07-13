// user.password_reset.v1 — a password was reset via a reset token.
//
// Producer: `ResetPassword` command (`@pharmax/auth`). All sessions
// are revoked in the same transaction.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    sessionsRevoked: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserPasswordResetV1 = defineEvent({
  name: "user.password_reset",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by ResetPassword after a valid reset token rotates the hash and revokes every session. Ids + counts only.",
});

export type UserPasswordResetV1Payload = z.infer<typeof payloadSchema>;
