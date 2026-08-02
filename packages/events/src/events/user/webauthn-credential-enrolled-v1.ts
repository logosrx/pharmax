// user.webauthn.credential_enrolled.v1 — an authenticator's
// attestation verified and the credential is now an active second
// factor.
//
// Producer: `ConfirmWebAuthnCredential` command (`@pharmax/auth`,
// ADR-0036). Ids + AAGUID only — the public key stays on the row.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    userId: z.uuid(),
    credentialRowId: z.uuid(),
    /** Authenticator model id from attestation; null under "none". */
    aaguid: z.string().nullable(),
    /** True when this was the account's first authenticator of any kind. */
    firstAuthenticator: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const UserWebAuthnCredentialEnrolledV1 = defineEvent({
  name: "user.webauthn.credential_enrolled",
  version: 1,
  aggregateType: "User",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.userId,
  owner: "auth",
  retention: "7y",
  phiSafe: true,
  routingKey: "user.auth",
  description:
    "Emitted by ConfirmWebAuthnCredential when a security key / passkey attestation verifies and the credential becomes active.",
});

export type UserWebAuthnCredentialEnrolledV1Payload = z.infer<typeof payloadSchema>;
