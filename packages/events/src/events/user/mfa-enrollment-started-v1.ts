// user.mfa.enrollment_started.v1 — a TOTP enrollment was created
// (secret provisioned, not yet verified).
//
// Producer: `EnrollMfa` command (`@pharmax/auth`). The TOTP secret
// NEVER rides on the payload; it lives KMS-wrapped on the
// enrollment row.

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

export const UserMfaEnrollmentStartedV1 = defineEvent({
  name: "user.mfa.enrollment_started",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by EnrollMfa when a pending TOTP enrollment row is created. Ids only — the secret stays KMS-wrapped on the row.",
});

export type UserMfaEnrollmentStartedV1Payload = z.infer<typeof payloadSchema>;
