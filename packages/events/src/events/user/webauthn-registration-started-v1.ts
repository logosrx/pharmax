// user.webauthn.registration_started.v1 — a WebAuthn registration
// ceremony began (single-use challenge minted, nothing stored yet).
//
// Producer: `EnrollWebAuthnCredential` command (`@pharmax/auth`,
// ADR-0036). Ids only — the challenge never rides on the payload.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    challengeId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserWebAuthnRegistrationStartedV1 = defineEvent({
  name: "user.webauthn.registration_started",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by EnrollWebAuthnCredential when a registration ceremony challenge is minted. Ids only.",
});

export type UserWebAuthnRegistrationStartedV1Payload = z.infer<typeof payloadSchema>;
