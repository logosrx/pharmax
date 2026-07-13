// user.mfa.enrolled.v1 — a TOTP enrollment was verified and is now
// active.
//
// Producer: `ConfirmMfa` command (`@pharmax/auth`).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    enrollmentId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserMfaEnrolledV1 = defineEvent({
  name: "user.mfa.enrolled",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by ConfirmMfa when the first valid TOTP code verifies a pending enrollment. Ids only.",
});

export type UserMfaEnrolledV1Payload = z.infer<typeof payloadSchema>;
