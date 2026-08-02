// EnrollWebAuthnCredential — begin security-key/passkey registration
// (self-service, ADR-0036 slice 1).
//
// Mints a single-use REGISTRATION challenge and returns the browser
// creation options. Unlike TOTP (one authenticator per account),
// multiple WebAuthn credentials are allowed — `excludeCredentials`
// stops the same physical key from registering twice. Nothing is
// stored about the authenticator until `ConfirmWebAuthnCredential`
// verifies the attestation.
//
// The relying-party id comes from the WEB TIER's trusted host
// resolution (same source that picked the organization) — never from
// the browser.
//
// PHI: none. The options embed the challenge, so they are on the
// redaction allowlist.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { WebAuthnCeremony } from "@pharmax/database";
import { z } from "zod";

import { getAuthConfiguration } from "../configure.js";
import { mintWebAuthnChallenge } from "../mfa/webauthn-challenge.js";
import type { WebAuthnOptionsJSON } from "../mfa/webauthn.js";

const inputSchema = z
  .object({
    /** Relying-party id (the sign-in hostname), resolved by the web tier. */
    rpId: z.string().min(1).max(253),
  })
  .strict();

export type EnrollWebAuthnCredentialInput = z.infer<typeof inputSchema>;

export interface EnrollWebAuthnCredentialOutput {
  readonly challengeId: string;
  /** PublicKeyCredentialCreationOptions JSON for the browser ceremony. */
  readonly optionsJSON: WebAuthnOptionsJSON;
}

export const EnrollWebAuthnCredential: Command<
  EnrollWebAuthnCredentialInput,
  EnrollWebAuthnCredentialOutput
> = {
  name: "EnrollWebAuthnCredential",
  inputSchema,
  permission: null,
  redactFields: ["optionsJSON"],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<EnrollWebAuthnCredentialOutput>> {
    const config = getAuthConfiguration();
    const userId = ctx.actor.userId;
    const now = clock.now();

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, displayName: true },
    });

    const existing = await tx.webAuthnCredential.findMany({
      where: { userId, disabledAt: null },
      select: { credentialId: true },
    });

    const generated = await config.webauthn.adapter.generateRegistrationOptions({
      rpId: input.rpId,
      rpName: config.webauthn.rpName,
      userId,
      userEmail: user.email,
      userDisplayName: user.displayName,
      excludeCredentialIds: existing.map((c) => c.credentialId),
    });

    const { challengeId } = await mintWebAuthnChallenge({
      tx,
      organizationId: ctx.organizationId,
      userId,
      purpose: WebAuthnCeremony.REGISTRATION,
      challenge: generated.challenge,
      now,
      ttlMs: config.webauthn.challengeTtlMs,
    });

    return {
      output: Object.freeze({ challengeId, optionsJSON: generated.optionsJSON }),
      audit: {
        action: "user.webauthn.registration_started",
        resourceType: "User",
        resourceId: userId,
        metadata: { userId, challengeId, commandLogId },
      },
      outboxEvents: [
        {
          eventType: "user.webauthn.registration_started.v1",
          aggregateType: "User",
          aggregateId: userId,
          payload: {
            organizationId: ctx.organizationId,
            userId,
            challengeId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
