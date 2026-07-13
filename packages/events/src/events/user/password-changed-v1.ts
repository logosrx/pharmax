// user.password_changed.v1 — an operator changed their own password.
//
// Producer: `ChangePassword` command (`@pharmax/auth`). Other
// sessions are revoked in the same transaction; the count rides on
// the payload so the security feed can flag surprising values.

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

export const UserPasswordChangedV1 = defineEvent({
  name: "user.password_changed",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by ChangePassword after the hash is rotated and sibling sessions are revoked. Ids + counts only.",
});

export type UserPasswordChangedV1Payload = z.infer<typeof payloadSchema>;
