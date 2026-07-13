// user.password_reset_requested.v1 — a reset token was issued.
//
// Producer: `IssuePasswordReset` command (`@pharmax/auth`). The
// token itself NEVER rides on the payload — only ids, so a
// downstream mailer must resolve the token hash via a tenancy-
// scoped read path that proves possession.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserPasswordResetRequestedV1 = defineEvent({
  name: "user.password_reset_requested",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by IssuePasswordReset when a reset token row is created. Ids only — the token material never leaves the row.",
});

export type UserPasswordResetRequestedV1Payload = z.infer<typeof payloadSchema>;
