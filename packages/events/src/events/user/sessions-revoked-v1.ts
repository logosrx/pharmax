// user.sessions_revoked.v1 — an operator revoked their sessions.
//
// Producer: `RevokeSessions` command (`@pharmax/auth`).
// `scope: "others"` keeps the current session; `"all"` is a full
// sign-out on every device.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    scope: z.enum(["all", "others"]),
    revoked: z.number().int().min(0),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserSessionsRevokedV1 = defineEvent({
  name: "user.sessions_revoked",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by RevokeSessions with the scope and the number of sessions dropped. Ids + counts only.",
});

export type UserSessionsRevokedV1Payload = z.infer<typeof payloadSchema>;
