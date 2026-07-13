// user.signed_in.v1 — an operator completed sign-in.
//
// Producer: `SignIn` command (`@pharmax/auth`).
// Consumers: none yet (security feed + login-anomaly scouts will
//   subscribe).
//
// PHI invariant: ids + a boolean only — never the email attempted,
// never credentials.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    userId: z.uuid(),
    organizationId: z.uuid(),
    sessionId: z.uuid(),
    mfaUsed: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserSignedInV1 = defineEvent({
  name: "user.signed_in",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by SignIn after a session row is persisted. Carries user/session ids and whether MFA was used — never the credential material.",
});

export type UserSignedInV1Payload = z.infer<typeof payloadSchema>;
