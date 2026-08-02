// user.webauthn.authentication_started.v1 — a password-verified user
// requested a WebAuthn assertion challenge at sign-in.
//
// Producer: `StartWebAuthnAuthentication` system command
// (`@pharmax/auth`, ADR-0036). The completed sign-in itself still
// emits `user.signed_in.v1` — this event exists so an authentication
// ceremony that STARTS but never completes is visible to the
// security digest.

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

export const UserWebAuthnAuthenticationStartedV1 = defineEvent({
  name: "user.webauthn.authentication_started",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by StartWebAuthnAuthentication when an assertion challenge is minted after first-factor verification.",
});

export type UserWebAuthnAuthenticationStartedV1Payload = z.infer<typeof payloadSchema>;
